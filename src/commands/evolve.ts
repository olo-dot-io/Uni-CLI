/**
 * Agent-facing harness evolution workflow.
 *
 * An upstream agent edits one isolated YAML candidate. Uni-CLI owns the run
 * evidence, paired execution, promotion gate, local overlay update, and
 * conflict-safe rollback.
 */

import { readFile } from "node:fs/promises";
import type { Command } from "commander";

import { resolveCommand } from "../registry.js";
import {
  createAdapterEvolutionSession,
  createEvolutionStore,
  createUnifiedAdapterDiff,
  evolutionSessionPaths,
  EvolutionCandidateError,
  EvolutionEvaluationError,
  EvolutionPromotionError,
  EvolutionStoreError,
  listEvolutionSessions,
  promoteEvolutionSession,
  readEvolutionSession,
  rollbackEvolutionSession,
  verifyEvolutionSession,
  writePrivateText,
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

interface EvolveAdapterOptions extends EvolveCommonOptions {
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
}

interface EvolveVerifyOptions extends EvolveCommonOptions {
  validation?: string[];
  heldOut?: string[];
  cli?: string;
  timeout?: string;
  allowMutationEval?: boolean;
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
    .description("Create an isolated evolution session for one YAML adapter")
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
    .option("--candidate <path>", "Stage an existing YAML candidate")
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
          const resolved = resolveCommand(site, commandName);
          if (!resolved) {
            throw new EvolutionCandidateError(
              "source_not_found",
              `adapter command is not registered: ${site}.${commandName}`,
            );
          }
          const timeoutMs = parseTimeout(opts.timeout);
          const permissionProfile = program.opts().permissionProfile as
            | string
            | undefined;
          const session = await createAdapterEvolutionSession({
            evolutionStore: createEvolutionStore({ rootDir: opts.root }),
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
            permissionProfile,
            candidatePath: opts.candidate,
            sessionId: opts.sessionId,
            cliCommand: opts.cli,
            timeoutMs,
            allowMutationEval: opts.allowMutationEval,
          });
          emit(
            program,
            "evolve.adapter",
            startedAt,
            projectSession(session),
            (context) => {
              context.next_actions = [
                {
                  command: `unicli evolve verify ${session.session_id}`,
                  description:
                    "Run isolated baseline and candidate evaluation after editing the candidate",
                },
                {
                  command: `unicli evolve inspect ${session.session_id}`,
                  description: "Inspect the component scope and artifact paths",
                },
              ];
            },
          );
        } catch (error) {
          emitError(program, "evolve.adapter", startedAt, error);
        }
      },
    );

  evolve
    .command("verify <session_id>")
    .description("Compare a staged candidate with its baseline")
    .option("--validation <eval_targets...>", "Add validation eval targets")
    .option("--held-out <eval_targets...>", "Add held-out eval targets")
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
        const resolved = resolveCommand(
          session.component.site,
          session.component.command,
        );
        if (!resolved) {
          throw new EvolutionEvaluationError(
            "invalid_case",
            `adapter command is not registered: ${session.component.site}.${session.component.command}`,
          );
        }
        const result = await verifyEvolutionSession({
          store,
          sessionId,
          adapterCommand: resolved.command,
          validationEvalTargets: opts.validation,
          heldOutEvalTargets: opts.heldOut,
          cliCommand: opts.cli,
          ...(opts.timeout ? { timeoutMs: parseTimeout(opts.timeout) } : {}),
          allowMutationEval: opts.allowMutationEval,
        });
        emit(
          program,
          "evolve.verify",
          startedAt,
          { session: projectSession(result.session), report: result.report },
          (context) => {
            context.next_actions = result.report.decision.eligible
              ? [
                  {
                    command: `unicli evolve promote ${sessionId}`,
                    description:
                      "Install the verified candidate as a user adapter overlay",
                  },
                  {
                    command: `unicli evolve diff ${sessionId}`,
                    description: "Review the exact verified adapter patch",
                  },
                ]
              : [
                  {
                    command: `unicli evolve diff ${sessionId}`,
                    description: "Review the rejected candidate patch",
                  },
                  {
                    command: `unicli evolve verify ${sessionId}`,
                    description:
                      "Re-run the gate after editing the staged candidate",
                  },
                ];
          },
        );
        if (!result.report.decision.eligible) {
          process.exitCode = ExitCode.GENERIC_ERROR;
        }
      } catch (error) {
        emitError(program, "evolve.verify", startedAt, error);
      }
    });

  evolve
    .command("promote <session_id>")
    .description("Install a verified candidate as the user adapter overlay")
    .option("--root <path>", "Override evolution session root")
    .action(async (sessionId: string, opts: EvolveCommonOptions) => {
      const startedAt = Date.now();
      try {
        const result = await promoteEvolutionSession({
          store: createEvolutionStore({ rootDir: opts.root }),
          sessionId,
        });
        emit(
          program,
          "evolve.promote",
          startedAt,
          {
            session: projectSession(result.session),
            promotion: result.promotion,
          },
          (context) => {
            context.next_actions = [
              {
                command: `unicli evolve rollback ${sessionId}`,
                description: "Restore the exact pre-promotion adapter state",
              },
            ];
          },
        );
      } catch (error) {
        emitError(program, "evolve.promote", startedAt, error);
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
    .command("inspect <session_id>")
    .description("Inspect one evolution session and its artifact paths")
    .option("--root <path>", "Override evolution session root")
    .action(async (sessionId: string, opts: EvolveCommonOptions) => {
      const startedAt = Date.now();
      try {
        const session = await readEvolutionSession(
          createEvolutionStore({ rootDir: opts.root }),
          sessionId,
        );
        emit(program, "evolve.inspect", startedAt, projectSession(session));
      } catch (error) {
        emitError(program, "evolve.inspect", startedAt, error);
      }
    });

  evolve
    .command("diff <session_id>")
    .description("Return the current baseline-to-candidate adapter patch")
    .option("--root <path>", "Override evolution session root")
    .action(async (sessionId: string, opts: EvolveCommonOptions) => {
      const startedAt = Date.now();
      try {
        const store = createEvolutionStore({ rootDir: opts.root });
        const session = await readEvolutionSession(store, sessionId);
        const paths = evolutionSessionPaths(
          store,
          session.session_id,
          session.component.site,
          session.component.command,
        );
        const diff = createUnifiedAdapterDiff({
          baseline: await readFile(paths.baseline_file, "utf-8"),
          candidate: await readFile(paths.candidate_file, "utf-8"),
          baselineLabel: `baseline/${session.component.site}/${session.component.command}.yaml`,
          candidateLabel: `candidate/${session.component.site}/${session.component.command}.yaml`,
        });
        await writePrivateText(paths.patch, diff.patch);
        emit(program, "evolve.diff", startedAt, {
          session_id: sessionId,
          patch_path: paths.patch,
          changed_lines: { added: diff.added, removed: diff.removed },
          patch: diff.patch,
        });
      } catch (error) {
        emitError(program, "evolve.diff", startedAt, error);
      }
    });

  evolve
    .command("list")
    .description("List local evolution sessions")
    .option("--root <path>", "Override evolution session root")
    .action(async (opts: EvolveCommonOptions) => {
      const startedAt = Date.now();
      try {
        const store = createEvolutionStore({ rootDir: opts.root });
        const sessions = await listEvolutionSessions(store);
        emit(program, "evolve.list", startedAt, {
          root: store.root_dir,
          sessions: sessions.map((session) => ({
            session_id: session.session_id,
            state: session.state,
            component_id: session.component.id,
            created_at: session.created_at,
            updated_at: session.updated_at,
            eligible: session.verification?.eligible ?? null,
          })),
        });
      } catch (error) {
        emitError(program, "evolve.list", startedAt, error);
      }
    });
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
    verification: session.verification ?? null,
    promotion: session.promotion ?? null,
  };
}

function parseTimeout(value: string | undefined): number {
  const timeout = Number(value ?? "30000");
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 300_000) {
    throw new EvolutionEvaluationError(
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
  if (error instanceof EvolutionStoreError) {
    return {
      code: error.code === "session_not_found" ? "not_found" : "invalid_input",
      message,
      suggestion: "Run `unicli evolve list` and inspect the selected session.",
      ...(error.path ? { path: error.path } : {}),
      exitCode: ExitCode.USAGE_ERROR,
    };
  }
  if (error instanceof EvolutionCandidateError) {
    return {
      code: "invalid_input",
      message,
      suggestion:
        error.code === "adapter_not_editable"
          ? "Start with a YAML adapter or create a YAML user overlay for this command."
          : "Inspect the candidate and its schema-v2 adapter metadata, then retry.",
      ...(error.path ? { path: error.path } : {}),
      exitCode: ExitCode.CONFIG_ERROR,
    };
  }
  if (error instanceof EvolutionEvaluationError) {
    return {
      code:
        error.code === "mutation_eval_blocked"
          ? "permission_denied"
          : "invalid_input",
      message,
      suggestion:
        error.code === "mutation_eval_blocked"
          ? "Use read-only eval cases or pass --allow-mutation-eval in a controlled target environment."
          : "Inspect the session evidence and eval targets, then retry verification.",
      exitCode:
        error.code === "mutation_eval_blocked"
          ? ExitCode.CONFIG_ERROR
          : ExitCode.USAGE_ERROR,
    };
  }
  if (error instanceof EvolutionPromotionError) {
    return {
      code:
        error.code === "candidate_changed" ||
        error.code === "destination_changed"
          ? "conflict"
          : "invalid_input",
      message,
      suggestion:
        error.code === "candidate_changed"
          ? `Run \`unicli evolve verify ${extractSessionId(message) ?? "<session_id>"}\` again before promotion.`
          : "Inspect the session and current user adapter before retrying.",
      ...(error.path ? { path: error.path } : {}),
      exitCode: ExitCode.CONFIG_ERROR,
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
