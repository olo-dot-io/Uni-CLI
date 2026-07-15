/**
 * @owner       src/commands/status.ts
 * @does        Emit a machine-readable health snapshot for the Browser Runtime Broker, lazy providers, adapters, and external CLIs.
 * @needs       commander, node:fs/path/url, src/browser/runtime-launch.ts, constants, hub, output
 * @feeds       the public `unicli status` command and Agent health probes
 * @breaks      Runtime probe failures are represented as explicit error state and evidence rather than silently falling back to raw CDP.
 * @invariants  Status is probe-only and never launches a broker or browser; provider secrets and cookie values are absent.
 * @side-effects Reads adapter directories, probes one owner-only IPC endpoint, checks external CLI binaries, and writes one output envelope.
 * @perf        One bounded local IPC plus filesystem inventory and declared external binary checks.
 * @concurrency Does not mutate runtime state; safe alongside active Agent sessions.
 * @test        tests/unit/commands/status.test.ts
 * @stability   stable
 * @since       2026-07-15
 */

import { Command } from "commander";
import { readdirSync, existsSync, statSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { probeBrowserRuntimeBroker } from "../browser/runtime-launch.js";
import type { BrowserBrokerStatus } from "../browser/runtime-protocol.js";
import { VERSION } from "../constants.js";
import { loadExternalClis, isInstalled } from "../hub/index.js";
import { format, detectFormat } from "../output/formatter.js";
import { makeCtx } from "../output/envelope.js";
import type { OutputFormat } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface StatusOutput {
  version: string;
  platform: string;
  node: string;
  browser: {
    status: "running" | "stopped" | "error";
    default_provider: "managed";
    default_visibility: "hidden";
    active_target_count: number;
  };
  broker: {
    status: "running" | "stopped" | "error";
    pid?: number;
    runtime_id?: string;
    uptime_ms?: number;
    session_ttl_ms?: number;
    live_session_count: number;
    active_turn_count: number;
    target_lease_count: number;
    providers?: BrowserBrokerStatus["providers"];
    error?: string;
  };
  adapters: {
    total: number;
    yaml: number;
    typescript: number;
  };
  external_clis: {
    declared: number;
    installed: number;
  };
}

function countAdapterFiles(): { yaml: number; ts: number } {
  const candidates = [
    join(__dirname, "..", "adapters"),
    join(__dirname, "..", "..", "src", "adapters"),
  ];
  const userDir = join(process.env.HOME ?? "~", ".unicli", "adapters");
  let yaml = 0;
  let ts = 0;

  function scanDir(dir: string): void {
    if (!existsSync(dir)) return;
    for (const site of readdirSync(dir)) {
      if (site.startsWith("_") || site.startsWith(".")) continue;
      const siteDir = join(dir, site);
      if (!statSync(siteDir).isDirectory()) continue;
      for (const file of readdirSync(siteDir)) {
        const ext = extname(file);
        if (ext === ".yaml" || ext === ".yml") yaml++;
        else if (
          (ext === ".ts" || ext === ".js") &&
          !file.endsWith(".d.ts") &&
          !file.endsWith(".test.ts") &&
          !file.endsWith(".test.js")
        ) {
          ts++;
        }
      }
    }
  }

  for (const dir of candidates) {
    scanDir(dir);
    if (yaml + ts > 0) break;
  }
  scanDir(userDir);
  return { yaml, ts };
}

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("System health snapshot — browser runtime, adapters, tools")
    .action(async () => {
      const startedAt = Date.now();
      const ctx = makeCtx("status.run", startedAt);
      const outputFormat = detectFormat(
        program.opts().format as OutputFormat | undefined,
      );
      const runtime = await probeRuntime();
      const { yaml, ts } = countAdapterFiles();
      const externalClis = loadExternalClis();
      const installed = externalClis.reduce(
        (count, cli) => count + (isInstalled(cli.binary) ? 1 : 0),
        0,
      );
      const status = runtime.status;
      const targetCount = status?.sessions.target_leases.length ?? 0;
      const output: StatusOutput = {
        version: VERSION,
        platform: process.platform,
        node: process.version,
        browser: {
          status:
            runtime.state === "error"
              ? "error"
              : targetCount > 0
                ? "running"
                : "stopped",
          default_provider: "managed",
          default_visibility: "hidden",
          active_target_count: targetCount,
        },
        broker: {
          status: runtime.state,
          ...(status
            ? {
                pid: status.broker_pid,
                runtime_id: status.runtime_id,
                uptime_ms: status.uptime_ms,
                session_ttl_ms: status.session_ttl_ms,
                providers: status.providers,
              }
            : {}),
          live_session_count: status?.sessions.sessions.length ?? 0,
          active_turn_count:
            status?.sessions.sessions.reduce(
              (count, session) => count + session.active_turn_ids.length,
              0,
            ) ?? 0,
          target_lease_count: targetCount,
          ...(runtime.error ? { error: runtime.error } : {}),
        },
        adapters: { total: yaml + ts, yaml, typescript: ts },
        external_clis: { declared: externalClis.length, installed },
      };

      ctx.duration_ms = Date.now() - startedAt;
      console.log(
        format(
          output as unknown as Record<string, unknown>,
          undefined,
          outputFormat,
          ctx,
        ),
      );
    });
}

async function probeRuntime(): Promise<{
  state: "running" | "stopped" | "error";
  status?: BrowserBrokerStatus;
  error?: string;
}> {
  try {
    const connection = await probeBrowserRuntimeBroker({ timeoutMs: 1_000 });
    return { state: "running", status: connection.status };
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    if (code === "browser_broker_unavailable") return { state: "stopped" };
    return {
      state: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
