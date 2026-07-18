/**
 * @owner       src::cli
 * @does        Builds the Commander command tree and dispatches full CLI operations after the manifest fast path.
 * @needs       command registrars, adapter registry/loader, pipeline engine, proxy-aware network, update check, Commander error boundary
 * @feeds       src/main.ts and CLI-focused integration tests
 * @breaks      Command parsing, adapter loading, or command handlers propagate semantic CLI exit codes.
 * @invariants  One command tree owns every non-fast-path invocation; proxy installation precedes network-capable handlers; unknown user tokens never become diagnostic command identities.
 * @side-effects Loads adapters, installs global proxy-aware fetch, checks cached updates, writes CLI output.
 * @perf        Full path loads the adapter registry; discovery-only invocations stay on src/fast-path.ts.
 * @concurrency One command tree per createCli call; process-wide network installation is idempotent.
 * @test        tests/unit/cli, tests/unit/commands, tests/unit/integration-fixtures
 * @stability   stable
 * @since       2026-04-06
 */

import { Command } from "commander";
import chalk from "chalk";
import { loadAllAdapters, loadTsAdapters } from "./discovery/loader.js";
import {
  commandStrategy,
  commandUsesBrowser,
  getAllAdapters,
  listCommands,
} from "./registry.js";
import { loadExternalClis, isInstalled } from "./hub/index.js";
import { executeExternal } from "./hub/passthrough.js";
import { format, detectFormat } from "./output/formatter.js";
import { listCoreDiscoveryCommands } from "./discovery/core-catalog.js";
import { runPipeline } from "./engine/executor.js";
import { verifyRowShape } from "./engine/verify-row-shape.js";
import { ExitCode } from "./types.js";
import { VERSION } from "./constants.js";
import { registerAuthCommands } from "./commands/auth.js";
import { registerBrowserCommands } from "./commands/browser/index.js";
import { registerComputeCommand } from "./commands/compute.js";
import { registerDoctorComputeCommand } from "./commands/doctor-compute.js";
import { registerDoctorCookies } from "./commands/auth.js";
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
import { registerRunsCommand } from "./commands/runs.js";
import { registerDeliveryCommand } from "./commands/delivery.js";
import { registerApprovalsCommand } from "./commands/approvals.js";
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
import { registerExtractCommand } from "./commands/extract.js";
import { registerDoCommand } from "./commands/do.js";
import { registerSocialCommand } from "./commands/social.js";
import { registerPatentCommand } from "./commands/patent.js";
import { registerScholarCommand } from "./commands/scholar.js";
import { registerLintCommand } from "./commands/lint.js";
import { registerMigrateCommand } from "./commands/migrate.js";
import { registerMigrateSchemaCommand } from "./commands/migrate-schema.js";
import { registerAdapterDispatch } from "./commands/dispatch.js";
import { registerDescribeCommand } from "./commands/describe.js";
import { registerArchitectureCommand } from "./commands/architecture.js";
import { emitHook } from "./hooks.js";
import { checkForUpdates } from "./engine/update-check.js";
import { installProxyAwareFetch } from "./engine/proxy.js";
import type { OutputFormat } from "./types.js";
import { runBrowserDoctor } from "./browser/doctor.js";
import {
  handleCommanderError,
  installCommanderErrorBoundary,
} from "./output/commander-error.js";

export { handleCommanderError };

