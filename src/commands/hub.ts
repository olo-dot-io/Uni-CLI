/**
 * Hub CLI command — git-based adapter registry.
 *
 * Commands:
 *   unicli hub search <query>                  — search community adapters
 *   unicli hub install <site>/<command>         — install adapter from hub
 *   unicli hub publish <site> [command]         — submit adapter to hub
 *   unicli hub update                           — pull latest adapter index
 *   unicli hub verify <site>                    — verify installed hub adapters
 */

import { Command } from "commander";
import chalk from "chalk";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { format, detectFormat } from "../output/formatter.js";
import { makeCtx } from "../output/envelope.js";
import { mapErrorToExitCode } from "../output/error-map.js";
import type { OutputFormat } from "../types.js";

const HUB_REPO = "olo-dot-io/unicli-hub";
const HUB_DIR = join(homedir(), ".unicli", "hub");
const INDEX_PATH = join(HUB_DIR, "index.json");
const ADAPTERS_DIR = join(homedir(), ".unicli", "adapters");

// ── Types ────────────────────────────────────────────────────────────────

interface HubEntry {
  site: string;
  command: string;
  description: string;
  author: string;
  strategy: string;
  lastVerified?: string;
  score?: string;
}

interface HubIndex {
  updatedAt: string;
  entries: HubEntry[];
}

// ── Helpers ──────────────────────────────────────────────────────────────

function ghApiJson(endpoint: string): unknown {
  const raw = execFileSync("gh", ["api", endpoint], {
    encoding: "utf-8",
    timeout: 15_000,
  }) as string;
  return JSON.parse(raw);
}

function ensureHubDir(): void {
  mkdirSync(HUB_DIR, { recursive: true });
}

function loadIndex(): HubIndex | null {
  if (!existsSync(INDEX_PATH)) return null;
  try {
    return JSON.parse(readFileSync(INDEX_PATH, "utf-8")) as HubIndex;
  } catch {
    return null;
  }
}

// ── Command Registration ────────────────────────────────────────────────

