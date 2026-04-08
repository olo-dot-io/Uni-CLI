/**
 * Per-call cost ledger — append-only JSONL at ~/.unicli/usage.jsonl.
 *
 * Why this exists:
 *   AutoCLI's 12× perf advantage means TS-based hubs need to *show* their
 *   numbers to defend. AutoHarness ships per-call cost attribution as a
 *   first-class feature. The ledger lets users (and the harness flywheel)
 *   spot slow adapters, broken auth, and regressions without instrumenting
 *   anything per-adapter — every call already passes through `cli.ts`, and
 *   `recordUsage` is invoked once at the end of execution.
 *
 * Format (one JSON object per line, no schema migrations — additive only):
 *   {
 *     "ts":       ISO-8601 timestamp,
 *     "site":     adapter name (e.g. "bilibili"),
 *     "cmd":      command name (e.g. "rank"),
 *     "strategy": "public" | "cookie" | "header" | "intercept" | "ui",
 *     "tokens":   LLM tokens consumed by this call (0 unless self-repair triggered Claude),
 *     "ms":       wall-clock duration in milliseconds,
 *     "bytes":    output payload size in bytes (0 if unknown),
 *     "exit":     sysexits.h exit code
 *   }
 *
 * Reads via `loadUsage` are tolerant of malformed lines (skipped silently)
 * because the ledger is append-only and an editor crash mid-write should not
 * brick reporting.
 */

import { mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

/** Default ledger location — overridable for tests. */
export const DEFAULT_LEDGER_PATH = join(homedir(), ".unicli", "usage.jsonl");

export interface UsageRecord {
  /** ISO-8601 timestamp of the call (stamped at write time). */
  ts: string;
  /** Adapter name. */
  site: string;
  /** Command name. */
  cmd: string;
  /** Auth strategy used (or "unknown" when not specified). */
  strategy: string;
  /** LLM tokens consumed (0 unless self-repair triggered Claude). */
  tokens: number;
  /** Wall-clock duration in milliseconds. */
  ms: number;
  /** Output payload size in bytes. */
  bytes: number;
  /** Exit code (sysexits.h). */
  exit: number;
}

/**
 * Best-effort append. NEVER throws — the ledger is observability infra,
 * not a hot path. A failed write is logged to stderr only when
 * `UNICLI_DEBUG` is set, otherwise it's silent.
 */
export function recordUsage(
  record: Omit<UsageRecord, "ts"> & { ts?: string },
  ledgerPath: string = DEFAULT_LEDGER_PATH,
): void {
  // Skip recording entirely when explicitly disabled. The user may want this
  // for sensitive sessions or when piping to scripts that diff stdout.
  if (process.env.UNICLI_NO_LEDGER === "1") return;

  try {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    const fullRecord: UsageRecord = {
      ts: record.ts ?? new Date().toISOString(),
      site: record.site,
      cmd: record.cmd,
      strategy: record.strategy,
      tokens: record.tokens,
      ms: record.ms,
      bytes: record.bytes,
      exit: record.exit,
    };
    appendFileSync(ledgerPath, JSON.stringify(fullRecord) + "\n", "utf-8");
  } catch (err) {
    if (process.env.UNICLI_DEBUG) {
      process.stderr.write(
        `[usage-ledger] write failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

/**
 * Load every record from the ledger. Tolerant of malformed lines.
 */
export function loadUsage(
  ledgerPath: string = DEFAULT_LEDGER_PATH,
): UsageRecord[] {
  if (!existsSync(ledgerPath)) return [];
  const raw = readFileSync(ledgerPath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const records: UsageRecord[] = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as UsageRecord;
      // Cheap shape validation — skip lines that don't look like records.
      if (typeof obj.site === "string" && typeof obj.cmd === "string") {
        records.push(obj);
      }
    } catch {
      // Skip malformed lines silently — additive ledger.
    }
  }
  return records;
}

/**
 * Filter records to those within the trailing `windowMs` from now.
 * Use `parseSinceArg` to convert "7d" / "24h" / "30m" CLI strings.
 */
export function filterSince(
  records: UsageRecord[],
  windowMs: number,
  now: number = Date.now(),
): UsageRecord[] {
  if (windowMs <= 0) return records;
  const cutoff = now - windowMs;
  return records.filter((r) => {
    const t = Date.parse(r.ts);
    return Number.isFinite(t) && t >= cutoff;
  });
}

/**
 * Parse `--since` argument: 7d, 24h, 30m, or a number of seconds.
 * Returns 0 (no filter) for unrecognized input.
 */
export function parseSinceArg(s: string | undefined): number {
  if (!s) return 0;
  const m = s.match(/^(\d+)([dhms])?$/);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  const unit = m[2] ?? "s";
  switch (unit) {
    case "d":
      return n * 86_400_000;
    case "h":
      return n * 3_600_000;
    case "m":
      return n * 60_000;
    case "s":
      return n * 1000;
    default:
      return 0;
  }
}

/** Aggregated stats per adapter command. */
export interface UsageAggregate {
  site: string;
  cmd: string;
  count: number;
  errorRate: number;
  medianMs: number;
  p95Ms: number;
  totalBytes: number;
  totalTokens: number;
}

/**
 * Group records by site+cmd and compute median/p95/error-rate. The output
 * is sorted by count descending — most-used commands first by default.
 */
export function aggregate(records: UsageRecord[]): UsageAggregate[] {
  const buckets = new Map<string, UsageRecord[]>();
  for (const r of records) {
    const key = `${r.site}/${r.cmd}`;
    let arr = buckets.get(key);
    if (!arr) {
      arr = [];
      buckets.set(key, arr);
    }
    arr.push(r);
  }

  const result: UsageAggregate[] = [];
  for (const [key, arr] of buckets) {
    const [site, cmd] = key.split("/");
    const sortedMs = arr.map((r) => r.ms).sort((a, b) => a - b);
    const errorCount = arr.filter((r) => r.exit !== 0 && r.exit !== 66).length;
    result.push({
      site,
      cmd,
      count: arr.length,
      errorRate: arr.length > 0 ? errorCount / arr.length : 0,
      medianMs: percentile(sortedMs, 0.5),
      p95Ms: percentile(sortedMs, 0.95),
      totalBytes: arr.reduce((s, r) => s + (r.bytes || 0), 0),
      totalTokens: arr.reduce((s, r) => s + (r.tokens || 0), 0),
    });
  }
  return result.sort((a, b) => b.count - a.count);
}

/**
 * Inclusive linear-interpolation percentile. Returns 0 for empty input,
 * matching numpy's behavior on a zero-length array under safe defaults.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
