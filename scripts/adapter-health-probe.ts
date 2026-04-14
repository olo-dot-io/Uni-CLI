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
 *
 * Network failures count as probe failures. To park a flaky adapter, add
 * `quarantine: true` to its YAML — see `docs/ADAPTER-HEALTH.md` (TODO).
 */

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

      const requiredArgs = (cmd.adapterArgs ?? []).filter(
        (a) => a.required && a.positional,
      );
      if (requiredArgs.length > 0) {
        results.push({
          site: adapter.name,
          command: cmdName,
          status: "skip",
          reason: `requires args: ${requiredArgs.map((a) => a.name).join(", ")}`,
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

  const ok = results.filter((r) => r.status === "ok").length;
  const fail = results.filter((r) => r.status === "fail").length;
  const skip = results.filter((r) => r.status === "skip").length;

  const summary = {
    ok,
    fail,
    skip,
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
}

main().catch((err) => {
  console.error("adapter-health-probe: fatal:", err);
  process.exit(1);
});
