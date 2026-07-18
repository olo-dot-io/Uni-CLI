/**
 * @owner       src::commands::dispatch
 * @does        Registers adapter CLI commands, resolves shell/file/stdin arguments, invokes the shared kernel, and applies CLI-only projection/exit semantics.
 * @needs       adapter registry, argument resolver, permission runtime, invocation kernel, output projection and formatter
 * @feeds       full Commander CLI adapter surface
 * @breaks      Bypassing the shared kernel or emitting raw failures breaks CLI/MCP/ACP parity and local invocation evidence.
 * @invariants  Kernel owns adapter execution; this module owns only CLI parsing, quarantine/dry-run gates, rendering, projection, and final exit.
 * @side-effects Registers commands, may refresh browser cookies, writes stdout/stderr, and terminates adapter CLI processes.
 * @perf        Registers once per loaded adapter command; each invocation performs one kernel call plus optional auth retry.
 * @concurrency One Commander action per CLI process; shared browser/kernel components own their own concurrency.
 * @test        tests/unit/commands/dispatch.test.ts and tests/unit/cli/*
 * @stability   stable
 * @since       2026-04-04
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
 *   - Rendering CLI-specific projection and terminal exit semantics
 */

import { Command, Option } from "commander";
import chalk from "chalk";
import { commandStrategy, getAllAdapters } from "../registry.js";
import { resolveArgs } from "../engine/args.js";
import { buildInvocation, execute } from "../engine/kernel/execute.js";
import { executeWithRunRecording } from "../engine/session/run-loop.js";
import {
  InvalidPermissionProfileError,
  resolveOperationAdapterPath,
  resolveOperationTargetSurface,
} from "../engine/operation-policy.js";
import type { OperationPolicy } from "../engine/operation-policy.js";
import { evaluateOperationPolicyWithApprovals } from "../engine/permission-runtime.js";
import { PermissionRulesConfigError } from "../engine/permission-rules.js";
import { format, detectFormat } from "../output/formatter.js";
import {
  applyProjection,
  renderPluck,
  renderPluck0,
  ProjectionError,
} from "../output/projection.js";
import { ExitCode } from "../types.js";
import { refreshCookiesFromBrowser } from "../engine/cookies.js";
import {
  annotateAuthRetryFailure,
  shouldRefreshAuthError,
} from "../output/auth-guidance.js";
import type { AdapterArg, OutputFormat } from "../types.js";
import type { AgentContext } from "../output/envelope.js";

export function allowsDashPrefixedPositionals(
  adapterArgs: AdapterArg[],
): boolean {
  return adapterArgs.some((arg) => arg.positional === true);
}

export function findAmbiguousLongOptionPositional(
  positionals: unknown[],
): string | undefined {
  return positionals.find(
    (arg): arg is string => typeof arg === "string" && arg.startsWith("--"),
  );
}

