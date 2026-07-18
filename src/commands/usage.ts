/**
 * @owner       src::commands::usage
 * @does        Validates and renders operational statistics from legacy usage rows plus the bounded local event log.
 * @needs       usage projection, local event store, structured output/error writers
 * @feeds       `unicli usage report`
 * @breaks      Silent source corruption or permissive filters makes the report claim evidence it did not read.
 * @invariants  Invalid input exits 2; corrupt/unreadable local evidence exits 78; command metadata identifies the system surface.
 * @side-effects Reads local JSONL sources and writes one success or error envelope.
 * @perf        Linear in retained records plus percentile sorting.
 * @concurrency Read-only over append-only files.
 * @test        tests/unit/commands/usage.test.ts and tests/unit/usage-ledger.test.ts
 * @stability   stable CLI with additive source/transport fields
 * @since       2026-04-08
 */

import type { Command } from "commander";
import {
  aggregate,
  DEFAULT_LEDGER_PATH,
  filterSince,
  InvalidUsageArgumentError,
  loadUsageSources,
  parseSinceArg,
  parseUsageLimit,
  UsageLedgerError,
  type UsageAggregate,
} from "../runtime/usage-ledger.js";
import {
  createLocalEventStore,
  LocalEventLogError,
} from "../runtime/local-event-log.js";
import { detectFormat, format } from "../output/formatter.js";
import { printErrorEnvelope } from "../output/error-writer.js";
import { ExitCode, type OutputFormat } from "../types.js";

interface ReportOptions {
  since?: string;
  slow?: boolean;
  failing?: boolean;
  limit?: string;
  json?: boolean;
  ledger?: string;
  logDir?: string;
}

const SLOW_P95_THRESHOLD_MS = 5000;
const FAILING_RATE_THRESHOLD = 0.1;

export function registerUsageCommands(program: Command): void {
  const usage = program
    .command("usage")
    .description("Report on local command latency, failures, and output size");

  usage
    .command("report")
    .description("Aggregate legacy usage and bounded diagnostic event logs")
    .option("--since <window>", "Limit to recent window (e.g. 24h, 7d, 30m)")
    .option("--slow", "Only commands with p95 > 5000ms")
    .option("--failing", "Only commands with error rate > 10%")
    .option("--limit <n>", "Top N rows (1-10000)", "20")
    .option(
      "--ledger <path>",
      "Override legacy usage.jsonl path",
      DEFAULT_LEDGER_PATH,
    )
    .option("--log-dir <path>", "Override versioned local event directory")
    .option("--json", "Output as JSON")
    .action((opts: ReportOptions) => {
      const startedAt = Date.now();
      const fmt = reportFormat(program, opts);
      try {
        const windowMs = parseSinceArg(opts.since);
        const limit = parseUsageLimit(opts.limit);
        const sources = loadUsageSources({
          ledgerPath: opts.ledger ?? DEFAULT_LEDGER_PATH,
          eventStore: createLocalEventStore({ rootDir: opts.logDir }),
        });
        const filtered = filterSince(sources.records, windowMs);
        let rows = aggregate(filtered);
        if (opts.slow) {
          rows = rows.filter((row) => row.p95Ms > SLOW_P95_THRESHOLD_MS);
        }
        if (opts.failing) {
          rows = rows.filter((row) => row.errorRate > FAILING_RATE_THRESHOLD);
        }
        rows = rows.slice(0, limit);

        console.log(
          format(
            {
              records: filtered.length,
              window: opts.since ?? "all",
              sources: {
                legacy: sources.legacy_records,
                events: sources.event_records,
              },
              rows: rows.map(tableRow),
            },
            ["site", "cmd", "transport", "n", "median", "p95", "err", "bytes"],
            fmt,
            {
              command: "core.usage",
              duration_ms: Date.now() - startedAt,
              surface: "system",
            },
          ),
        );
      } catch (error) {
        printUsageError(error, fmt, startedAt);
      }
    });
}

function reportFormat(program: Command, options: ReportOptions): OutputFormat {
  return detectFormat(
    options.json ? "json" : (program.opts().format as OutputFormat | undefined),
  );
}

function printUsageError(
  error: unknown,
  fmt: OutputFormat,
  startedAt: number,
): void {
  const invalidInput = error instanceof InvalidUsageArgumentError;
  const corrupt =
    (error instanceof UsageLedgerError ||
      error instanceof LocalEventLogError) &&
    error.code === "malformed_jsonl";
  const knownStoreError =
    error instanceof UsageLedgerError || error instanceof LocalEventLogError;
  const message = error instanceof Error ? error.message : String(error);
  const exitCode = invalidInput ? ExitCode.USAGE_ERROR : ExitCode.CONFIG_ERROR;
  const code = invalidInput
    ? "invalid_input"
    : corrupt
      ? "local_log_corrupt"
      : knownStoreError
        ? "local_log_unavailable"
        : "internal_error";
  const suggestion = invalidInput
    ? error.argument === "since"
      ? "use `--since 24h`, `--since 7d`, `--since 30m`, or omit the filter"
      : "use an integer `--limit` from 1 to 10000"
    : corrupt
      ? "inspect the reported file and line; preserve it for diagnosis before removing the corrupt row"
      : "verify owner read/write permissions for ~/.unicli/logs and ~/.unicli/usage.jsonl";

  printErrorEnvelope({
    fmt,
    exitCode,
    ctx: {
      command: "core.usage",
      duration_ms: Date.now() - startedAt,
      surface: "system",
      error: {
        code,
        message,
        suggestion,
        retryable: false,
      },
    },
  });
}

function tableRow(row: UsageAggregate): Record<string, unknown> {
  return {
    site: row.site,
    cmd: row.cmd,
    transport: row.transport,
    n: row.count,
    median: `${Math.round(row.medianMs)}ms`,
    p95: `${Math.round(row.p95Ms)}ms`,
    err: `${(row.errorRate * 100).toFixed(0)}%`,
    bytes: humanBytes(row.totalBytes),
  };
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
}
