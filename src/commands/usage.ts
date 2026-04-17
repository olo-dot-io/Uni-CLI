/**
 * Usage report command — read ~/.unicli/usage.jsonl and summarize.
 *
 *   unicli usage report                  # all-time top by call count
 *   unicli usage report --since 7d       # last 7 days only
 *   unicli usage report --slow           # only commands with p95 > 5000ms
 *   unicli usage report --failing        # only commands with > 10% error rate
 *   unicli usage report --json           # machine-readable
 *
 * Why this exists:
 *   The ledger captures every call, but agents and humans need a way to
 *   ask "what's slow" / "what's broken" without writing a custom script.
 *   This command is the canonical reader.
 */

import type { Command } from "commander";
import {
  loadUsage,
  filterSince,
  parseSinceArg,
  aggregate,
  type UsageAggregate,
  DEFAULT_LEDGER_PATH,
} from "../runtime/usage-ledger.js";
import { format, detectFormat } from "../output/formatter.js";
import type { AgentContext } from "../output/envelope.js";
import type { OutputFormat } from "../types.js";

interface ReportOptions {
  since?: string;
  slow?: boolean;
  failing?: boolean;
  limit?: string;
  json?: boolean;
  ledger?: string;
}

const SLOW_P95_THRESHOLD_MS = 5000;
const FAILING_RATE_THRESHOLD = 0.1;

export function registerUsageCommands(program: Command): void {
  const usage = program
    .command("usage")
    .description("Report on adapter call usage from the cost ledger");

  usage
    .command("report")
    .description("Aggregate ledger entries (median/p95 ms, error rate, bytes)")
    .option("--since <window>", "Limit to recent window (e.g. 24h, 7d, 30m)")
    .option("--slow", "Only commands with p95 > 5000ms")
    .option("--failing", "Only commands with error rate > 10%")
    .option("--limit <n>", "Top N rows", "20")
    .option("--ledger <path>", "Override ledger path", DEFAULT_LEDGER_PATH)
    .option("--json", "Output as JSON")
    .action((opts: ReportOptions) => {
      const usageStarted = Date.now();
      const fmt: OutputFormat = opts.json
        ? ("json" as OutputFormat)
        : detectFormat(undefined);

      const records = loadUsage(opts.ledger ?? DEFAULT_LEDGER_PATH);

      if (records.length === 0) {
        const ctx: AgentContext = {
          command: "core.usage",
          duration_ms: Date.now() - usageStarted,
          surface: "web",
        };
        console.log(
          format(
            { records: 0, window: opts.since ?? "all", rows: [] },
            undefined,
            fmt,
            ctx,
          ),
        );
        return;
      }

      const windowMs = parseSinceArg(opts.since);
      const filtered = filterSince(records, windowMs);
      let rows = aggregate(filtered);

      if (opts.slow) {
        rows = rows.filter((r) => r.p95Ms > SLOW_P95_THRESHOLD_MS);
      }
      if (opts.failing) {
        rows = rows.filter((r) => r.errorRate > FAILING_RATE_THRESHOLD);
      }

      const limit = parseInt(opts.limit ?? "20", 10) || 20;
      rows = rows.slice(0, limit);

      const tableRows = rows.map((r: UsageAggregate) => ({
        site: r.site,
        cmd: r.cmd,
        n: r.count,
        median: `${Math.round(r.medianMs)}ms`,
        p95: `${Math.round(r.p95Ms)}ms`,
        err: `${(r.errorRate * 100).toFixed(0)}%`,
        bytes: humanBytes(r.totalBytes),
      }));

      const ctx: AgentContext = {
        command: "core.usage",
        duration_ms: Date.now() - usageStarted,
        surface: "web",
      };
      console.log(
        format(
          {
            records: filtered.length,
            window: opts.since ?? "all",
            rows: tableRows,
          },
          ["site", "cmd", "n", "median", "p95", "err", "bytes"],
          fmt,
          ctx,
        ),
      );
    });
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}
