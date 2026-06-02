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
 *   - intentional placeholder adapters that fail closed with a structured
 *     upstream-deprecated message instead of pretending coverage exists.
 *
 * Network failures against real endpoints count as probe failures. To park
 * a flaky adapter, add `quarantine: true` to its YAML.
 */

import { loadAllAdapters, loadTsAdapters } from "../src/discovery/loader.js";
import {
  commandStrategy,
  commandUsesBrowser,
  getAllAdapters,
} from "../src/registry.js";
import { runPipeline } from "../src/engine/executor.js";
import {
  detectFails,
  healthProbeArgs,
  isProbeEnvironmentMissing,
  manualHealthReason,
  platformCapabilityMismatch,
  withTimeout,
} from "./adapter-health-shared.js";

interface ProbeResult {
  site: string;
  command: string;
  status: "ok" | "fail" | "skip";
  reason?: string;
  latency_ms: number;
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

      if (commandUsesBrowser(adapter, cmd)) {
        results.push({
          site: adapter.name,
          command: cmdName,
          status: "skip",
          reason: "requires browser",
          latency_ms: 0,
        });
        continue;
      }

      const manualReason = manualHealthReason(adapter.name, cmdName);
      if (manualReason) {
        results.push({
          site: adapter.name,
          command: cmdName,
          status: "skip",
          reason: manualReason,
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
          runPipeline(
            cmd.pipeline,
            { args: healthProbeArgs(cmd), source: "internal" },
            adapter.base,
            {
              site: adapter.name,
              strategy: commandStrategy(adapter, cmd),
            },
          ),
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
        const envReason = isProbeEnvironmentMissing(err, message);
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