export function registerHubCommand(program: Command): void {
  const hub = program.command("hub").description("Community adapter registry");

  // Search
  hub
    .command("search <query>")
    .description("Search community adapters")
    .option("--json", "JSON output (alias for -f json)")
    .action((query: string, opts: { json?: boolean }) => {
      const startedAt = Date.now();
      const ctx = makeCtx("hub.search", startedAt);
      const rootFmt = program.opts().format as OutputFormat | undefined;
      const fmt = detectFormat(opts.json ? "json" : rootFmt);

      const index = loadIndex();
      if (!index) {
        ctx.error = {
          code: "not_found",
          message: "No hub index found.",
          suggestion: "Run `unicli hub update` to fetch the community index.",
          retryable: false,
        };
        console.error(format(null, undefined, fmt, ctx));
        process.exitCode = 1;
        return;
      }

      const q = query.toLowerCase();
      const matches = index.entries.filter(
        (e) =>
          e.site.includes(q) ||
          e.command.includes(q) ||
          e.description.toLowerCase().includes(q),
      );

      ctx.duration_ms = Date.now() - startedAt;
      console.log(
        format(
          matches,
          ["site", "command", "description", "strategy"],
          fmt,
          ctx,
        ),
      );

      if (matches.length === 0) {
        console.error(chalk.dim(`\n  No adapters matching "${query}".`));
      } else {
        console.error(
          chalk.dim(`\n  ${matches.length} adapter(s) matching "${query}".`),
        );
      }
    });

  // Install
  hub
    .command("install <path>")
    .description("Install adapter from hub (site/command)")
    .action(async (adapterPath: string) => {
      const startedAt = Date.now();
      const ctx = makeCtx("hub.install", startedAt);
      const fmt = detectFormat(
        program.opts().format as OutputFormat | undefined,
      );

      const [site, command] = adapterPath.split("/");
      if (!site || !command) {
        ctx.error = {
          code: "invalid_input",
          message: "Usage: unicli hub install <site>/<command>",
          suggestion: "Example: unicli hub install reddit/frontpage",
          retryable: false,
        };
        console.error(format(null, undefined, fmt, ctx));
        process.exitCode = 2;
        return;
      }

      // Validate names to prevent path traversal (CWE-22)
      const SAFE_NAME = /^[a-zA-Z0-9_-]+$/;
      if (!SAFE_NAME.test(site) || !SAFE_NAME.test(command)) {
        ctx.error = {
          code: "invalid_input",
          message:
            "Invalid site/command name. Only alphanumeric, hyphens, and underscores allowed.",
          retryable: false,
        };
        console.error(format(null, undefined, fmt, ctx));
        process.exitCode = 2;
        return;
      }

      try {
        const apiPath = `/repos/${HUB_REPO}/contents/adapters/${site}/${command}.yaml`;
        const response = ghApiJson(apiPath) as {
          content?: string;
          encoding?: string;
        };

        if (!response.content) {
          ctx.error = {
            code: "not_found",
            message: `Adapter not found: ${site}/${command}`,
            suggestion: "Run `unicli hub search <query>` to discover adapters.",
            retryable: false,
          };
          console.error(format(null, undefined, fmt, ctx));
          process.exitCode = 1;
          return;
        }

        const content = Buffer.from(response.content, "base64").toString(
          "utf-8",
        );

        const targetDir = join(ADAPTERS_DIR, site);
        mkdirSync(targetDir, { recursive: true });
        const targetPath = join(targetDir, `${command}.yaml`);
        writeFileSync(targetPath, content, "utf-8");

        const data = {
          site,
          command,
          path: targetPath,
          bytes: Buffer.byteLength(content, "utf-8"),
        };
        ctx.duration_ms = Date.now() - startedAt;
        console.log(format(data, undefined, fmt, ctx));
        console.error(
          chalk.green(`\n  Installed ${site}/${command} → ${targetPath}`),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.error = {
          code: "internal_error",
          message: `Install failed: ${msg}`,
          suggestion: "Make sure `gh` is installed and authenticated.",
          retryable: true,
        };
        ctx.duration_ms = Date.now() - startedAt;
        console.error(format(null, undefined, fmt, ctx));
        process.exitCode = mapErrorToExitCode(err);
      }
    });

  // Publish
  hub
    .command("publish <site> [command]")
    .description("Submit adapter to community hub")
    .action((site: string, command?: string) => {
      const startedAt = Date.now();
      const ctx = makeCtx("hub.publish", startedAt);
      const fmt = detectFormat(
        program.opts().format as OutputFormat | undefined,
      );

      const SAFE_NAME = /^[a-zA-Z0-9_-]+$/;
      if (!SAFE_NAME.test(site) || (command && !SAFE_NAME.test(command))) {
        ctx.error = {
          code: "invalid_input",
          message: "Invalid name. Only alphanumeric, hyphens, underscores.",
          retryable: false,
        };
        console.error(format(null, undefined, fmt, ctx));
        process.exitCode = 2;
        return;
      }
      const siteDir = join("src", "adapters", site);
      const userDir = join(ADAPTERS_DIR, site);
      if (!existsSync(siteDir) && !existsSync(userDir)) {
        ctx.error = {
          code: "not_found",
          message: `Adapter directory not found: ${site}`,
          suggestion: `Create adapters at src/adapters/${site}/ or ${userDir}`,
          retryable: false,
        };
        console.error(format(null, undefined, fmt, ctx));
        process.exitCode = 1;
        return;
      }

      const instructions = [
        `Fork ${HUB_REPO} on GitHub`,
        `Copy your adapter YAML to adapters/${site}/${command ?? "*"}.yaml`,
        "Add meta.json with author, description, and strategy",
        "Create a pull request",
      ];
      const data = {
        site,
        command: command ?? null,
        hub_repo: HUB_REPO,
        instructions,
      };
      ctx.duration_ms = Date.now() - startedAt;
      console.log(format(data, undefined, fmt, ctx));

      console.error(chalk.cyan(`\n  To publish ${site} adapters:`));
      for (let i = 0; i < instructions.length; i++) {
        console.error(`    ${i + 1}. ${instructions[i]}`);
      }
    });

  // Update
  hub
    .command("update")
    .description("Pull latest adapter index from hub")
    .action(async () => {
      const startedAt = Date.now();
      const ctx = makeCtx("hub.update", startedAt);
      const fmt = detectFormat(
        program.opts().format as OutputFormat | undefined,
      );

      ensureHubDir();

      try {
        const response = ghApiJson(
          `/repos/${HUB_REPO}/contents/adapters`,
        ) as Array<{ name: string; type: string }>;

        if (!Array.isArray(response)) {
          ctx.error = {
            code: "upstream_error",
            message: "Failed to fetch hub index.",
            suggestion: "Retry, or check GitHub API status.",
            retryable: true,
          };
          console.error(format(null, undefined, fmt, ctx));
          process.exitCode = 1;
          return;
        }

        const entries: HubEntry[] = [];
        for (const dir of response) {
          if (dir.type !== "dir") continue;
          const site = dir.name;
          try {
            const files = ghApiJson(
              `/repos/${HUB_REPO}/contents/adapters/${site}`,
            ) as Array<{ name: string }>;
            for (const file of files) {
              if (!file.name.endsWith(".yaml")) continue;
              entries.push({
                site,
                command: basename(file.name, ".yaml"),
                description: "",
                author: "",
                strategy: "public",
              });
            }
          } catch {
            /* skip site on error */
          }
        }

        const index: HubIndex = {
          updatedAt: new Date().toISOString(),
          entries,
        };
        writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), "utf-8");

        const siteCount = response.filter((d) => d.type === "dir").length;
        const data = {
          updated_at: index.updatedAt,
          adapters: entries.length,
          sites: siteCount,
          index_path: INDEX_PATH,
        };
        ctx.duration_ms = Date.now() - startedAt;
        console.log(format(data, undefined, fmt, ctx));

        console.error(
          chalk.green(
            `\n  Hub index updated: ${entries.length} adapters from ${siteCount} sites.`,
          ),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.error = {
          code: "internal_error",
          message: `Update failed: ${msg}`,
          suggestion: "Make sure `gh` is installed and authenticated.",
          retryable: true,
        };
        ctx.duration_ms = Date.now() - startedAt;
        console.error(format(null, undefined, fmt, ctx));
        process.exitCode = mapErrorToExitCode(err);
      }
    });

  // Verify
  hub
    .command("verify <site>")
    .description("Verify installed hub adapters")
    .action((site: string) => {
      const startedAt = Date.now();
      const ctx = makeCtx("hub.verify", startedAt);
      const fmt = detectFormat(
        program.opts().format as OutputFormat | undefined,
      );

      const SAFE_NAME = /^[a-zA-Z0-9_-]+$/;
      if (!SAFE_NAME.test(site)) {
        ctx.error = {
          code: "invalid_input",
          message: "Invalid site name.",
          retryable: false,
        };
        console.error(format(null, undefined, fmt, ctx));
        process.exitCode = 2;
        return;
      }
      const siteDir = join(ADAPTERS_DIR, site);
      if (!existsSync(siteDir)) {
        ctx.error = {
          code: "not_found",
          message: `No hub adapters installed for: ${site}`,
          suggestion: `Install first: unicli hub install ${site}/<command>`,
          retryable: false,
        };
        console.error(format(null, undefined, fmt, ctx));
        process.exitCode = 1;
        return;
      }

      console.error(chalk.cyan(`Verifying ${site} adapters...`));

      try {
        const raw = execFileSync("unicli", ["eval", "run", site, "--json"], {
          encoding: "utf-8",
          timeout: 60_000,
        }) as string;
        // Passthrough the child eval envelope to stdout untouched so agents
        // parsing stdout always see a single v2 envelope.
        process.stdout.write(raw);
        // Emit a summary to stderr only.
        console.error(
          chalk.dim(`  Verified ${site} via: unicli eval run ${site} --json`),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.error = {
          code: "internal_error",
          message: `Verification failed: ${msg}`,
          suggestion: "Check that `unicli` is on PATH and the adapter loads.",
          retryable: true,
        };
        ctx.duration_ms = Date.now() - startedAt;
        console.error(format(null, undefined, fmt, ctx));
        process.exitCode = mapErrorToExitCode(err);
      }
    });
}
