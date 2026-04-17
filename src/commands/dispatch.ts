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
import { runPipeline, PipelineError } from "../engine/executor.js";
import { BridgeConnectionError } from "../browser/bridge.js";
import { format, detectFormat } from "../output/formatter.js";
import { recordUsage } from "../runtime/usage-ledger.js";
import { ExitCode } from "../types.js";
import type { OutputFormat } from "../types.js";
import type { AgentContext, AgentError } from "../output/envelope.js";

/**
 * Map a caught error to an AgentError code string following the self-repair
 * contract. Covers the most common pipeline / network / HTTP failure modes.
 */
function errorTypeToCode(err: unknown): string {
  if (err instanceof PipelineError) {
    const { errorType, statusCode } = err.detail;
    if (
      statusCode === 401 ||
      statusCode === 403 ||
      (errorType === "http_error" && (statusCode === 401 || statusCode === 403))
    )
      return "auth_required";
    if (statusCode === 404) return "not_found";
    if (statusCode === 429) return "rate_limited";
    if (errorType === "selector_miss") return "selector_miss";
    if (errorType === "empty_result") return "empty_result";
    if (errorType === "timeout") return "network_error";
    return "internal_error";
  }
  const message = err instanceof Error ? err.message : String(err);
  if (
    /ETIMEDOUT|ENOTFOUND|ECONNREFUSED|ECONNRESET|socket hang up/i.test(message)
  )
    return "network_error";
  if (/401|403|auth/i.test(message)) return "auth_required";
  if (/404/i.test(message)) return "not_found";
  if (/429|rate.?limit/i.test(message)) return "rate_limited";
  return "internal_error";
}

/** Map a caught error to the appropriate sysexits exit code. */
function mapErrorToExitCode(err: unknown): number {
  if (err instanceof PipelineError) {
    const { errorType, statusCode } = err.detail;
    if (statusCode === 401 || statusCode === 403) return ExitCode.AUTH_REQUIRED;
    if (errorType === "empty_result") return ExitCode.EMPTY_RESULT;
    return ExitCode.GENERIC_ERROR;
  }
  if (err instanceof BridgeConnectionError) return ExitCode.SERVICE_UNAVAILABLE;
  const message = err instanceof Error ? err.message : String(err);
  if (
    /ETIMEDOUT|ENOTFOUND|ECONNREFUSED|ECONNRESET|socket hang up|daemon failed/i.test(
      message,
    )
  )
    return ExitCode.TEMP_FAILURE;
  return ExitCode.GENERIC_ERROR;
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
          const envelope = {
            ok: false,
            error: {
              transport: "http" as const,
              adapter_path: `${adapter.name}/${cmdName}`,
              step: 0,
              action: cmdName,
              reason: `adapter ${adapter.name}.${cmdName} is quarantined${cmd.quarantineReason ? `: ${cmd.quarantineReason}` : ""}`,
              suggestion: `run \`unicli repair ${adapter.name} ${cmdName}\` or unset \`quarantine\` in the adapter YAML after fixing; override with UNICLI_FORCE_QUARANTINE=1 for one-off debugging`,
              minimum_capability: "repair.quarantine",
              retryable: false,
              exit_code: ExitCode.CONFIG_ERROR,
            },
          };
          process.stderr.write(JSON.stringify(envelope) + "\n");
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

        // Build merged args from positional + option args
        const mergedArgs: Record<string, unknown> = {
          limit: parseInt(opts.limit, 10) || 20,
        };

        let posIdx = 0;
        for (const arg of adapterArgs) {
          if (arg.positional && posIdx < positionals.length) {
            mergedArgs[arg.name] = positionals[posIdx++];
          }
        }

        for (const arg of adapterArgs) {
          if (!arg.positional && opts[arg.name] !== undefined) {
            mergedArgs[arg.name] =
              arg.type === "int"
                ? parseInt(opts[arg.name], 10)
                : opts[arg.name];
          } else if (
            !arg.positional &&
            arg.default !== undefined &&
            mergedArgs[arg.name] === undefined
          ) {
            mergedArgs[arg.name] = arg.default;
          }
        }

        if (opts.limit) {
          mergedArgs.limit = parseInt(opts.limit, 10) || 20;
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
          const agentErr: AgentError = {
            code: errorTypeToCode(err),
            message: err instanceof Error ? err.message : String(err),
            adapter_path:
              err instanceof PipelineError ? adapterPath : undefined,
            step: err instanceof PipelineError ? err.detail.step : undefined,
            suggestion:
              err instanceof PipelineError
                ? err.detail.suggestion
                : err instanceof BridgeConnectionError
                  ? err.suggestion
                  : `Run 'unicli test ${adapter.name}' to diagnose, or report this error.`,
            retryable:
              err instanceof PipelineError
                ? (err.detail.retryable ?? false)
                : err instanceof BridgeConnectionError
                  ? err.retryable
                  : /timeout|ETIMEDOUT|ECONNREFUSED|ECONNRESET|socket hang up|daemon failed/i.test(
                      err instanceof Error ? err.message : String(err),
                    ),
            alternatives:
              err instanceof PipelineError
                ? (err.detail.alternatives ?? [])
                : err instanceof BridgeConnectionError
                  ? err.alternatives
                  : [],
          };
          const errCtx: AgentContext = {
            command: `${adapter.name}.${cmdName}`,
            duration_ms: Date.now() - startedAt,
            adapter_version: adapter.version,
            surface: "web",
            error: agentErr,
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
