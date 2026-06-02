/**
 * @owner   scripts/adapter-health-shared.ts
 * @does    Share health-gate classifiers and bounded probe helpers across operator-facing adapter/site sweeps.
 * @needs   node:child_process, src/engine/executor.ts, src/types.ts
 * @feeds   scripts/adapter-health-probe.ts, scripts/site-availability-sweep.ts
 * @breaks  Misclassifying host/auth/platform limits as adapter regressions makes health gates noisy; over-broad downgrades hide real adapter drift.
 * @invariants Only narrow, evidence-bearing environment patterns are downgraded; HTTP 404/parse/selector drift still fails probes.
 * @side-effects detectFails executes adapter-declared shell detect probes with stdio suppressed and a 2s timeout.
 * @perf    O(1) classifiers; detect probes are bounded at 2s.
 * @concurrency Stateless.
 * @test    tests/unit/site-availability-sweep.test.ts
 * @stability operator-facing verification helper.
 * @since   2026-06-02
 */

import { execSync } from "node:child_process";
import { PipelineError } from "../src/engine/executor.js";
import type { AdapterCommand } from "../src/types.js";

const MACOS_MANUAL_HEALTH_COMMANDS = new Set([
  "caffeinate",
  "calendar-create",
  "empty-trash",
  "finder-copy",
  "finder-move",
  "finder-new-folder",
  "lock-screen",
  "mail-send",
  "messages-send",
  "music-control",
  "notification",
  "notify",
  "open",
  "open-app",
  "reminder-create",
  "reminders-complete",
  "say",
  "screen-lock",
  "screen-recording",
  "screenshot",
  "shortcuts-run",
  "sleep",
  "wallpaper",
]);

/**
 * Honour the adapter's own one-line host capability gate before invoking a
 * command. A failing detect probe is a host-state deferral, not an adapter
 * regression.
 */
export function detectFails(detect: string | undefined): string | undefined {
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
 * Schema-v2 capability gate. Desktop transports are platform-specific and
 * should be skipped before they produce noisy runtime failures.
 */
export function platformCapabilityMismatch(
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

export function manualHealthReason(
  site: string,
  command: string,
): string | undefined {
  if (site === "macos" && MACOS_MANUAL_HEALTH_COMMANDS.has(command)) {
    return "manual health: host-mutating macOS command";
  }
  return undefined;
}

/**
 * Post-hoc classifier that separates adapter regressions from host/environment
 * limits. Patterns are intentionally narrow so true 404/selector/parser drift
 * remains a failure.
 */
export function isEnvironmentMissing(message: string): string | undefined {
  const spawnEnoent = message.match(/spawn ([^\s]+) ENOENT/);
  if (spawnEnoent) {
    return `missing binary: ${spawnEnoent[1]}`;
  }
  if (/no transport for step \S+ on platform /i.test(message)) {
    return "platform-gated step (wrong OS)";
  }
  if (/blocked fetch to reserved\/local address/i.test(message)) {
    return "loopback/private target (SSRF guard)";
  }
  if (
    /failed to connect to the docker API|Cannot connect to the Docker daemon/i.test(
      message,
    )
  ) {
    return "local daemon not running (docker)";
  }
  if (/No cookies found for/i.test(message)) {
    return "missing cookies (auth)";
  }
  if (
    /Failed to load cookies for .*cdp_unavailable|Could not connect to Chrome on CDP port/i.test(
      message,
    )
  ) {
    return "missing browser cookie source (cdp unavailable)";
  }
  if (
    /HTTP 40[13] /i.test(message) ||
    /authentication required/i.test(message)
  ) {
    return "auth required (HTTP 401/403)";
  }
  if (/PATENT_API_DEPRECATED/i.test(message)) {
    return "upstream API deprecated (intentional placeholder)";
  }
  if (/osascript|AppleScript|caffeinate|“Finder”|"Finder"/i.test(message)) {
    return "darwin-only (osascript / AppleScript)";
  }
  if (/\/Library\/Application Support|\/Users\/[^/]+\/Library/i.test(message)) {
    return "darwin-only filesystem path";
  }
  if (
    /NoCredentials|Unable to locate credentials|gcloud auth login|az login|azure.*login required/i.test(
      message,
    )
  ) {
    return "cloud CLI not authenticated";
  }
  if (
    /Access token not provided|SUPABASE_ACCESS_TOKEN|supabase login/i.test(
      message,
    )
  ) {
    return "cloud CLI not authenticated";
  }
  if (
    /unable to open database .*\/Library\/Safari\/History\.db|Full Disk Access|Operation not permitted/i.test(
      message,
    )
  ) {
    return "darwin protected app data";
  }
  if (/Step \d+ \(websocket\) failed/i.test(message)) {
    return "local daemon not running (websocket)";
  }
  if (/HTTP 429/i.test(message)) {
    return "upstream rate-limited (HTTP 429)";
  }
  if (/HTTP 5\d\d/i.test(message)) {
    return "upstream transient (HTTP 5xx)";
  }
  if (/timed out after \d+\s*ms/i.test(message)) {
    return "probe timeout (transient)";
  }
  if (/Step \d+ \(fetch(_text)?\) failed: fetch failed/i.test(message)) {
    return "probe network unreachable (transient)";
  }
  if (/\bfetch_text failed for https?:\/\/\S+: fetch failed/i.test(message)) {
    return "probe network unreachable (transient)";
  }
  if (/not installed|not found.*install|requires .*cli/i.test(message)) {
    return "required binary not installed";
  }
  return undefined;
}

export function isProbeEnvironmentMissing(
  error: unknown,
  message: string,
): string | undefined {
  if (error instanceof PipelineError) {
    const preview = error.detail.responsePreview ?? "";
    if (
      error.detail.statusCode !== undefined &&
      error.detail.statusCode >= 400 &&
      error.detail.statusCode < 500 &&
      /login_required|authentication|required|not authenticated|用户不存在/i.test(
        preview,
      )
    ) {
      return `auth required (HTTP ${error.detail.statusCode})`;
    }
  }
  return isEnvironmentMissing(message);
}

export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
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

export function healthProbeArgs(cmd: AdapterCommand): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const arg of cmd.adapterArgs ?? []) {
    if (arg.default !== undefined) args[arg.name] = arg.default;
  }
  const limitArg = (cmd.adapterArgs ?? []).find((arg) => arg.name === "limit");
  if (limitArg) {
    args.limit = limitArg.type === "int" || limitArg.type === "float" ? 1 : "1";
  }
  return args;
}
