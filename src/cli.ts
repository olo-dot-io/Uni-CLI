/**
 * CLI entry point — Commander-based routing with dynamic adapter commands.
 */

import { Command } from "commander";
import chalk from "chalk";
import { loadAllAdapters, loadTsAdapters } from "./discovery/loader.js";
import { getAllAdapters, listCommands } from "./registry.js";
import { loadExternalClis, isInstalled } from "./hub/index.js";
import { executeExternal } from "./hub/passthrough.js";
import { format, detectFormat } from "./output/formatter.js";
import { runPipeline } from "./engine/executor.js";
import { ExitCode } from "./types.js";
import { VERSION } from "./constants.js";
import { registerAuthCommands } from "./commands/auth.js";
import { registerBrowserCommands } from "./commands/browser.js";
import { registerDaemonCommands } from "./commands/daemon.js";
import {
  registerCompletionCommand,
  getCompletions,
} from "./commands/completion.js";
import { registerOperateCommands } from "./commands/operate.js";
import { registerRecordCommand } from "./commands/record.js";
import { registerPluginCommands } from "./commands/plugin.js";
import { registerAdapterCommands } from "./commands/adapter.js";
import { registerInitCommand } from "./commands/init.js";
import { registerDevCommand } from "./commands/dev.js";
import { registerExploreCommand } from "./commands/explore.js";
import { registerSynthesizeCommand } from "./commands/synthesize.js";
import { registerGenerateCommand } from "./commands/generate.js";
import { registerHealthCommand } from "./commands/health.js";
import { registerAgentsCommand } from "./commands/agents.js";
import { registerRepairCommand } from "./commands/repair.js";
import { registerSkillsCommand } from "./commands/skills.js";
import { registerUsageCommands } from "./commands/usage.js";
import { registerMcpCommand } from "./commands/mcp.js";
import { registerAcpCommand } from "./commands/acp.js";
import { registerEvalCommand } from "./commands/eval.js";
import { registerResearchCommand } from "./commands/research.js";
import { registerHubCommand } from "./commands/hub.js";
import { registerExtCommand } from "./commands/ext.js";
import { registerTestGenCommand } from "./commands/test-gen.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerSchemaCommand } from "./commands/schema.js";
import { registerSearchCommand } from "./commands/search.js";
import { registerLintCommand } from "./commands/lint.js";
import { registerMigrateCommand } from "./commands/migrate.js";
import { registerMigrateSchemaCommand } from "./commands/migrate-schema.js";
import { registerAdapterDispatch } from "./commands/dispatch.js";
import { registerDescribeCommand } from "./commands/describe.js";
import { emitHook } from "./hooks.js";
import { checkForUpdates } from "./engine/update-check.js";
import type { OutputFormat } from "./types.js";

