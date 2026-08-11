/**
 * Agent-facing harness evolution workflow.
 *
 * An upstream agent edits one isolated YAML candidate. Uni-CLI owns the run
 * evidence, paired execution, promotion gate, local overlay update, and
 * conflict-safe rollback.
 */

import type { Command } from "commander";

import { resolveCommand } from "../registry.js";
import {
  createAdapterEvolutionSession,
  createEvolutionStore,
  EvolutionError,
  listEvolutionSessions,
  promoteEvolutionSession,
  readEvolutionSession,
  rollbackEvolutionSession,
  verifyEvolutionSession,
  type EvolutionPrediction,
  type EvolutionSession,
} from "../engine/evolution/index.js";
import { createRunStore } from "../engine/session/store.js";
import { detectFormat, format } from "../output/formatter.js";
import { makeCtx, type AgentContext } from "../output/envelope.js";
import { printErrorEnvelope } from "../output/error-writer.js";
import { ExitCode, type OutputFormat } from "../types.js";

interface EvolveCommonOptions {
  root?: string;
}

interface PredictionOptions {
  hypothesis?: string;
  expect?: string[];
  risk?: string[];
}

interface EvolveAdapterOptions extends EvolveCommonOptions, PredictionOptions {
  run: string[];
  validationRun?: string[];
  heldOutRun?: string[];
  validation?: string[];
  heldOut?: string[];
  model?: string[];
  domain?: string;
  candidate?: string;
  runRoot?: string;
  cli?: string;
  timeout?: string;
  sessionId?: string;
  allowMutationEval?: boolean;
  promote?: boolean;
}

interface EvolveVerifyOptions extends EvolveCommonOptions, PredictionOptions {
  validation?: string[];
  heldOut?: string[];
  cli?: string;
  timeout?: string;
  allowMutationEval?: boolean;
  promote?: boolean;
}

function outputFormat(program: Command): OutputFormat {
  return detectFormat(program.opts().format as OutputFormat | undefined);
}

function emit(
  program: Command,
  command: string,
  startedAt: number,
  data: Record<string, unknown>,
  configure?: (context: AgentContext) => void,
): void {
  const context = makeCtx(command, startedAt);
  configure?.(context);
  context.duration_ms = Date.now() - startedAt;
  console.log(format(data, undefined, outputFormat(program), context));
}

function emitError(
  program: Command,
  command: string,
  startedAt: number,
  error: unknown,
): void {
  const mapped = evolutionCliError(error);
  printErrorEnvelope({
    fmt: outputFormat(program),
    exitCode: mapped.exitCode,
    ctx: {
      ...makeCtx(command, startedAt),
      error: {
        code: mapped.code,
        message: mapped.message,
        ...(mapped.path ? { adapter_path: mapped.path } : {}),
        suggestion: mapped.suggestion,
        retryable: false,
        exit_code: mapped.exitCode,
      },
    },
  });
  process.exitCode = mapped.exitCode;
}