export function normalizeAdapterOptionValues(
  values: Record<string, string>,
  args: readonly AdapterArg[],
): Record<string, string> {
  const normalized = { ...values };
  for (const arg of args) {
    if (arg.positional || !arg.name.includes("_")) continue;
    const canonicalAttribute = arg.name.replace(/_([a-z0-9])/g, (_, char) =>
      String(char).toUpperCase(),
    );
    if (values[canonicalAttribute] !== undefined) {
      normalized[arg.name] = values[canonicalAttribute];
    }
    delete normalized[canonicalAttribute];
  }
  return normalized;
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
          const canonicalName = arg.name.replaceAll("_", "-");
          const flag = `--${canonicalName} <value>`;
          const desc = arg.description ?? "";
          registeredOpts.add(arg.name);
          subCmd.option(flag, desc);
          if (canonicalName !== arg.name) {
            subCmd.addOption(
              new Option(`--${arg.name} <value>`, desc).hideHelp(),
            );
          }
        }
      }

      subCmd.action(async (...actionArgs: unknown[]) => {
        const startedAt = Date.now();
        const targetSurface = resolveOperationTargetSurface({
          adapterType: adapter.type,
          targetSurface: cmd.target_surface,
        });
        const adapterPath = resolveOperationAdapterPath(
          adapter.name,
          cmdName,
          cmd.adapter_path,
        );

        if (isQuarantined && process.env.UNICLI_FORCE_QUARANTINE !== "1") {
          const errCtx: AgentContext = {
            command: `${adapter.name}.${cmdName}`,
            duration_ms: Date.now() - startedAt,
            adapter_version: adapter.version,
            surface: targetSurface,
            error: {
              code: "quarantined",
              message: `adapter ${adapter.name}.${cmdName} is quarantined${cmd.quarantineReason ? `: ${cmd.quarantineReason}` : ""}`,
              adapter_path: adapterPath,
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
          process.exit(ExitCode.CONFIG_ERROR);
        }

        // Commander passes positional args first, then opts object, then Command
        const opts = normalizeAdapterOptionValues(
          actionArgs[actionArgs.length - 2] as Record<string, string>,
          adapterArgs,
        );
        const positionals = actionArgs
          .slice(0, actionArgs.length - 2)
          .filter((arg): arg is string => typeof arg === "string");
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
          permissionProfile?: string;
          yes?: boolean;
          rememberApproval?: boolean;
          authRetry?: boolean;
          record?: boolean;
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

        const inv = buildInvocation(
          "cli",
          adapter.name,
          cmdName,
          {
            args: mergedArgs,
            source: resolved.source,
            stdinRaw: resolved.stdinRaw,
          },
          {
            permissionProfile: rootOpts.permissionProfile,
            approved: rootOpts.yes === true,
            rememberApproval: rootOpts.rememberApproval === true,
            operationRole: "direct",
          },
        );

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
          let operationPolicy: OperationPolicy;
          try {
            operationPolicy = await evaluateOperationPolicyWithApprovals({
              site: adapter.name,
              command: cmdName,
              description: cmd.description,
              adapterType: adapter.type,
              targetSurface,
              strategy,
              browser: adapter.browser === true || cmd.browser === true,
              args: adapterArgs,
              profile: rootOpts.permissionProfile,
              approved: rootOpts.yes === true,
              argumentValues: mergedArgs,
            });
          } catch (err) {
            if (
              err instanceof InvalidPermissionProfileError ||
              err instanceof PermissionRulesConfigError
            ) {
              const errCtx: AgentContext = {
                command: `${adapter.name}.${cmdName}`,
                duration_ms: Date.now() - startedAt,
                adapter_version: adapter.version,
                surface: targetSurface,
                error: {
                  code: "invalid_input",
                  message: err.message,
                  adapter_path: adapterPath,
                  step: 0,
                  suggestion:
                    err instanceof PermissionRulesConfigError
                      ? err.suggestion
                      : "use one of: open, confirm, locked",
                  retryable: false,
                },
              };
              process.stderr.write(format([], cmd.columns, fmt, errCtx) + "\n");
              process.exit(ExitCode.USAGE_ERROR);
            }
            throw err;
          }
          const plan = {
            command: `${adapter.name}.${cmdName}`,
            adapter_type: adapter.type,
            strategy: strategy ?? null,
            args: mergedArgs,
            args_source: resolved.source,
            operation_policy: operationPolicy,
            trace_id: inv.trace_id,
            surface: inv.surface,
            target_surface: targetSurface,
            pipeline_steps: cmd.pipeline?.length ?? 0,
            adapter_path: adapterPath,
          };
          console.log(JSON.stringify(plan, null, 2));
          process.exit(ExitCode.SUCCESS);
        }

        const runInvocation = () =>
          rootOpts.record === true || process.env.UNICLI_RECORD_RUN === "1"
            ? executeWithRunRecording(inv, {
                enabled: rootOpts.record === true ? true : undefined,
              })
            : execute(inv);

        let result = await runInvocation();
        if (
          rootOpts.authRetry === true &&
          shouldRefreshAuthError(result.error?.code)
        ) {
          const refresh = await refreshCookiesFromBrowser(
            adapter.name,
            cmd.domain ?? adapter.domain,
            { preferCdp: result.error?.code === "challenge_required" },
          );
          if (refresh.ok) {
            process.stderr.write(
              chalk.yellow(
                `[auth] refreshed ${refresh.cookieCount ?? 0} cookie(s) from ${refresh.source}; retrying ${adapter.name}.${cmdName}\n`,
              ),
            );
            result = await runInvocation();
          } else {
            annotateAuthRetryFailure(result, refresh.suggestion, adapter.name);
          }
        }

        // Surface harden warnings the same way the pre-R2 path did —
        // yellow `[harden] …` lines on stderr, above any output envelope.
        for (const w of result.warnings) {
          process.stderr.write(chalk.yellow(`[harden] ${w}\n`));
        }

        if (result.error) {
          process.stderr.write(
            format([], cmd.columns, fmt, result.envelope) + "\n",
          );
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
        process.exit(finalExit);
      });
    }
  }
}
