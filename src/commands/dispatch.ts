/**
 * Dynamic adapter command registration and execution dispatch.
 *
 * Extracted from cli.ts to keep that file below the complexity gate.
 * Owns: per-adapter Commander registration, quarantine gate, pipeline/TS
 * execution, v2 envelope format() wiring, and error handling.
 */

import { Command } from "commander";
import chalk from "chalk";
import { getAllAdapters } from "../registry.js";
import { runPipeline } from "../engine/executor.js";
import { resolveArgs } from "../engine/args.js";
import { hardenArgs, InputHardeningError } from "../engine/harden.js";
import { format, detectFormat } from "../output/formatter.js";
import {
  errorTypeToCode,
  mapErrorToExitCode,
  errorToAgentFields,
} from "../output/error-map.js";
import {
  defaultSuccessNextActions,
  defaultErrorNextActions,
} from "../output/next-actions.js";
import { recordUsage } from "../runtime/usage-ledger.js";
import { ExitCode } from "../types.js";
import type { OutputFormat } from "../types.js";
import type { AgentContext, AgentError } from "../output/envelope.js";

/**
 * Register one Commander sub-command per adapter×command.
 * Called once from createCli() after adapters are loaded.
 */
export function registerAdapterDispatch(program: Command): void {
  for (const adapter of getAllAdapters()) {
    const siteCmd = program
      .command(adapter.name)
      .description(
        adapter.description ??
          `Commands for ${adapter.displayName ?? adapter.name}`,
      );

    for (const [cmdName, cmd] of Object.entries(adapter.commands)) {
      let cmdStr = cmdName;

      // Register positional arguments from adapter definition
      const adapterArgs = cmd.adapterArgs ?? [];
      for (const arg of adapterArgs) {
        if (arg.positional) {
          cmdStr += arg.required ? ` <${arg.name}>` : ` [${arg.name}]`;
        }
      }

      // Quarantine gate — a command flagged `quarantine: true` in its YAML
      // has been proven broken by the adapter-health probe and must not run
      // until repaired. Still REGISTERED so `unicli <site> list` shows it
      // and the self-repair loop can target it. Bypass with
      // UNICLI_FORCE_QUARANTINE=1 for one-off debugging.
      const isQuarantined = cmd.quarantine === true;

      const descBase = cmd.description ?? "";
      const description = isQuarantined
        ? `[quarantined] ${descBase || "disabled by health gate"}${cmd.quarantineReason ? ` — ${cmd.quarantineReason}` : ""}`
        : descBase;
      const subCmd = siteCmd.command(cmdStr).description(description);

      // Register option arguments
      const registeredOpts = new Set<string>();
      subCmd.option("--limit <n>", "limit results", "20");
      registeredOpts.add("limit");

      for (const arg of adapterArgs) {
        if (!arg.positional && !registeredOpts.has(arg.name)) {
          const flag = `--${arg.name} <value>`;
          const desc = arg.description ?? "";
          registeredOpts.add(arg.name);
          if (arg.default !== undefined) {
            subCmd.option(flag, desc, String(arg.default));
          } else {
            subCmd.option(flag, desc);
          }
        }
      }

      subCmd.action(async (...actionArgs: unknown[]) => {
        const startedAt = Date.now();

        if (isQuarantined && process.env.UNICLI_FORCE_QUARANTINE !== "1") {
          const errCtx: AgentContext = {
            command: `${adapter.name}.${cmdName}`,
            duration_ms: Date.now() - startedAt,
            adapter_version: adapter.version,
            surface: "web",
            error: {
              code: "quarantined",
              message: `adapter ${adapter.name}.${cmdName} is quarantined${cmd.quarantineReason ? `: ${cmd.quarantineReason}` : ""}`,
              adapter_path: `src/adapters/${adapter.name}/${cmdName}.yaml`,
              step: 0,
              suggestion: `run \`unicli repair ${adapter.name} ${cmdName}\` or unset \`quarantine\` in the adapter YAML after fixing; override with UNICLI_FORCE_QUARANTINE=1 for one-off debugging`,
              retryable: false,
              alternatives: [`unicli repair ${adapter.name} ${cmdName}`],
            },
          };
          const fmt = detectFormat(
            (program.opts().format ?? cmd.defaultFormat) as
              | OutputFormat
              | undefined,
          );
          process.stderr.write(format([], cmd.columns, fmt, errCtx) + "\n");
          recordUsage({
            site: adapter.name,
            cmd: cmdName,
            strategy: adapter.strategy ?? "unknown",
            tokens: 0,
            ms: Date.now() - startedAt,
            bytes: 0,
            exit: ExitCode.CONFIG_ERROR,
          });
          process.exit(ExitCode.CONFIG_ERROR);
        }

        // Commander passes positional args first, then opts object, then Command
        const opts = actionArgs[actionArgs.length - 2] as Record<
          string,
          string
        >;
        const positionals = actionArgs.slice(
          0,
          actionArgs.length - 2,
        ) as string[];

        const fmt = detectFormat(
          (program.opts().format ?? cmd.defaultFormat) as
            | OutputFormat
            | undefined,
        );

        // Unified arg resolver (v0.213.2): precedence is stdin-JSON >
        // --args-file > shell flags > positional args > adapter defaults.
        // Externalizes state out of shell quoting (TC0-bounded) into JSON.
        const rootOpts = program.opts() as {
          argsFile?: string;
          dryRun?: boolean;
        };
        let resolved: Awaited<ReturnType<typeof resolveArgs>>;
        try {
          resolved = resolveArgs({
            opts,
            positionals,
            schema: adapterArgs,
            argsFile: rootOpts.argsFile,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(chalk.red(msg));
          process.exit(ExitCode.USAGE_ERROR);
        }

        const mergedArgs: Record<string, unknown> = { ...resolved.args };
        if (mergedArgs.limit === undefined) {
          mergedArgs.limit = parseInt(opts.limit, 10) || 20;
        }

        // Input hardening — Poehnelt pattern. Agents hallucinate control
        // chars / path traversals / double-encoded URLs; validate at the
        // boundary before any adapter step sees the value.
        let hardenWarnings: string[] = [];
        try {
          const result = hardenArgs(mergedArgs, adapterArgs);
          hardenWarnings = result.warnings;
        } catch (err) {
          if (err instanceof InputHardeningError) {
            const errCtx: AgentContext = {
              command: `${adapter.name}.${cmdName}`,
              duration_ms: Date.now() - startedAt,
              adapter_version: adapter.version,
              surface: "web",
              error: {
                code: "invalid_input",
                message: err.message,
                adapter_path: `src/adapters/${adapter.name}/${cmdName}.yaml`,
                step: 0,
                suggestion: err.suggestion,
                retryable: false,
              },
              next_actions: defaultErrorNextActions(
                adapter.name,
                cmdName,
                "invalid_input",
              ),
            };
            process.stderr.write(format([], cmd.columns, fmt, errCtx) + "\n");
            process.exit(ExitCode.USAGE_ERROR);
          }
          throw err;
        }
        for (const w of hardenWarnings) {
          process.stderr.write(chalk.yellow(`[harden] ${w}\n`));
        }

        if (rootOpts.dryRun) {
          const plan = {
            command: `${adapter.name}.${cmdName}`,
            adapter_type: adapter.type,
            strategy: adapter.strategy ?? null,
            args: mergedArgs,
            args_source: resolved.source,
            pipeline_steps: cmd.pipeline?.length ?? 0,
            adapter_path: `src/adapters/${adapter.name}/${cmdName}.yaml`,
          };
          console.log(JSON.stringify(plan, null, 2));
          process.exit(ExitCode.SUCCESS);
        }

        try {
          let results: unknown[];

          if (cmd.pipeline) {
            results = await runPipeline(
              cmd.pipeline,
              mergedArgs,
              adapter.base,
              {
                site: adapter.name,
                strategy: adapter.strategy,
              },
            );
          } else if (cmd.func) {
            const raw = await cmd.func(null as never, mergedArgs);
            results = Array.isArray(raw) ? raw : [raw];
          } else {
            console.error(
              chalk.red("No pipeline or function defined for this command"),
            );
            process.exit(ExitCode.CONFIG_ERROR);
          }

          const ctx: AgentContext = {
            command: `${adapter.name}.${cmdName}`,
            duration_ms: Date.now() - startedAt,
            adapter_version: adapter.version,
            surface: "web",
            next_actions: defaultSuccessNextActions(adapter.name, cmdName),
          };
          const rendered = format(results, cmd.columns, fmt, ctx);
          console.log(rendered);
          const exitCode =
            results.length === 0 ? ExitCode.EMPTY_RESULT : ExitCode.SUCCESS;
          recordUsage({
            site: adapter.name,
            cmd: cmdName,
            strategy: adapter.strategy ?? "unknown",
            tokens: 0,
            ms: Date.now() - startedAt,
            bytes: Buffer.byteLength(rendered, "utf-8"),
            exit: exitCode,
          });
          process.exit(exitCode);
        } catch (err) {
          const adapterPath = `src/adapters/${adapter.name}/${cmdName}.yaml`;
          const fields = errorToAgentFields(err, adapterPath, adapter.name);
          const agentErr: AgentError = {
            code: errorTypeToCode(err),
            message: err instanceof Error ? err.message : String(err),
            ...fields,
          };
          const errCtx: AgentContext = {
            command: `${adapter.name}.${cmdName}`,
            duration_ms: Date.now() - startedAt,
            adapter_version: adapter.version,
            surface: "web",
            error: agentErr,
            next_actions: defaultErrorNextActions(
              adapter.name,
              cmdName,
              agentErr.code,
            ),
          };
          const rendered = format([], cmd.columns, fmt, errCtx);
          process.stderr.write(rendered + "\n");
          const exitCode = mapErrorToExitCode(err);
          recordUsage({
            site: adapter.name,
            cmd: cmdName,
            strategy: adapter.strategy ?? "unknown",
            tokens: 0,
            ms: Date.now() - startedAt,
            bytes: 0,
            exit: exitCode,
          });
          process.exit(exitCode);
        }
      });
    }
  }
}