export function registerEvolveCommand(program: Command): void {
  const evolve = program
    .command("evolve")
    .description(
      "Turn run evidence into a scoped adapter candidate and verified promotion",
    );

  evolve
    .command("adapter <site> <command>")
    .description(
      "Stage an adapter candidate, verify it when supplied, and optionally promote it",
    )
    .requiredOption(
      "--run <run_ids...>",
      "Recorded runs used as proposal evidence",
    )
    .option(
      "--validation-run <run_ids...>",
      "Recorded runs used only for candidate validation",
    )
    .option(
      "--held-out-run <run_ids...>",
      "Recorded runs withheld for transfer evaluation",
    )
    .option(
      "--validation <eval_targets...>",
      "Validation eval files or directories",
    )
    .option(
      "--held-out <eval_targets...>",
      "Held-out eval files or directories",
    )
    .option("--model <names...>", "Models for which the candidate is intended")
    .option("--domain <name>", "Task-domain scope")
    .option(
      "--candidate <path>",
      "Stage and immediately verify this YAML candidate",
    )
    .option("--hypothesis <text>", "Falsifiable explanation for the candidate")
    .option("--expect <case_ids...>", "Validation cases predicted to improve")
    .option("--risk <case_ids...>", "Cases most likely to regress")
    .option("--promote", "Promote the candidate only when the gate accepts it")
    .option("--run-root <path>", "Override recorded run root")
    .option("--root <path>", "Override evolution session root")
    .option("--cli <command>", "CLI command used for paired evaluation")
    .option("--timeout <ms>", "Per-case evaluation timeout", "30000")
    .option("--session-id <id>", "Use a caller-selected evolution session id")
    .option(
      "--allow-mutation-eval",
      "Allow evaluation of commands that can change external state",
    )
    .action(
      async (site: string, commandName: string, opts: EvolveAdapterOptions) => {
        const startedAt = Date.now();
        try {
          if (opts.promote && !opts.candidate) {
            throw new EvolutionError(
              "candidate_invalid",
              "--promote requires --candidate",
            );
          }
          const resolved = resolveCommand(site, commandName);
          if (!resolved) {
            throw new EvolutionError(
              "source_not_found",
              `adapter command is not registered: ${site}.${commandName}`,
            );
          }
          const store = createEvolutionStore({ rootDir: opts.root });
          const prediction = parsePrediction(opts);
          const session = await createAdapterEvolutionSession({
            evolutionStore: store,
            runStore: createRunStore({ rootDir: opts.runRoot }),
            site,
            command: commandName,
            adapterCommand: resolved.command,
            proposalRunIds: opts.run,
            validationRunIds: opts.validationRun,
            heldOutRunIds: opts.heldOutRun,
            validationEvalTargets: opts.validation,
            heldOutEvalTargets: opts.heldOut,
            modelAffinity: opts.model,
            domain: opts.domain,
            permissionProfile: program.opts().permissionProfile as
              | string
              | undefined,
            candidatePath: opts.candidate,
            sessionId: opts.sessionId,
            cliCommand: opts.cli,
            timeoutMs: parseTimeout(opts.timeout),
            allowMutationEval: opts.allowMutationEval,
            prediction,
          });
          if (!opts.candidate) {
            emit(
              program,
              "evolve.adapter",
              startedAt,
              projectSession(session),
              (context) => {
                context.next_actions = [
                  {
                    command: `unicli evolve verify ${session.session_id} --hypothesis <text> --expect <case_ids...>`,
                    description:
                      "Verify the isolated candidate after editing it",
                  },
                ];
              },
            );
            return;
          }

          const verified = await verifyEvolutionSession({
            store,
            sessionId: session.session_id,
            adapterCommand: resolved.command,
          });
          const promoted =
            opts.promote && verified.report.decision.eligible
              ? await promoteEvolutionSession({
                  store,
                  sessionId: session.session_id,
                })
              : undefined;
          emitEvolutionResult(
            program,
            "evolve.adapter",
            startedAt,
            promoted?.session ?? verified.session,
            verified.report,
            promoted?.promotion,
          );
        } catch (error) {
          emitError(program, "evolve.adapter", startedAt, error);
        }
      },
    );

  evolve
    .command("verify <session_id>")
    .description("Verify an edited staged candidate and optionally promote it")
    .option("--validation <eval_targets...>", "Add validation eval targets")
    .option("--held-out <eval_targets...>", "Add held-out eval targets")
    .option("--hypothesis <text>", "Falsifiable explanation for the candidate")
    .option("--expect <case_ids...>", "Validation cases predicted to improve")
    .option("--risk <case_ids...>", "Cases most likely to regress")
    .option("--promote", "Promote the candidate only when the gate accepts it")
    .option("--root <path>", "Override evolution session root")
    .option("--cli <command>", "CLI command used for paired evaluation")
    .option("--timeout <ms>", "Per-case evaluation timeout")
    .option(
      "--allow-mutation-eval",
      "Allow evaluation of commands that can change external state",
    )
    .action(async (sessionId: string, opts: EvolveVerifyOptions) => {
      const startedAt = Date.now();
      try {
        const store = createEvolutionStore({ rootDir: opts.root });
        const session = await readEvolutionSession(store, sessionId);
        if (reusesVerifiedAttempt(session, opts)) {
          const promoted = await promoteEvolutionSession({ store, sessionId });
          emitEvolutionResult(
            program,
            "evolve.verify",
            startedAt,
            promoted.session,
            promoted.report,
            promoted.promotion,
          );
          return;
        }
        const resolved = resolveCommand(
          session.component.site,
          session.component.command,
        );
        if (!resolved) {
          throw new EvolutionError(
            "invalid_case",
            `adapter command is not registered: ${session.component.site}.${session.component.command}`,
          );
        }
        const verified = await verifyEvolutionSession({
          store,
          sessionId,
          adapterCommand: resolved.command,
          validationEvalTargets: opts.validation,
          heldOutEvalTargets: opts.heldOut,
          cliCommand: opts.cli,
          ...(opts.timeout ? { timeoutMs: parseTimeout(opts.timeout) } : {}),
          allowMutationEval: opts.allowMutationEval,
          prediction: parsePrediction(opts),
        });
        const promoted =
          opts.promote && verified.report.decision.eligible
            ? await promoteEvolutionSession({ store, sessionId })
            : undefined;
        emitEvolutionResult(
          program,
          "evolve.verify",
          startedAt,
          promoted?.session ?? verified.session,
          verified.report,
          promoted?.promotion,
        );
      } catch (error) {
        emitError(program, "evolve.verify", startedAt, error);
      }
    });

  evolve
    .command("rollback <session_id>")
    .description("Restore the adapter state that preceded promotion")
    .option("--root <path>", "Override evolution session root")
    .action(async (sessionId: string, opts: EvolveCommonOptions) => {
      const startedAt = Date.now();
      try {
        const result = await rollbackEvolutionSession({
          store: createEvolutionStore({ rootDir: opts.root }),
          sessionId,
        });
        emit(program, "evolve.rollback", startedAt, {
          session: projectSession(result.session),
          destination: result.destination,
          restored: result.restored,
        });
      } catch (error) {
        emitError(program, "evolve.rollback", startedAt, error);
      }
    });

  evolve
    .command("inspect [session_id]")
    .description("Inspect one evolution session or list resumable sessions")
    .option("--root <path>", "Override evolution session root")
    .action(
      async (sessionId: string | undefined, opts: EvolveCommonOptions) => {
        const startedAt = Date.now();
        try {
          const store = createEvolutionStore({ rootDir: opts.root });
          if (sessionId) {
            emit(
              program,
              "evolve.inspect",
              startedAt,
              projectSession(await readEvolutionSession(store, sessionId)),
            );
            return;
          }
          const sessions = await listEvolutionSessions(store);
          emit(program, "evolve.inspect", startedAt, {
            root: store.root_dir,
            sessions: sessions.map((session) => {
              const latest = session.attempts.at(-1);
              return {
                session_id: session.session_id,
                state: session.state,
                component_id: session.component.id,
                created_at: session.created_at,
                updated_at: session.updated_at,
                attempts: session.attempts.length,
                eligible: latest?.eligible ?? null,
              };
            }),
          });
        } catch (error) {
          emitError(program, "evolve.inspect", startedAt, error);
        }
      },
    );
}

