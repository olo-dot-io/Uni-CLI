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
    .option("--json", "JSON output")
    .action((query: string, opts: { json?: boolean }) => {
      const index = loadIndex();
      if (!index) {
        console.error(
          chalk.yellow("No hub index. Run `unicli hub update` first."),
        );
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

      if (opts.json) {
        console.log(JSON.stringify(matches, null, 2));
        return;
      }

      if (matches.length === 0) {
        console.log(chalk.dim(`No adapters matching "${query}".`));
        return;
      }

      console.log(chalk.cyan(`Found ${matches.length} adapter(s):`));
      for (const m of matches) {
        console.log(
          `  ${chalk.green(m.site)}/${m.command} — ${m.description} (${m.strategy})`,
        );
      }
    });

  // Install
  hub
    .command("install <path>")
    .description("Install adapter from hub (site/command)")
    .action(async (adapterPath: string) => {
      const [site, command] = adapterPath.split("/");
      if (!site || !command) {
        console.error(chalk.red("Usage: unicli hub install <site>/<command>"));
        process.exitCode = 1;
        return;
      }

      // Validate names to prevent path traversal (CWE-22)
      const SAFE_NAME = /^[a-zA-Z0-9_-]+$/;
      if (!SAFE_NAME.test(site) || !SAFE_NAME.test(command)) {
        console.error(
          chalk.red(
            "Invalid site/command name. Only alphanumeric, hyphens, and underscores allowed.",
          ),
        );
        process.exitCode = 1;
        return;
      }

      try {
        // Fetch adapter YAML from GitHub repo
        const apiPath = `/repos/${HUB_REPO}/contents/adapters/${site}/${command}.yaml`;
        const response = ghApiJson(apiPath) as {
          content?: string;
          encoding?: string;
        };

        if (!response.content) {
          console.error(chalk.red(`Adapter not found: ${site}/${command}`));
          process.exitCode = 1;
          return;
        }

        const content = Buffer.from(response.content, "base64").toString(
          "utf-8",
        );

        // Install to user adapter directory
        const targetDir = join(ADAPTERS_DIR, site);
        mkdirSync(targetDir, { recursive: true });
        const targetPath = join(targetDir, `${command}.yaml`);
        writeFileSync(targetPath, content, "utf-8");

        console.log(
          chalk.green(`Installed ${site}/${command} → ${targetPath}`),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Install failed: ${msg}`));
        console.error(
          chalk.dim("Make sure `gh` is installed and authenticated."),
        );
        process.exitCode = 1;
      }
    });

  // Publish
  hub
    .command("publish <site> [command]")
    .description("Submit adapter to community hub")
    .action((site: string, command?: string) => {
      const SAFE_NAME = /^[a-zA-Z0-9_-]+$/;
      if (!SAFE_NAME.test(site) || (command && !SAFE_NAME.test(command))) {
        console.error(
          chalk.red("Invalid name. Only alphanumeric, hyphens, underscores."),
        );
        process.exitCode = 1;
        return;
      }
      // Find adapter files
      const siteDir = join("src", "adapters", site);
      if (!existsSync(siteDir)) {
        // Try user override directory
        const userDir = join(ADAPTERS_DIR, site);
        if (!existsSync(userDir)) {
          console.error(chalk.red(`Adapter directory not found: ${site}`));
          process.exitCode = 1;
          return;
        }
      }

      // For now, just print instructions. Full automation would need gh pr create.
      console.log(chalk.cyan(`To publish ${site} adapters to the hub:`));
      console.log("");
      console.log(`  1. Fork ${HUB_REPO} on GitHub`);
      console.log(
        `  2. Copy your adapter YAML to adapters/${site}/${command ?? "*"}.yaml`,
      );
      console.log(`  3. Add meta.json with author, description, and strategy`);
      console.log(`  4. Create a pull request`);
      console.log("");
      console.log(chalk.dim(`Or use: gh repo fork ${HUB_REPO} && ...`));
    });

  // Update
  hub
    .command("update")
    .description("Pull latest adapter index from hub")
    .action(async () => {
      ensureHubDir();

      try {
        // Fetch directory listing from GitHub API
        const response = ghApiJson(
          `/repos/${HUB_REPO}/contents/adapters`,
        ) as Array<{ name: string; type: string }>;

        if (!Array.isArray(response)) {
          console.error(chalk.red("Failed to fetch hub index."));
          process.exitCode = 1;
          return;
        }

        const entries: HubEntry[] = [];

        for (const dir of response) {
          if (dir.type !== "dir") continue;
          const site = dir.name;

          // Fetch commands for this site
          try {
            const files = ghApiJson(
              `/repos/${HUB_REPO}/contents/adapters/${site}`,
            ) as Array<{ name: string }>;

            for (const file of files) {
              if (!file.name.endsWith(".yaml")) continue;
              const cmd = basename(file.name, ".yaml");
              entries.push({
                site,
                command: cmd,
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

        console.log(
          chalk.green(
            `Hub index updated: ${entries.length} adapters from ${response.filter((d) => d.type === "dir").length} sites.`,
          ),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Update failed: ${msg}`));
        console.error(
          chalk.dim("Make sure `gh` is installed and authenticated."),
        );
        process.exitCode = 1;
      }
    });

  // Verify
  hub
    .command("verify <site>")
    .description("Verify installed hub adapters")
    .action((site: string) => {
      const SAFE_NAME = /^[a-zA-Z0-9_-]+$/;
      if (!SAFE_NAME.test(site)) {
        console.error(chalk.red("Invalid site name."));
        process.exitCode = 1;
        return;
      }
      const siteDir = join(ADAPTERS_DIR, site);
      if (!existsSync(siteDir)) {
        console.error(chalk.red(`No hub adapters installed for: ${site}`));
        process.exitCode = 1;
        return;
      }

      console.log(chalk.cyan(`Verifying ${site} adapters...`));

      try {
        // Use execFileSync with args — no shell injection
        const result = execFileSync("unicli", ["eval", "run", site, "--json"], {
          encoding: "utf-8",
          timeout: 60_000,
        }) as string;
        console.log(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.yellow(`Verification: ${msg}`));
      }
    });
}