export async function createCli(): Promise<Command> {
  const program = new Command();

  installCommanderErrorBoundary(program);

  installProxyAwareFetch();

  // Non-blocking update check (fire-and-forget)
  checkForUpdates();

  program
    .name("unicli")
    .description("Open Agent-Computer Interface runtime for real software")
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
      "--permission-profile <profile>",
      "operation policy: open, confirm, locked (default: open; env: UNICLI_PERMISSION_PROFILE)",
    )
    .option(
      "--yes",
      "approve commands blocked by confirm/locked permission profiles",
    )
    .option(
      "--remember-approval",
      "remember this --yes approval for the same command capability scope",
    )
    .option(
      "--auth-retry",
      "on auth_required, refresh cookies from the local browser and retry once",
    )
    .option(
      "--record",
      "record an append-only run trace under ~/.unicli/runs (experimental)",
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
    )
    .option(
      "--pluck0 <field>",
      "emit a single field NUL-delimited (for `xargs -0`, wins over --pluck)",
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
    .option("--category <cat>", "filter by site category")
    .option("--type <type>", "filter by adapter type")
    .action((opts) => {
      const listStarted = Date.now();
      let commands = [
        ...listCommands(),
        ...listCoreDiscoveryCommands().map((command) => ({
          site: command.site,
          command: command.command,
          description: command.description,
          category: command.category,
          type: command.type,
          auth: false,
          quarantined: false,
        })),
      ];

      if (opts.site) {
        commands = commands.filter((c) => c.site.includes(opts.site));
      }
      if (opts.category) {
        commands = commands.filter((c) => c.category === opts.category);
      }
      if (opts.type) {
        commands = commands.filter((c) => c.type === opts.type);
      }
      commands = commands.sort(
        (a, b) =>
          a.site.localeCompare(b.site) || a.command.localeCompare(b.command),
      );

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
          category: c.category,
          type: c.type,
          auth: tags.join(" "),
        };
      });

      console.log(
        format(
          rows,
          ["site", "command", "description", "category", "type", "auth"],
          fmt,
          {
            command: "core.list",
            duration_ms: Date.now() - listStarted,
            surface: "web",
          },
        ),
      );
    });

  // Register "doctor" command
  const doctor = program
    .command("doctor")
    .description("Diagnose environment: adapters, browser runtime, tools")
    .action(async () => {
      console.log(chalk.bold("unicli doctor\n"));

      // 1. Basic info
      console.log(`  Adapters: ${chalk.green(adapterCount)}`);
      console.log(`  Sites:    ${chalk.green(getAllAdapters().length)}`);
      console.log(`  Node.js:  ${chalk.green(process.version)}`);
      console.log(`  Platform: ${chalk.green(process.platform)}`);
      console.log("");

      // 2. Browser Runtime Broker and lazy providers. This probe never starts
      // a broker or browser process.
      const browser = await runBrowserDoctor();
      const brokerLabel =
        browser.broker.state === "running"
          ? chalk.green("running")
          : browser.broker.state === "stopped"
            ? chalk.dim("stopped")
            : chalk.red("error");
      console.log(
        `  Broker:   ${brokerLabel}${browser.broker.broker_pid ? ` (pid ${String(browser.broker.broker_pid)})` : ""}`,
      );
      console.log(
        `  Managed:  ${browser.default_path.available ? chalk.green("ready") : chalk.yellow("needs action")} (${browser.default_path.visibility}, ${browser.default_path.profile_source})`,
      );
      console.log(
        `  Chrome:   ${browser.providers.chrome.connected ? chalk.green("connected") : chalk.dim("not connected")} (background provider)`,
      );
      console.log(
        `  Remote:   ${browser.providers.remote.configured ? chalk.green("configured") : chalk.dim("not configured")}`,
      );
      console.log(
        `  Sessions: ${String(browser.sessions.sessions.length)} live, ${String(browser.sessions.target_leases.length)} target lease(s)`,
      );

      // 3. Cookie directory
      const { existsSync, readdirSync } = await import("node:fs");
      const { getCookieDir } = await import("./engine/cookies.js");
      const cookieDir = getCookieDir();
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

      // 4. External tools
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

      // 5. Plugin directory
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
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
  registerDoctorComputeCommand(doctor);
  registerDoctorCookies(doctor);

  // Register auth commands — cookie management
  registerAuthCommands(program);

  // Register browser commands — broker-owned browser runtimes
  registerBrowserCommands(program);

  // Register compute commands — local app control cascade
  registerComputeCommand(program);

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

  // Register repair command — bounded original-command verification
  registerRepairCommand(program);

  // Register skills command — export adapter SKILL.md files for agent registries
  registerSkillsCommand(program);

  // Register usage command — read the command budget ledger
  registerUsageCommands(program);

  // Register runs command — inspect recorded run traces
  registerRunsCommand(program);

  // Register delivery command — objective-level trajectory and repair planning
  registerDeliveryCommand(program);

  // Register approvals command — inspect and revoke persisted permission grants
  registerApprovalsCommand(program);

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
  // One-shot URL → Markdown extraction (no browser session, no auth)
  registerExtractCommand(program);
  // Natural-language → best-fit adapter plan (HATEOAS; agent invokes next_actions[0])
  registerDoCommand(program);
  registerSocialCommand(program);

  // Register scholar command — academic vertical meta-command across first-source adapters
  registerScholarCommand(program);

  // Register patent command — patent-vertical meta-command across L0/L1/L2 adapters
  registerPatentCommand(program);

  // Register lint command — schema-v2 static validation
  registerLintCommand(program);

  // Register architecture command — callable system tree + rewrite audit
  registerArchitectureCommand(program);

  // Register describe command — runtime schema introspection for agents
  registerDescribeCommand(program);

  // Register adapter import helpers
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

          if (commandUsesBrowser(adapter, cmd)) {
            console.log(chalk.dim(`  ${cmdName}: skip (requires browser)`));
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
              {
                site: adapter.name,
                strategy: commandStrategy(adapter, cmd),
                domain: cmd.domain ?? adapter.domain,
              },
            );
            clearTimeout(timer);

            if (results.length > 0) {
              const shape = verifyRowShape(results, cmd.columns);
              console.log(
                chalk.green(`  ${cmdName}: ✓ (${results.length} results)`),
              );
              if (shape.dropped.length > 0) {
                console.log(
                  chalk.yellow(
                    `    ⚠ silent column drop: ${shape.dropped.join(", ")} declared but never populated`,
                  ),
                );
              }
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

  program.on("command:*", () => {
    const fmt = detectFormat(program.opts().format as OutputFormat | undefined);
    process.exitCode = ExitCode.USAGE_ERROR;
    process.stderr.write(
      format(null, undefined, fmt, {
        command: "core.unknown",
        duration_ms: 0,
        surface: "system",
        error: {
          code: "invalid_input",
          message: "unknown CLI command",
          suggestion: "run `unicli --help` or `unicli search <intent>`",
          exit_code: ExitCode.USAGE_ERROR,
          retryable: false,
          alternatives: ["unicli --help", "unicli search <intent>"],
        },
      }) + "\n",
    );
  });

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
