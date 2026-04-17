/**
 * Status command — lightweight system health snapshot for AI agents.
 *
 * Command:
 *   unicli status  — v2 envelope with version/platform/daemon/browser/adapter counts
 *
 * Designed for machine consumption: envelope `command = status.run`, data holds
 * the snapshot object. Human-oriented summaries stay on stderr (Scene-6 pattern).
 */

import { Command } from "commander";
import { readdirSync, existsSync, statSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../constants.js";
import { loadExternalClis, isInstalled } from "../hub/index.js";
import { fetchDaemonStatus } from "../browser/daemon-client.js";
import { DAEMON_PORT } from "../browser/protocol.js";
import { format, detectFormat } from "../output/formatter.js";
import { makeCtx } from "../output/envelope.js";
import type { OutputFormat } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface StatusOutput {
  version: string;
  platform: string;
  node: string;
  browser: {
    status: "running" | "stopped" | "unknown";
    pid?: number;
  };
  daemon: {
    status: "running" | "stopped" | "unknown";
    port: number;
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

/** Count YAML and TS adapter files across built-in and user directories. */
function countAdapterFiles(): { yaml: number; ts: number } {
  // Resolve adapter directories (same logic as discovery/loader.ts)
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
        if (ext === ".yaml" || ext === ".yml") {
          yaml++;
        } else if (
          ext === ".ts" &&
          !file.endsWith(".d.ts") &&
          !file.endsWith(".test.ts")
        ) {
          ts++;
        } else if (
          ext === ".js" &&
          !file.endsWith(".d.ts") &&
          !file.endsWith(".test.js")
        ) {
          ts++;
        }
      }
    }
  }

  for (const dir of candidates) {
    scanDir(dir);
    // Stop after first directory that has adapters
    if (yaml + ts > 0) break;
  }
  scanDir(userDir);

  return { yaml, ts };
}

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("System health snapshot — version, daemon, browser, adapters")
    .action(async () => {
      const startedAt = Date.now();
      const ctx = makeCtx("status.run", startedAt);
      const fmt = detectFormat(
        program.opts().format as OutputFormat | undefined,
      );

      // 1. Basic info
      const version = VERSION;
      const platform = process.platform;
      const node = process.version;

      // 2. Daemon status (quick check with short timeout)
      let daemonStatus: "running" | "stopped" | "unknown" = "unknown";
      let daemonPort = DAEMON_PORT;
      try {
        const status = await fetchDaemonStatus({ timeout: 2000 });
        if (status) {
          daemonStatus = "running";
          daemonPort = status.port ?? DAEMON_PORT;
        } else {
          daemonStatus = "stopped";
        }
      } catch {
        daemonStatus = "unknown";
      }

      // 3. Browser (CDP) status
      let browserStatus: "running" | "stopped" | "unknown" = "unknown";
      try {
        const { isCDPAvailable, getCDPPort } =
          await import("../browser/launcher.js");
        const port = getCDPPort();
        const available = await isCDPAvailable(port);
        browserStatus = available ? "running" : "stopped";
      } catch {
        browserStatus = "unknown";
      }

      // 4. Adapter counts — scan filesystem
      const { yaml, ts } = countAdapterFiles();
      const total = yaml + ts;

      // 5. External CLIs
      const externalClis = loadExternalClis();
      const declared = externalClis.length;
      let installed = 0;
      for (const cli of externalClis) {
        if (isInstalled(cli.binary)) {
          installed++;
        }
      }

      // 6. Assemble output
      const output: StatusOutput = {
        version,
        platform,
        node,
        browser: {
          status: browserStatus,
        },
        daemon: {
          status: daemonStatus,
          port: daemonPort,
        },
        adapters: {
          total,
          yaml,
          typescript: ts,
        },
        external_clis: {
          declared,
          installed,
        },
      };

      ctx.duration_ms = Date.now() - startedAt;
      console.log(
        format(
          output as unknown as Record<string, unknown>,
          undefined,
          fmt,
          ctx,
        ),
      );
    });
}
