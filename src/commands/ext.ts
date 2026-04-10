/**
 * External CLI commands — discover, install, and run third-party CLIs.
 *
 * Commands:
 *   unicli ext list              — show all external CLIs with install status
 *   unicli ext install <name>    — install an external CLI
 *   unicli ext run <name> [args] — explicitly run an external CLI
 */

import { Command } from "commander";
import chalk from "chalk";
import { execFileSync } from "node:child_process";
import { listExternalClis, getExternalCli, isInstalled } from "../hub/index.js";
import { executeExternal } from "../hub/passthrough.js";
import { format, detectFormat } from "../output/formatter.js";
import type { OutputFormat } from "../types.js";

// ── Command Registration ────────────────────────────────────────────────

export function registerExtCommand(program: Command): void {
  const ext = program
    .command("ext")
    .description("External CLI passthrough — discover, install, run");

  // ── list ──────────────────────────────────────────────────────────────

  ext
    .command("list")
    .description("List all external CLIs with install status")
    .option("--installed", "show only installed CLIs")
    .option("--tag <tag>", "filter by tag")
    .action((opts: { installed?: boolean; tag?: string }) => {
      let clis = listExternalClis();

      if (opts.installed) {
        clis = clis.filter((c) => c.installed);
      }
      if (opts.tag) {
        const tag = opts.tag.toLowerCase();
        clis = clis.filter((c) => c.tags?.some((t) => t.toLowerCase() === tag));
      }

      const fmt = detectFormat(
        program.opts().format as OutputFormat | undefined,
      );

      const rows = clis.map((c) => ({
        name: c.name,
        binary: c.binary,
        description: c.description,
        installed: c.installed ? "yes" : "no",
        tags: (c.tags ?? []).join(", "),
      }));

      if (fmt === "json" || !process.stdout.isTTY) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }

      console.log(
        format(rows, ["name", "binary", "description", "installed"], fmt),
      );

      const installedCount = clis.filter((c) => c.installed).length;
      console.log(
        chalk.dim(
          `\n  ${installedCount}/${clis.length} installed. Run \`unicli ext install <name>\` to add more.`,
        ),
      );
    });

  // ── install ───────────────────────────────────────────────────────────

  ext
    .command("install <name>")
    .description("Install an external CLI tool")
    .action((name: string) => {
      const cli = getExternalCli(name);
      if (!cli) {
        console.error(
          chalk.red(
            `Unknown external CLI: ${name}. Run \`unicli ext list\` to see available CLIs.`,
          ),
        );
        process.exitCode = 1;
        return;
      }

      if (isInstalled(cli.binary)) {
        console.log(
          chalk.green(`${cli.name} is already installed (${cli.binary}).`),
        );
        return;
      }

      // Resolve platform-specific install command
      const platform = process.platform === "darwin" ? "mac" : "linux";
      const installCmd = cli.install?.[platform] ?? cli.install?.["default"];

      if (!installCmd) {
        console.error(
          chalk.yellow(`No install command for ${cli.name} on ${platform}.`),
        );
        if (cli.homepage) {
          console.error(chalk.dim(`  See: ${cli.homepage}`));
        }
        process.exitCode = 1;
        return;
      }

      console.log(chalk.cyan(`Installing ${cli.name}...`));
      console.log(chalk.dim(`  $ ${installCmd}`));

      // Split install command for safe execution
      // Most install commands are "npm install -g ..." or "brew install ..."
      const parts = installCmd.split(/\s+/);
      const bin = parts[0];
      const installArgs = parts.slice(1);

      try {
        execFileSync(bin, installArgs, {
          stdio: "inherit",
          timeout: 300_000, // 5 min for installs
        });
        console.log(chalk.green(`\n${cli.name} installed successfully.`));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Install failed: ${msg}`));
        if (cli.homepage) {
          console.error(chalk.dim(`  Manual install: ${cli.homepage}`));
        }
        process.exitCode = 1;
      }
    });

  // ── run ───────────────────────────────────────────────────────────────

  ext
    .command("run <name>")
    .description("Run an external CLI command")
    .allowUnknownOption()
    .allowExcessArguments()
    .action((name: string, _opts: Record<string, unknown>, cmd: Command) => {
      const cli = getExternalCli(name);
      if (!cli) {
        console.error(
          chalk.red(
            `Unknown external CLI: ${name}. Run \`unicli ext list\` to see available CLIs.`,
          ),
        );
        process.exitCode = 1;
        return;
      }

      if (!isInstalled(cli.binary)) {
        console.error(
          chalk.red(
            `${cli.name} is not installed. Run \`unicli ext install ${cli.name}\` first.`,
          ),
        );
        process.exitCode = 1;
        return;
      }

      // Everything after the CLI name becomes passthrough args
      const rawArgs = cmd.args.slice(1);
      executeExternal(cli, rawArgs);
    });
}
