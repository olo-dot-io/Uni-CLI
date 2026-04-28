import type { Command } from "commander";
import { detectFormat, format } from "../output/formatter.js";
import { makeCtx } from "../output/envelope.js";
import type { OutputFormat } from "../types.js";
import { createRunStore, readRunEvents } from "../engine/session/store.js";
import {
  listRunSummaries,
  projectRunEvents,
  summarizeRunEvents,
} from "../engine/session/query.js";

interface RunsListOptions {
  root?: string;
  limit?: string;
}

interface RunsShowOptions {
  root?: string;
  includeInternal?: boolean;
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
      const fmt = detectFormat(
        program.opts().format as OutputFormat | undefined,
      );
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
          fmt,
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
      const fmt = detectFormat(
        program.opts().format as OutputFormat | undefined,
      );
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
          fmt,
          ctx,
        ),
      );
    });
}
