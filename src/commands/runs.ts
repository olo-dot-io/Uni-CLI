import { existsSync } from "node:fs";
import type { Command } from "commander";
import { detectFormat, format } from "../output/formatter.js";
import { makeCtx, type AgentError } from "../output/envelope.js";
import { ExitCode, type OutputFormat } from "../types.js";
import {
  createRunStore,
  readRunEvents,
  runTracePath,
  RunStoreError,
  watchRunEvents,
} from "../engine/session/store.js";
import {
  listRunSummaries,
  projectRunEvents,
  summarizeRunEvents,
} from "../engine/session/query.js";
import {
  extractRunReplayInvocation,
  extractRunReplayPlan,
} from "../engine/session/replay.js";
import { compareRunEvents } from "../engine/session/compare.js";
import { buildInvocation } from "../engine/invoke.js";
import { executeWithRunRecording } from "../engine/session/run-loop.js";

interface RunsListOptions {
  root?: string;
  limit?: string;
}

interface RunsShowOptions {
  root?: string;
  includeInternal?: boolean;
}

interface RunsStreamOptions {
  root?: string;
  after?: string;
  follow?: boolean;
  includeInternal?: boolean;
  pollMs?: string;
  timeoutMs?: string;
}

interface RunsProbeOptions {
  root?: string;
}

interface RunsReplayOptions {
  root?: string;
  dryRun?: boolean;
  permissionProfile?: string;
  yes?: boolean;
  replayRunId?: string;
}

interface RunsCompareOptions {
  root?: string;
}

function fmt(program: Command): OutputFormat {
  return detectFormat(program.opts().format as OutputFormat | undefined);
}

function printRunError(
  program: Command,
  command: string,
  startedAt: number,
  error: AgentError,
): void {
  process.exitCode = ExitCode.USAGE_ERROR;
  console.log(
    format(null, undefined, fmt(program), {
      ...makeCtx(command, startedAt),
      error,
    }),
  );
}

function nonNegativeInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function runStoreAgentErrorCode(error: RunStoreError): string {
  return error.code === "invalid_run_id" || error.code === "malformed_jsonl"
    ? "invalid_input"
    : "internal_error";
}