export async function createCli(): Promise<Command> {
  const program = new Command();

  // Non-blocking update check (fire-and-forget)
  checkForUpdates();

  program
    .name("unicli")
    .description(
      "The universal interface between AI agents and the world's software",
    )
    .version(VERSION)
    .option(
      "-f, --format <format>",
      "output format: json, yaml, csv, md, compact (table deprecated, falls back to md)",
    )
    .option("-v, --verbose", "show pipeline debug steps")
    .option(
      "--args-file <path>",
      "read args as JSON from a file (overrides shell flags; stdin JSON still wins)",
    )
    .option(
      "--dry-run",
      "resolve args + print execution plan without running the pipeline",
    )
    .option(
      "--select <jsonpath>",
      "project results via JSONPath (e.g. '$[*].title') before formatting",
    )
    .option(
      "--fields <list>",
      "comma-separated column list applied to tabular output (overrides adapter columns)",
    )
    .option(
      "--pluck <field>",
      "emit a single field one-per-line (plain text stream, wins over --select/--fields)",
    );

  // Load YAML adapters synchronously, then TS adapters asynchronously
  const yamlCount = loadAllAdapters();
  const tsCount = await loadTsAdapters();
  const adapterCount = yamlCount + tsCount;

  // Register "list" command
  program
    .command("list")
    .description("List all available commands")
    .option("--site <site>", "filter by site name")
    .option("--type <type>", "filter by adapter type")
    .action((opts) => {
      const listStarted = Date.now();
      let commands = listCommands();

      if (opts.site) {
        commands = commands.filter((c) => c.site.includes(opts.site));
      }
      if (opts.type) {
        commands = commands.filter((c) => c.type === opts.type);
      }

      const fmt = detectFormat(
        program.opts().format as OutputFormat | undefined,
      );
      const rows = commands.map((c) => {
        const tags: string[] = [];
        if (c.auth) tags.push("[auth]");
        if (c.quarantined) tags.push("[quarantined]");
        return {
          site: c.site,
          command: c.command,
          description: c.description,
          type: c.type,
          auth: tags.join(" "),
        };
      });

      console.log(
        format(rows, ["site", "command", "description", "type", "auth"], fmt, {
          command: "core.list",
          duration_ms: Date.now() - listStarted,
          surface: "web",
        }),
      );
    });

  // Register "doctor" command
  program
    .command("doctor")
    .description("Diagnose environment: adapters, browser, daemon, tools")
    .action(async () => {
      console.log(chalk.bold("unicli doctor\n"));

      // 1. Basic info
      console.log(`  Adapters: ${chalk.green(adapterCount)}`);
      console.log(`  Sites:    ${chalk.green(getAllAdapters().length)}`);
      console.log(`  Node.js:  ${chalk.green(process.version)}`);
      console.log(`  Platform: ${chalk.green(process.platform)}`);
      console.log("");

      // 2. Daemon status
      try {
        const { fetchDaemonStatus } =
          await import("./browser/daemon-client.js");
        const status = await fetchDaemonStatus({ timeout: 2000 });
        if (status) {
          console.log(
            `  Daemon:   ${chalk.green("running")} (port ${status.port ?? 19825})`,
          );
        } else {
          console.log(
            `  Daemon:   ${chalk.yellow("not running")} — run: unicli daemon start`,
          );
        }
      } catch {
        console.log(
          `  Daemon:   ${chalk.yellow("not running")} — run: unicli daemon start`,
        );
      }

      // 3. Chrome / CDP connectivity
      try {
        const { isCDPAvailable, getCDPPort } =
          await import("./browser/launcher.js");
        const port = getCDPPort();
        const available = await isCDPAvailable(port);
        if (available) {
          console.log(
            `  Chrome:   ${chalk.green("reachable")} (CDP port ${port})`,
          );
        } else {
          console.log(
            `  Chrome:   ${chalk.yellow("not detected")} — run: unicli browser start`,
          );
        }
      } catch {
        console.log(
          `  Chrome:   ${chalk.yellow("not detected")} — run: unicli browser start`,
        );
      }

      // 4. Cookie directory
      const { existsSync, readdirSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const cookieDir = join(homedir(), ".unicli", "cookies");
      if (existsSync(cookieDir)) {
        const cookieFiles = readdirSync(cookieDir).filter((f) =>
          f.endsWith(".json"),
        );
        console.log(
          `  Cookies:  ${chalk.green(`${cookieFiles.length} site(s)`)} in ${cookieDir}`,
        );
      } else {
        console.log(
          `  Cookies:  ${chalk.dim("none")} — run: unicli auth setup <site>`,
        );
      }

      // 5. External tools
      console.log("");
      const tools = [
        { name: "yt-dlp", check: "yt-dlp --version" },
        { name: "ffmpeg", check: "ffmpeg -version" },
      ];
      for (const tool of tools) {
        try {
          const { execSync } = await import("node:child_process");
          execSync(tool.check, { stdio: "pipe", timeout: 3000 });
          console.log(`  ${tool.name.padEnd(8)}: ${chalk.green("installed")}`);
        } catch {
          console.log(
            `  ${tool.name.padEnd(8)}: ${chalk.dim("not found")} (optional, needed for download step)`,
          );
        }
      }

      // 6. Plugin directory
      const pluginsDir = join(homedir(), ".unicli", "plugins");
      if (existsSync(pluginsDir)) {
        const plugins = readdirSync(pluginsDir, { withFileTypes: true }).filter(
          (d) => d.isDirectory(),
        );
        console.log(
          `  Plugins:  ${chalk.green(`${plugins.length} installed`)} in ${pluginsDir}`,
        );
      } else {
        console.log(`  Plugins:  ${chalk.dim("none")}`);
      }

      console.log(chalk.dim(`\n  Version:  ${VERSION}`));
    });

  // Register auth commands — cookie management
  registerAuthCommands(program);

  // Register browser commands — Chrome CDP management
  registerBrowserCommands(program);

  // Register daemon commands — lifecycle management
  registerDaemonCommands(program);

  // Register completion command — shell tab completion
  registerCompletionCommand(program);

  // Register operate commands — interactive browser control for agents
  registerOperateCommands(program);

  // Register record command — capture network requests and generate adapters
  registerRecordCommand(program);

  // Register plugin commands — third-party adapter management
  registerPluginCommands(program);

  // Register adapter marketplace commands — install/update/list community adapters
  registerAdapterCommands(program);

  // Register init command — scaffold new adapter YAML files
  registerInitCommand(program);

  // Register dev command — hot-reload for adapter development
  registerDevCommand(program);

  // Register explore command — API discovery engine
  registerExploreCommand(program);

  // Register synthesize command — YAML adapter candidate generator
  registerSynthesizeCommand(program);

  // Register generate command — one-shot explore+synthesize+select
  registerGenerateCommand(program);

  // Register health command — adapter health checker
  registerHealthCommand(program);

  // Register agents command — AGENTS.md auto-generation
  registerAgentsCommand(program);

  // Load third-party plugins (manifest-based)
  try {
    const { loadPlugins } = await import("./plugin/loader.js");
    const { errors: pluginErrors } = await loadPlugins();
    if (pluginErrors.length > 0 && program.opts().verbose) {
      for (const err of pluginErrors) {
        console.error(chalk.yellow(`[plugin] ${err}`));
      }
    }
  } catch {
    // Plugin system failure is non-fatal
  }

  // Emit startup hook — plugins can listen for CLI boot
  await emitHook("onStartup", { command: "__startup__", args: {} });

  // Register repair command — self-repair broken adapters using AI
  registerRepairCommand(program);

  // Register skills command — export adapter SKILL.md files for agent registries
  registerSkillsCommand(program);

  // Register usage command — read the per-call cost ledger
  registerUsageCommands(program);

  // Register mcp command — MCP gateway server + health check
  registerMcpCommand(program);

  // Register acp command — Agent Client Protocol (avante.nvim, Zed) stdio server
  registerAcpCommand(program);

  // Register eval command — declarative regression suites
  registerEvalCommand(program);
  registerResearchCommand(program);
  registerHubCommand(program);
  registerExtCommand(program);
  registerTestGenCommand(program);
  registerStatusCommand(program);

  // Register schema command — JSON Schema for adapter input/output
  registerSchemaCommand(program);
  registerSearchCommand(program);

  // Register lint command — schema-v2 static validation
  registerLintCommand(program);

  // Register describe command — runtime schema introspection for agents
  registerDescribeCommand(program);

  // Register `unicli import opencli-yaml` and friends
  registerMigrateCommand(program);

  // Register migrate commands — schema-v1 → schema-v2 mass migration
  registerMigrateSchemaCommand(program);

  // Register "test" command — run all commands for a site
  program
    .command("test [site]")
    .description("Test adapter commands (run all or for a specific site)")
    .option("--timeout <ms>", "timeout per command in ms", "15000")
    .action(async (site: string | undefined, opts: Record<string, string>) => {
      const timeout = parseInt(opts.timeout, 10) || 15000;
      const adaptersToTest = site
        ? getAllAdapters().filter((a) => a.name === site)
        : getAllAdapters();

      if (adaptersToTest.length === 0) {
        console.error(
          chalk.red(site ? `Unknown site: ${site}` : "No adapters loaded"),
        );
        process.exit(ExitCode.USAGE_ERROR);
      }

      let passed = 0;
      let failed = 0;
      let skipped = 0;

      for (const adapter of adaptersToTest) {
        console.log(chalk.bold(`\n${adapter.name}`));

        for (const [cmdName, cmd] of Object.entries(adapter.commands)) {
          if (cmd.quarantine) {
            const reason = cmd.quarantineReason
              ? `: ${cmd.quarantineReason}`
              : "";
            console.log(
              chalk.yellow(`  ${cmdName}: skip [quarantined]${reason}`),
            );
            skipped++;
            continue;
          }

          if (!cmd.pipeline) {
            console.log(chalk.dim(`  ${cmdName}: skip (TS func)`));
            skipped++;
            continue;
          }

          // Skip commands that require positional args (can't test without input)
          const requiredArgs = (cmd.adapterArgs ?? []).filter(
            (a) => a.required && a.positional,
          );
          if (requiredArgs.length > 0) {
            console.log(
              chalk.dim(
                `  ${cmdName}: skip (requires: ${requiredArgs.map((a) => a.name).join(", ")})`,
              ),
            );
            skipped++;
            continue;
          }

          try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeout);

            const results = await runPipeline(
              cmd.pipeline,
              { args: { limit: 2 }, source: "internal" },
              adapter.base,
              { site: adapter.name, strategy: adapter.strategy },
            );
            clearTimeout(timer);

            if (results.length > 0) {
              console.log(
                chalk.green(`  ${cmdName}: ✓ (${results.length} results)`),
              );
              passed++;
            } else {
              console.log(chalk.yellow(`  ${cmdName}: ✓ (empty)`));
              passed++;
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(chalk.red(`  ${cmdName}: ✗ ${msg.slice(0, 80)}`));
            failed++;
          }
        }
      }

      console.log(
        chalk.bold(
          `\nResults: ${chalk.green(passed + " passed")}, ${chalk.red(failed + " failed")}, ${chalk.dim(skipped + " skipped")}`,
        ),
      );
      process.exit(failed > 0 ? ExitCode.GENERIC_ERROR : ExitCode.SUCCESS);
    });

  // Dynamic site commands — per-adapter Commander registration + execution.
  // Extracted to src/commands/dispatch.ts for the v2 envelope format() wiring.
  registerAdapterDispatch(program);

  // Dynamic external CLI passthrough — register installed CLIs as top-level commands.
  // Skip CLIs that already have a dedicated adapter (avoids Commander name collision).
  const existingNames = new Set(program.commands.map((c: Command) => c.name()));
  for (const extCli of loadExternalClis()) {
    if (existingNames.has(extCli.name)) continue;
    if (isInstalled(extCli.binary)) {
      program
        .command(extCli.name, { hidden: false })
        .description(`[ext] ${extCli.description}`)
        .allowUnknownOption()
        .allowExcessArguments()
        .action((_opts: Record<string, unknown>, cmd: Command) => {
          const args = cmd.args;
          executeExternal(extCli, args);
        });
    }
  }

  // Handle internal completion requests
  if (process.argv.includes("--get-completions")) {
    const cursorIdx = process.argv.indexOf("--cursor");
    const cursor =
      cursorIdx >= 0 ? parseInt(process.argv[cursorIdx + 1], 10) : 1;
    const words = process.argv
      .slice(process.argv.indexOf("--get-completions") + 1)
      .filter((a) => a !== "--cursor" && !/^\d+$/.test(a));
    const completions = getCompletions(words, cursor);
    console.log(completions.join("\n"));
    process.exit(0);
  }

  return program;
}
