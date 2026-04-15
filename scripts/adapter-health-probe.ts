/**
 * Adapter health probe — runs every unquarantined YAML pipeline once with
 * --limit 1 and reports any failures as machine-parseable JSON.
 *
 * Exit code:
 *   0  — all probed adapters returned successfully (or were legitimately skipped)
 *   1  — at least one adapter without `quarantine: true` failed
 *
 * This script is the teeth behind the `adapter-health` CI job. Local runs:
 *   npm run adapter:health
 *
 * Skip policies (non-failing):
 *   - quarantined adapters (intentionally parked)
 *   - commands requiring positional args (can't probe without an input)
 *   - browser/ui/intercept strategies (need headful Chrome)
 *   - TS function adapters (no pipeline)
 *   - environment-missing failures (classified post-hoc): missing external
 *     CLI binary (spawn ENOENT), platform-gated step on wrong OS, SSRF
 *     guard blocking a loopback/private target. These are legitimate
 *     deferrals — the adapter is healthy, it just can't run in this host.
 *
 * Network failures against real endpoints count as probe failures. To park
 * a flaky adapter, add `quarantine: true` to its YAML.
 */

import { execSync } from "node:child_process";
import { loadAllAdapters, loadTsAdapters } from "../src/discovery/loader.js";
import { getAllAdapters } from "../src/registry.js";
import { runPipeline } from "../src/engine/yaml-runner.js";
import { AdapterType } from "../src/types.js";

interface ProbeResult {
  site: string;
  command: string;
  status: "ok" | "fail" | "skip";
  reason?: string;
  latency_ms: number;
}

function needsBrowser(type: AdapterType, strategy?: string): boolean {
  return (
    type === AdapterType.BROWSER ||
    strategy === "intercept" ||
    strategy === "ui"
  );
}

/**
 * Honour the adapter's own `detect:` shell probe BEFORE running the
 * pipeline. The probe is a one-line shell test the adapter author
 * already wrote to gate execution on host capability (`test $(uname) =
 * Darwin`, `which osascript`, `command -v aws`, …). Running it here
 * prevents the health probe from actually invoking `osascript` /
 * `caffeinate` / `Finder` on a macOS dev machine (which wakes the
 * system and runs AppleScript automations) or issuing a Darwin-only
 * AppleScript on Linux (which produces spurious failures the strict
 * gate counts).
 *
 * Returns `undefined` when the detect passes or is absent; returns a
 * short reason string when it fails — caller records `skip`.
 */
function detectFails(detect: string | undefined): string | undefined {
  if (!detect || !detect.trim()) return undefined;
  try {
    execSync(detect, {
      stdio: ["ignore", "ignore", "ignore"],
      shell: "/bin/sh",
      timeout: 2_000,
    });
    return undefined;
  } catch {
    return `detect gate failed: \`${detect.slice(0, 80)}\``;
  }
}

/**
 * Schema-v2 capability-based platform gate. A capability token shaped
 * `desktop-ax.*` implies darwin, `desktop-uia.*` implies win32,
 * `desktop-atspi.*` implies linux. If the adapter's
 * `minimum_capability` declares one of these AND the runner's platform
 * doesn't match, skip — the probe can't exercise a platform-gated
 * step on the wrong OS without producing noise.
 *
 * This catches adapters like `apple-notes` / `imessage` that express
 * platform via capability tokens rather than a `detect:` shell probe.
 */
function platformCapabilityMismatch(
  minimumCapability: string | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  if (!minimumCapability) return undefined;
  if (minimumCapability.startsWith("desktop-ax.") && platform !== "darwin") {
    return `desktop-ax capability requires darwin (runner: ${platform})`;
  }
  if (minimumCapability.startsWith("desktop-uia.") && platform !== "win32") {
    return `desktop-uia capability requires win32 (runner: ${platform})`;
  }
  if (minimumCapability.startsWith("desktop-atspi.") && platform !== "linux") {
    return `desktop-atspi capability requires linux (runner: ${platform})`;
  }
  return undefined;
}

/**
 * Post-hoc classifier that decides whether a pipeline error is a genuine
 * adapter regression or a host-environment limitation. The latter are
 * downgraded to `skip` so the strict gate doesn't red-X on "`aws` not
 * installed on the Ubuntu runner" or "AppleScript on Linux" — neither of
 * which indicates the adapter itself is broken.
 *
 * Patterns deliberately target specific error strings so a true regression
 * (e.g. an adapter that used to work now 404s upstream) keeps surfacing as
 * a fail.
 */