export function registerRunsCommand(program: Command): void {
  const runs = program
    .command("runs")
    .description("Inspect recorded Uni-CLI run traces");

  runs
    .command("list")
    .description("List recorded run trace summaries")
    .option("--root <path>", "Override run trace root")
    .option("--limit <n>", "Maximum runs to return", "50")
    .action(async (opts: RunsListOptions) => {
      const startedAt = Date.now();
      const outputFormat = fmt(program);
      const store = createRunStore({ rootDir: opts.root });
      const limit = Math.max(1, parseInt(opts.limit ?? "50", 10) || 50);
      const summaries = (await listRunSummaries(store)).slice(0, limit);
      const ctx = makeCtx("runs.list", startedAt);
      console.log(
        format(
          {
            root: store.rootDir,
            runs: summaries,
          },
          undefined,
          outputFormat,
          ctx,
        ),
      );
    });

  runs
    .command("show <run_id>")
    .description("Show recorded run trace events")
    .option("--root <path>", "Override run trace root")
    .option("--include-internal", "Include internal event payloads")
    .action(async (runId: string, opts: RunsShowOptions) => {
      const startedAt = Date.now();
      const outputFormat = fmt(program);
      const store = createRunStore({ rootDir: opts.root });
      const events = await readRunEvents(store, runId);
      const summary = summarizeRunEvents(events, { runId });
      const ctx = makeCtx("runs.show", startedAt);
      console.log(
        format(
          {
            run_id: runId,
            summary,
            events: projectRunEvents(events, {
              includeInternal: opts.includeInternal === true,
            }),
          },
          undefined,
          outputFormat,
          ctx,
        ),
      );
    });

  runs
    .command("stream <run_id>")
    .description("Stream recorded run trace events as JSON lines")
    .option("--root <path>", "Override run trace root")
    .option("--after <sequence>", "Only stream events after this sequence", "0")
    .option("--follow", "Poll until the run reaches a terminal event")
    .option("--include-internal", "Include internal event payloads")
    .option("--poll-ms <ms>", "Follow poll interval in milliseconds", "250")
    .option("--timeout-ms <ms>", "Follow timeout in milliseconds", "30000")
    .action(async (runId: string, opts: RunsStreamOptions) => {
      const startedAt = Date.now();
      const store = createRunStore({ rootDir: opts.root });
      try {
        for await (const event of watchRunEvents(store, runId, {
          afterSequence: nonNegativeInteger(opts.after, 0),
          follow: opts.follow === true,
          pollIntervalMs: nonNegativeInteger(opts.pollMs, 250),
          timeoutMs: nonNegativeInteger(opts.timeoutMs, 30_000),
        })) {
          const [projected] = projectRunEvents([event], {
            includeInternal: opts.includeInternal === true,
          });
          console.log(JSON.stringify(projected));
        }
      } catch (err) {
        if (err instanceof RunStoreError) {
          printRunError(program, "runs.stream", startedAt, {
            code: runStoreAgentErrorCode(err),
            message: err.message,
            suggestion: "run `unicli runs list` and choose an existing run id",
            retryable: false,
          });
          return;
        }
        throw err;
      }
    });

  runs
    .command("probe <run_id>")
    .description("Check whether a recorded run trace can be replayed")
    .option("--root <path>", "Override run trace root")
    .action(async (runId: string, opts: RunsProbeOptions) => {
      const startedAt = Date.now();
      const store = createRunStore({ rootDir: opts.root });
      const events = await readRunEvents(store, runId);
      const replay = extractRunReplayPlan(events, runId);
      console.log(
        format(
          {
            run_id: runId,
            replay,
          },
          undefined,
          fmt(program),
          makeCtx("runs.probe", startedAt),
        ),
      );
    });

  runs
    .command("compare <left_run_id> <right_run_id>")
    .description("Compare two recorded run traces for replay/eval review")
    .option("--root <path>", "Override run trace root")
    .action(
      async (
        leftRunId: string,
        rightRunId: string,
        opts: RunsCompareOptions,
      ) => {
        const startedAt = Date.now();
        const store = createRunStore({ rootDir: opts.root });
        const leftEvents = await readRunEvents(store, leftRunId);
        if (leftEvents.length === 0) {
          printRunError(program, "runs.compare", startedAt, {
            code: "invalid_input",
            message: `run trace not found or empty: ${leftRunId}`,
            suggestion: "run `unicli runs list` and choose an existing run id",
            retryable: false,
          });
          return;
        }
        const rightEvents = await readRunEvents(store, rightRunId);
        if (rightEvents.length === 0) {
          printRunError(program, "runs.compare", startedAt, {
            code: "invalid_input",
            message: `run trace not found or empty: ${rightRunId}`,
            suggestion: "run `unicli runs list` and choose an existing run id",
            retryable: false,
          });
          return;
        }
        const comparison = compareRunEvents(leftEvents, rightEvents, {
          leftRunId,
          rightRunId,
        });
        console.log(
          format(
            { ...comparison },
            undefined,
            fmt(program),
            makeCtx("runs.compare", startedAt),
          ),
        );
      },
    );

  runs
    .command("replay <run_id>")
    .description("Replay a recorded run trace using its private replay payload")
    .option("--root <path>", "Override run trace root")
    .option("--dry-run", "Show replay plan without executing")
    .option(
      "--permission-profile <profile>",
      "Override replay permission profile",
    )
    .option("--yes", "Approve permission-gated replay execution")
    .option("--replay-run-id <run_id>", "Override the new replay run id")
    .action(async (runId: string, opts: RunsReplayOptions) => {
      const startedAt = Date.now();
      const store = createRunStore({ rootDir: opts.root });
      const events = await readRunEvents(store, runId);
      const replay = extractRunReplayPlan(events, runId);
      if (!replay.replayable) {
        printRunError(program, "runs.replay", startedAt, {
          code: "invalid_input",
          message: replay.reason ?? "run trace is not replayable",
          suggestion:
            "run the command again with --record, then replay the new run id",
          retryable: false,
        });
        return;
      }

      if (opts.dryRun === true) {
        console.log(
          format(
            {
              run_id: runId,
              replay,
            },
            undefined,
            fmt(program),
            makeCtx("runs.replay", startedAt),
          ),
        );
        return;
      }

      const replayInvocation = extractRunReplayInvocation(events, runId);
      if (!replayInvocation) {
        printRunError(program, "runs.replay", startedAt, {
          code: "invalid_input",
          message: "run trace replay payload is malformed",
          suggestion:
            "inspect the trace with `unicli runs show <run_id> --include-internal`",
          retryable: false,
        });
        return;
      }

      const inv = buildInvocation(
        "cli",
        replayInvocation.site,
        replayInvocation.cmd,
        {
          args: replayInvocation.args,
          source: replayInvocation.source,
        },
        {
          permissionProfile:
            opts.permissionProfile ?? replayInvocation.permissionProfile,
          approved: opts.yes === true,
        },
      );
      if (!inv) {
        printRunError(program, "runs.replay", startedAt, {
          code: "invalid_input",
          message: `command is not registered: ${replayInvocation.site}.${replayInvocation.cmd}`,
          suggestion:
            "run `unicli list` and choose a currently registered command",
          retryable: false,
        });
        return;
      }

      const replayRunId = opts.replayRunId ?? `run-replay-${inv.trace_id}`;
      let replayTracePath: string;
      try {
        replayTracePath = runTracePath(store, replayRunId);
      } catch (err) {
        if (err instanceof RunStoreError && err.code === "invalid_run_id") {
          printRunError(program, "runs.replay", startedAt, {
            code: "invalid_input",
            message: err.message,
            suggestion:
              "use letters, numbers, dot, underscore, or dash in --replay-run-id",
            retryable: false,
          });
          return;
        }
        throw err;
      }
      if (existsSync(replayTracePath)) {
        printRunError(program, "runs.replay", startedAt, {
          code: "invalid_input",
          message: `replay run id already exists: ${replayRunId}`,
          suggestion: "omit --replay-run-id or choose a new run id",
          retryable: false,
        });
        return;
      }
      const result = await executeWithRunRecording(inv, {
        enabled: true,
        store,
        runId: replayRunId,
      });
      const replayEvents = await readRunEvents(store, replayRunId);
      const comparison = compareRunEvents(events, replayEvents, {
        leftRunId: runId,
        rightRunId: replayRunId,
      });
      console.log(
        format(
          {
            original_run_id: runId,
            replay_run_id: replayRunId,
            replay: {
              command: replay.command,
              args_hash: replay.args_hash,
              argument_keys: replay.argument_keys,
              source: replayInvocation.source,
              permission_profile:
                opts.permissionProfile ?? replayInvocation.permissionProfile,
            },
            result: {
              exit_code: result.exitCode,
              duration_ms: result.durationMs,
              result_count: result.results.length,
              error: result.error ?? null,
              envelope: result.envelope,
              warnings: result.warnings,
            },
            comparison,
          },
          undefined,
          fmt(program),
          makeCtx("runs.replay", startedAt),
        ),
      );
    });
}