function emitEvolutionResult(
  program: Command,
  command: string,
  startedAt: number,
  session: EvolutionSession,
  report: Awaited<ReturnType<typeof verifyEvolutionSession>>["report"],
  promotion?: Awaited<ReturnType<typeof promoteEvolutionSession>>["promotion"],
): void {
  emit(
    program,
    command,
    startedAt,
    {
      session: projectSession(session),
      report,
      promotion: promotion ?? null,
    },
    (context) => {
      context.next_actions = promotion
        ? [
            {
              command: `unicli evolve rollback ${session.session_id}`,
              description: "Restore the exact pre-promotion adapter state",
            },
          ]
        : report.decision.eligible
          ? [
              {
                command: `unicli evolve verify ${session.session_id} --promote`,
                description:
                  "Promote the unchanged candidate from its verified attempt",
              },
            ]
          : [
              {
                command: `unicli evolve inspect ${session.session_id}`,
                description:
                  "Inspect the rejected candidate and evidence paths",
              },
            ];
    },
  );
  if (!report.decision.eligible) process.exitCode = ExitCode.GENERIC_ERROR;
}

function projectSession(session: EvolutionSession): Record<string, unknown> {
  return {
    schema_version: session.schema_version,
    session_id: session.session_id,
    state: session.state,
    created_at: session.created_at,
    updated_at: session.updated_at,
    component: session.component,
    evidence: session.evidence,
    baseline: session.baseline,
    candidate: session.candidate,
    datasets: {
      proposal_runs: session.datasets.proposal_run_ids.length,
      validation_runs: session.datasets.validation_run_ids.length,
      held_out_runs: session.datasets.held_out_run_ids.length,
      validation_eval_targets: session.datasets.validation_eval_targets,
      held_out_eval_targets: session.datasets.held_out_eval_targets,
    },
    runtime: session.runtime,
    prediction: session.prediction ?? null,
    attempts: session.attempts,
    latest_attempt: session.attempts.at(-1) ?? null,
    promotion: session.promotion ?? null,
  };
}

