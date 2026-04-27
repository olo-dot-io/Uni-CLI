/**
 * Dynamic adapter command registration and execution dispatch.
 *
 * v0.213.3 R2: dispatch.ts is now a thin wrapper that parses Commander
 * state into a `ResolvedArgs` bag and hands it to the invocation kernel
 * (`execute()`). The kernel owns schema validation, input hardening,
 * pipeline execution, and envelope construction — so MCP / ACP / CLI all
 * produce byte-identical results for the same input.
 *
 * Responsibilities kept in this module:
 *   - Commander sub-command registration (one per adapter × command)
 *   - Quarantine gate (adapter-health veto before the kernel even runs)
 *   - `--dry-run` plan printer
 *   - Rendering the InvocationResult via format() and exiting with the
 *     kernel-supplied exit code
 *   - Emitting harden warnings from InvocationResult.warnings to stderr
 *   - Usage-ledger recording
 */

import { Command } from "commander";
import chalk from "chalk";
import { commandStrategy, getAllAdapters } from "../registry.js";
import { resolveArgs } from "../engine/args.js";
import { buildInvocation, execute } from "../engine/kernel/execute.js";
import { format, detectFormat } from "../output/formatter.js";
import {
  applyProjection,
  renderPluck,
  renderPluck0,
  ProjectionError,
} from "../output/projection.js";
import { recordUsage } from "../runtime/usage-ledger.js";
import { ExitCode } from "../types.js";
import type { AdapterArg, OutputFormat } from "../types.js";
import type { AgentContext } from "../output/envelope.js";

export function allowsDashPrefixedPositionals(
  adapterArgs: AdapterArg[],
): boolean {
  return adapterArgs.some((arg) => arg.positional === true);
}

export function findAmbiguousLongOptionPositional(
  positionals: string[],
): string | undefined {
  return positionals.find((arg) => arg.startsWith("--"));
}

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
      const strategy = commandStrategy(adapter, cmd);
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
      if (allowsDashPrefixedPositionals(adapterArgs)) {
        subCmd.allowUnknownOption();
      }

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
            strategy: strategy ?? "unknown",
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
        const ambiguousLongOption =
          findAmbiguousLongOptionPositional(positionals);
        if (ambiguousLongOption) {
          console.error(
            chalk.red(
              `ambiguous positional value ${ambiguousLongOption}: values starting with "--" must be passed via --args-file or stdin JSON`,
            ),
          );
          process.exit(ExitCode.USAGE_ERROR);
        }

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
          select?: string;
          fields?: string;
          pluck?: string;
          pluck0?: string;
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
        // Commander registers a `--limit` option on EVERY adapter sub-
        // command regardless of declaration. With ajv strict mode on the
        // kernel, we must only forward `limit` when the adapter actually
        // declares it — otherwise every non-paginating command fails
        // validation with `additionalProperties`.
        const declaresLimit = adapterArgs.some((a) => a.name === "limit");
        if (declaresLimit && mergedArgs.limit === undefined) {
          mergedArgs.limit = parseInt(opts.limit, 10) || 20;
        } else if (!declaresLimit) {
          delete mergedArgs.limit;
        }

        const inv = buildInvocation("cli", adapter.name, cmdName, {
          args: mergedArgs,
          source: resolved.source,
          stdinRaw: resolved.stdinRaw,
        });

        // `buildInvocation` only returns null for unknown (site, cmd). We
        // came from iterating `getAllAdapters()` so that cannot happen, but
        // TypeScript demands we narrow.
        if (!inv) {
          console.error(
            chalk.red(
              `internal error: adapter ${adapter.name}.${cmdName} not registered`,
            ),
          );
          process.exit(ExitCode.CONFIG_ERROR);
        }

        if (rootOpts.dryRun) {
          const plan = {
            command: `${adapter.name}.${cmdName}`,
            adapter_type: adapter.type,
            strategy: strategy ?? null,
            args: mergedArgs,
            args_source: resolved.source,
            trace_id: inv.trace_id,
            surface: inv.surface,
            pipeline_steps: cmd.pipeline?.length ?? 0,
            adapter_path: `src/adapters/${adapter.name}/${cmdName}.yaml`,
          };
          console.log(JSON.stringify(plan, null, 2));
          process.exit(ExitCode.SUCCESS);
        }

        const result = await execute(inv);

        // Surface harden warnings the same way the pre-R2 path did —
        // yellow `[harden] …` lines on stderr, above any output envelope.
        for (const w of result.warnings) {
          process.stderr.write(chalk.yellow(`[harden] ${w}\n`));
        }

        if (result.error) {
          process.stderr.write(
            format([], cmd.columns, fmt, result.envelope) + "\n",
          );
          recordUsage({
            site: adapter.name,
            cmd: cmdName,
            strategy: strategy ?? "unknown",
            tokens: 0,
            ms: result.durationMs,
            bytes: 0,
            exit: result.exitCode,
          });
          process.exit(result.exitCode);
        }

        // Output-side projection (v0.213.3 P3). Applied BEFORE format() so
        // every envelope format benefits. --pluck / --pluck0 short-circuit
        // the formatter entirely and emit a plain-text stream (newline or
        // NUL delimited).
        let projection;
        try {
          projection = applyProjection(result.results, {
            select: rootOpts.select,
            fields: rootOpts.fields,
            pluck: rootOpts.pluck,
            pluck0: rootOpts.pluck0,
          });
        } catch (err) {
          if (err instanceof ProjectionError) {
            process.stderr.write(`[projection] ${err.message}\n`);
            recordUsage({
              site: adapter.name,
              cmd: cmdName,
              strategy: strategy ?? "unknown",
              tokens: 0,
              ms: result.durationMs,
              bytes: 0,
              exit: ExitCode.USAGE_ERROR,
            });
            process.exit(ExitCode.USAGE_ERROR);
          }
          throw err;
        }

        let rendered: string;
        let finalExit = result.exitCode;
        if (projection.pluck0Mode) {
          rendered = renderPluck0(projection.results, rootOpts.pluck0!);
        } else if (projection.pluckMode) {
          rendered = renderPluck(projection.results, rootOpts.pluck!);
        } else {
          rendered = format(
            projection.results,
            projection.columns ?? cmd.columns,
            fmt,
            result.envelope,
          );
        }

        // IM2: --select / --pluck / --pluck0 can reduce a non-empty kernel
        // result to zero rows. Kernel exit code is agnostic to projection
        // (so MCP / ACP keep their own behavior); the CLI post-projection
        // sees the final shape and overrides with EMPTY_RESULT (66).
        if (
          finalExit === ExitCode.SUCCESS &&
          (projection.pluck0Mode ||
            projection.pluckMode ||
            rootOpts.select !== undefined) &&
          projection.results.length === 0
        ) {
          finalExit = ExitCode.EMPTY_RESULT;
        }

        console.log(rendered);
        recordUsage({
          site: adapter.name,
          cmd: cmdName,
          strategy: strategy ?? "unknown",
          tokens: 0,
          ms: result.durationMs,
          bytes: Buffer.byteLength(rendered, "utf-8"),
          exit: finalExit,
        });
        process.exit(finalExit);
      });
    }
  }
}