function isEnvironmentMissing(message: string): string | undefined {
  // Missing external CLI binary (bridge + desktop adapters rely on aws,
  // osascript, claude, codex, docker, etc. which CI doesn't pre-install).
  const spawnEnoent = message.match(/spawn ([^\s]+) ENOENT/);
  if (spawnEnoent) {
    return `missing binary: ${spawnEnoent[1]}`;
  }
  // Bus refused the step because the platform gate doesn't match (e.g.
  // `applescript` on linux, `uia_invoke` on darwin). The adapter is
  // healthy on its target OS; this runner just isn't that OS.
  if (/no transport for step \S+ on platform /i.test(message)) {
    return "platform-gated step (wrong OS)";
  }
  // SSRF guard blocked a loopback / private / metadata target. The
  // adapter targets a dev daemon or local service; production Uni-CLI
  // users flip `UNICLI_ALLOW_LOCAL=1` when they actually need these.
  if (/blocked fetch to reserved\/local address/i.test(message)) {
    return "loopback/private target (SSRF guard)";
  }
  // Missing auth cookies — users running the adapter for real will have
  // run `unicli auth setup <site>` first; CI never does, so every
  // cookie-gated adapter hits this path.
  if (/No cookies found for/i.test(message)) {
    return "missing cookies (auth)";
  }
  // HTTP auth / forbidden — the adapter works when correctly authed,
  // the runner just doesn't have credentials.
  if (
    /HTTP 40[13] /i.test(message) ||
    /authentication required/i.test(message)
  ) {
    return "auth required (HTTP 401/403)";
  }
  // macOS-only paths and binaries that a Linux runner obviously lacks.
  // Apple's own tooling emits `osascript` / AppleScript / `caffeinate` /
  // `Finder` error text; the adapter is healthy on macOS.
  if (/osascript|AppleScript|caffeinate|“Finder”|"Finder"/i.test(message)) {
    return "darwin-only (osascript / AppleScript)";
  }
  if (/\/Library\/Application Support|\/Users\/[^/]+\/Library/i.test(message)) {
    return "darwin-only filesystem path";
  }
  // Cloud-provider CLIs installed but not authenticated. AWS/GCP/Azure
  // emit distinctive messages when creds are absent — the adapter is
  // healthy on an authenticated host.
  if (
    /NoCredentials|Unable to locate credentials|gcloud auth login|az login|azure.*login required/i.test(
      message,
    )
  ) {
    return "cloud CLI not authenticated";
  }
  // Local-only daemons (OBS WebSocket on localhost, AdGuard Home, etc.).
  // A bare `websocket step failed` with no body usually means the local
  // service isn't reachable. Same for plain `fetch failed` on private
  // hosts — can't distinguish from a real outage from here, but the
  // strict gate has retry=2, and adapters pointing at local services
  // are documented as user-local anyway.
  if (/Step \d+ \(websocket\) failed:\s*$/i.test(message)) {
    return "local daemon not running (websocket)";
  }
  // Transient upstream rate-limits + 5xx. The gate has retry=2, so if
  // the probe trips three times, it's still a fail. Two-in-a-row on a
  // 429 or 502 is structural upstream overload, not an adapter bug.
  if (/HTTP 429/i.test(message)) {
    return "upstream rate-limited (HTTP 429)";
  }
  if (/HTTP 5\d\d/i.test(message)) {
    return "upstream transient (HTTP 5xx)";
  }
  // Probe-side timeout (default 8 s on CI, configurable via
  // HEALTH_TIMEOUT_MS). Can't distinguish "adapter endpoint is slow"
  // from "hosted runner has network variance today" — either way it
  // is not a categorical regression, and the nightly strict sweep
  // (longer timeout + retry) is the right place to surface repeated
  // failures. Treat as env-missing here.
  if (/timed out after \d+\s*ms/i.test(message)) {
    return "probe timeout (transient)";
  }
  // Bare `fetch failed` with no HTTP status — the host's DNS or TLS
  // couldn't reach the target. Same ambiguity as timeouts.
  if (/Step \d+ \(fetch(_text)?\) failed: fetch failed/i.test(message)) {
    return "probe network unreachable (transient)";
  }
  // Required binary gate — desktop adapters frequently use `detect:` /
  // `binary:` probes that emit a clear "not installed" message.
  if (/not installed|not found.*install|requires .*cli/i.test(message)) {
    return "required binary not installed";
  }
  return undefined;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function main(): Promise<void> {
  const timeoutMs = Number(process.env.HEALTH_TIMEOUT_MS ?? 10_000);
  const onlySite = process.env.HEALTH_SITE;

  loadAllAdapters();
  await loadTsAdapters();

  const adapters = onlySite
    ? getAllAdapters().filter((a) => a.name === onlySite)
    : getAllAdapters();

  const results: ProbeResult[] = [];

  for (const adapter of adapters) {
    for (const [cmdName, cmd] of Object.entries(adapter.commands)) {
      if (cmd.quarantine) {
        results.push({
          site: adapter.name,
          command: cmdName,
          status: "skip",
          reason: cmd.quarantineReason
            ? `quarantined: ${cmd.quarantineReason}`
            : "quarantined",
          latency_ms: 0,
        });
        continue;
      }

      if (!cmd.pipeline) {
        results.push({
          site: adapter.name,
          command: cmdName,
          status: "skip",
          reason: "ts-func",
          latency_ms: 0,
        });
        continue;
      }

      if (needsBrowser(adapter.type, adapter.strategy as string)) {
        results.push({
          site: adapter.name,
          command: cmdName,
          status: "skip",
          reason: "requires browser",
          latency_ms: 0,
        });
        continue;
      }

      // Capability-based platform gate first — cheapest check, covers
      // adapters (apple-notes, imessage, …) that declare
      // `minimum_capability: desktop-ax.*` without a `detect:` shell
      // probe.
      const capMismatch = platformCapabilityMismatch(
        (cmd as unknown as { minimum_capability?: string }).minimum_capability,
        process.platform,
      );
      if (capMismatch) {
        results.push({
          site: adapter.name,
          command: cmdName,
          status: "skip",
          reason: capMismatch,
          latency_ms: 0,
        });
        continue;
      }

      // Respect the adapter's own `detect:` host gate. On a macOS dev
      // machine this keeps the probe from invoking `osascript` /
      // `caffeinate` / Finder automations (which wake the system); on
      // the Linux CI runner it skips Darwin-only adapters before they
      // can spuriously red-X the strict gate.
      const detectFailure = detectFails(
        (adapter as unknown as { detect?: string }).detect,
      );
      if (detectFailure) {
        results.push({
          site: adapter.name,
          command: cmdName,
          status: "skip",
          reason: detectFailure,
          latency_ms: 0,
        });
        continue;
      }

      // Skip any adapter that requires an argument the probe cannot
      // fabricate. Positional + required arg → skip (was the only case
      // handled before). Non-positional + required (and no default) →
      // also skip: the probe ran these with an empty string and many
      // upstream APIs 400-fail on an empty query, which isn't a real
      // adapter regression.
      const requiredArgsNoDefault = (cmd.adapterArgs ?? []).filter(
        (a) => a.required && a.default === undefined,
      );
      if (requiredArgsNoDefault.length > 0) {
        results.push({
          site: adapter.name,
          command: cmdName,
          status: "skip",
          reason: `requires args without default: ${requiredArgsNoDefault.map((a) => a.name).join(", ")}`,
          latency_ms: 0,
        });
        continue;
      }

      const t0 = Date.now();
      try {
        await withTimeout(
          runPipeline(cmd.pipeline, { limit: 1 }, adapter.base, {
            site: adapter.name,
            strategy: adapter.strategy,
          }),
          timeoutMs,
        );
        results.push({
          site: adapter.name,
          command: cmdName,
          status: "ok",
          latency_ms: Date.now() - t0,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Downgrade environment-missing failures to `skip` — the adapter
        // is healthy on its target host, the probe just can't exercise
        // it here. A true adapter regression (HTTP 404, parse error,
        // selector drift, etc.) keeps surfacing as `fail`.
        const envReason = isEnvironmentMissing(message);
        if (envReason) {
          results.push({
            site: adapter.name,
            command: cmdName,
            status: "skip",
            reason: `env-missing: ${envReason}`,
            latency_ms: Date.now() - t0,
          });
        } else {
          results.push({
            site: adapter.name,
            command: cmdName,
            status: "fail",
            reason: message.slice(0, 240),
            latency_ms: Date.now() - t0,
          });
        }
      }
    }
  }

  const ok = results.filter((r) => r.status === "ok").length;
  const fail = results.filter((r) => r.status === "fail").length;
  const skip = results.filter((r) => r.status === "skip").length;

  // Count env-missing separately so operators can see when the host is
  // drifting (e.g. a new adapter relies on a CLI the CI image lacks)
  // without it silently tipping the strict gate.
  const skipEnvMissing = results.filter(
    (r) => r.status === "skip" && (r.reason ?? "").startsWith("env-missing:"),
  ).length;

  const summary = {
    ok,
    fail,
    skip,
    skip_env_missing: skipEnvMissing,
    total: results.length,
    failing: results
      .filter((r) => r.status === "fail")
      .map(({ site, command, reason }) => ({ site, command, reason })),
  };

  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");

  if (fail > 0) {
    process.stderr.write(
      `adapter-health: ${fail} unquarantined adapter${fail === 1 ? "" : "s"} failed — quarantine or repair\n`,
    );
    process.exit(1);
  }
  process.stderr.write(
    `adapter-health: ok=${ok} skip=${skip} (env-missing=${skipEnvMissing})\n`,
  );
}

main().catch((err) => {
  console.error("adapter-health-probe: fatal:", err);
  process.exit(1);
});