function reusesVerifiedAttempt(
  session: EvolutionSession,
  options: EvolveVerifyOptions,
): boolean {
  return (
    session.state === "verified" &&
    options.promote === true &&
    options.validation === undefined &&
    options.heldOut === undefined &&
    options.hypothesis === undefined &&
    options.expect === undefined &&
    options.risk === undefined &&
    options.cli === undefined &&
    options.timeout === undefined &&
    options.allowMutationEval === undefined
  );
}

function parsePrediction(
  options: PredictionOptions,
): EvolutionPrediction | undefined {
  if (!options.hypothesis && !options.expect && !options.risk) return undefined;
  return {
    hypothesis: options.hypothesis ?? "",
    expected_fixes: options.expect ?? [],
    at_risk: options.risk ?? [],
  };
}

function parseTimeout(value: string | undefined): number {
  const timeout = Number(value ?? "30000");
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 300_000) {
    throw new EvolutionError(
      "invalid_case",
      "--timeout must be an integer from 1000 to 300000 milliseconds",
    );
  }
  return timeout;
}

function evolutionCliError(error: unknown): {
  code: string;
  message: string;
  suggestion: string;
  path?: string;
  exitCode: number;
} {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof EvolutionError) {
    const conflict =
      error.code === "candidate_changed" ||
      error.code === "destination_changed";
    const configuration =
      conflict ||
      error.code === "mutation_eval_blocked" ||
      [
        "adapter_not_editable",
        "candidate_invalid",
        "source_not_found",
        "not_eligible",
        "not_promoted",
      ].includes(error.code);
    return {
      code:
        error.code === "session_not_found" || error.code === "run_not_found"
          ? "not_found"
          : error.code === "mutation_eval_blocked"
            ? "permission_denied"
            : conflict
              ? "conflict"
              : "invalid_input",
      message,
      suggestion:
        error.code === "session_not_found"
          ? "Run `unicli evolve inspect` and select a session."
          : error.code === "run_not_found"
            ? "Run `unicli runs list` and select recorded proposal runs."
            : error.code === "adapter_not_editable"
              ? "Start with a YAML adapter or create a YAML user overlay for this command."
              : error.code === "mutation_eval_blocked"
                ? "Use read-only eval cases or pass --allow-mutation-eval in a controlled target environment."
                : error.code === "candidate_changed"
                  ? `Run \`unicli evolve verify ${extractSessionId(message) ?? "<session_id>"}\` again before promotion.`
                  : conflict
                    ? "Inspect the session and current user adapter before retrying."
                    : "Inspect the candidate, prediction, session evidence, and eval targets, then retry.",
      ...(error.path ? { path: error.path } : {}),
      exitCode: configuration ? ExitCode.CONFIG_ERROR : ExitCode.USAGE_ERROR,
    };
  }
  return {
    code: "internal_error",
    message,
    suggestion: "Retry with -f json and inspect the structured failure.",
    exitCode: ExitCode.GENERIC_ERROR,
  };
}

function extractSessionId(value: string): string | undefined {
  return /\bevo-[A-Za-z0-9._-]+\b/.exec(value)?.[0];
}
