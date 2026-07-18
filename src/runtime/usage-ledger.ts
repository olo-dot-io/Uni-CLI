/**
 * @owner       src::runtime::usage-ledger
 * @does        Projects legacy usage JSONL and schema-v1 local tool events into aggregate command statistics.
 * @needs       local event log reader, user-home resolution, sysexits semantics
 * @feeds       `unicli usage report` and usage regression tests
 * @breaks      Silent corruption or permissive CLI parsing makes operational reports falsely trustworthy.
 * @invariants  Every complete input row is validated; invalid windows and limits fail rather than widening the query.
 * @side-effects Reads the legacy ledger and bounded local event files; never writes either source.
 * @perf        Linear in retained event count, then O(n log n) per command for latency percentiles.
 * @concurrency Readers accept concurrently appended complete lines and surface partial/corrupt lines explicitly.
 * @test        tests/unit/usage-ledger.test.ts and tests/unit/commands/usage.test.ts
 * @stability   legacy input compatible; aggregate output additive
 * @since       2026-04-08
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { userHome } from "../engine/user-home.js";
import {
  createLocalEventStore,
  readLocalEvents,
  type LocalEventStore,
} from "./local-event-log.js";

export const DEFAULT_LEDGER_PATH = join(userHome(), ".unicli", "usage.jsonl");

export interface UsageRecord {
  ts: string;
  site: string;
  cmd: string;
  strategy: string;
  transport: "cli" | "mcp" | "acp" | "bench" | "hub";
  tokens: number;
  ms: number;
  bytes: number;
  exit: number;
}

export interface UsageSources {
  records: UsageRecord[];
  legacy_records: number;
  event_records: number;
}

export type UsageLedgerErrorCode = "malformed_jsonl" | "io_error";

export class UsageLedgerError extends Error {
  constructor(
    public readonly code: UsageLedgerErrorCode,
    message: string,
    public readonly path: string,
    public readonly line?: number,
  ) {
    super(message);
    this.name = "UsageLedgerError";
  }
}

export class InvalidUsageArgumentError extends Error {
  constructor(
    public readonly argument: "since" | "limit",
    message: string,
  ) {
    super(message);
    this.name = "InvalidUsageArgumentError";
  }
}

export function loadUsage(
  ledgerPath: string = DEFAULT_LEDGER_PATH,
): UsageRecord[] {
  if (!existsSync(ledgerPath)) return [];
  let raw: string;
  try {
    raw = readFileSync(ledgerPath, "utf-8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UsageLedgerError(
      "io_error",
      `failed to read legacy usage ledger: ${message}`,
      ledgerPath,
    );
  }

  const records: UsageRecord[] = [];
  raw.split(/\r?\n/).forEach((lineText, index) => {
    if (lineText.trim().length === 0) return;
    try {
      const value = JSON.parse(lineText) as unknown;
      records.push(parseLegacyUsageRecord(value));
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : "";
      throw new UsageLedgerError(
        "malformed_jsonl",
        `malformed legacy usage JSONL at ${ledgerPath} (line ${String(index + 1)})${detail}`,
        ledgerPath,
        index + 1,
      );
    }
  });
  return records;
}

export function loadUsageSources(
  options: {
    ledgerPath?: string;
    eventStore?: LocalEventStore;
  } = {},
): UsageSources {
  const legacy = loadUsage(options.ledgerPath ?? DEFAULT_LEDGER_PATH);
  const events = readLocalEvents(options.eventStore ?? createLocalEventStore())
    .filter(
      (event) =>
        (event.event_name === "unicli.tool.call.completed" &&
          event.transport !== "cli") ||
        event.event_name === "unicli.cli.invocation.completed",
    )
    .map(
      (event): UsageRecord => ({
        ts: event.timestamp,
        site: event.site ?? event.command.split(".")[0] ?? "core",
        cmd: event.cmd ?? event.command.replace(/^[^.]+\./, ""),
        strategy: event.strategy ?? "unknown",
        transport: event.transport,
        tokens: 0,
        ms: event.duration_ms,
        bytes: event.result_bytes ?? 0,
        exit: event.exit_code,
      }),
    );
  return {
    records: [...legacy, ...events],
    legacy_records: legacy.length,
    event_records: events.length,
  };
}

export function filterSince(
  records: UsageRecord[],
  windowMs: number,
  now: number = Date.now(),
): UsageRecord[] {
  if (windowMs <= 0) return records;
  const cutoff = now - windowMs;
  return records.filter((record) => Date.parse(record.ts) >= cutoff);
}

export function parseSinceArg(value: string | undefined): number {
  if (value === undefined) return 0;
  const match = /^(\d+)([dhms])?$/.exec(value);
  if (!match) {
    throw new InvalidUsageArgumentError(
      "since",
      '--since must be a positive duration such as "7d", "24h", "30m", or seconds',
    );
  }
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new InvalidUsageArgumentError(
      "since",
      "--since must be greater than zero",
    );
  }
  const multiplier =
    match[2] === "d"
      ? 86_400_000
      : match[2] === "h"
        ? 3_600_000
        : match[2] === "m"
          ? 60_000
          : 1000;
  const windowMs = amount * multiplier;
  if (!Number.isSafeInteger(windowMs)) {
    throw new InvalidUsageArgumentError(
      "since",
      "--since exceeds the supported duration range",
    );
  }
  return windowMs;
}

export function parseUsageLimit(value: string | undefined): number {
  const raw = value ?? "20";
  if (!/^\d+$/.test(raw)) {
    throw new InvalidUsageArgumentError(
      "limit",
      "--limit must be an integer from 1 to 10000",
    );
  }
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new InvalidUsageArgumentError(
      "limit",
      "--limit must be an integer from 1 to 10000",
    );
  }
  return limit;
}

export interface UsageAggregate {
  site: string;
  cmd: string;
  transport: UsageRecord["transport"];
  count: number;
  errorRate: number;
  medianMs: number;
  p95Ms: number;
  totalBytes: number;
  totalTokens: number;
}

export function aggregate(records: UsageRecord[]): UsageAggregate[] {
  const buckets = new Map<string, UsageRecord[]>();
  for (const record of records) {
    const key = `${record.transport}\0${record.site}\0${record.cmd}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(record);
    else buckets.set(key, [record]);
  }

  const result: UsageAggregate[] = [];
  for (const recordsForCommand of buckets.values()) {
    const first = recordsForCommand[0];
    const sortedMs = recordsForCommand
      .map((record) => record.ms)
      .sort((a, b) => a - b);
    const errorCount = recordsForCommand.filter(
      (record) => record.exit !== 0 && record.exit !== 66,
    ).length;
    result.push({
      site: first.site,
      cmd: first.cmd,
      transport: first.transport,
      count: recordsForCommand.length,
      errorRate: errorCount / recordsForCommand.length,
      medianMs: percentile(sortedMs, 0.5),
      p95Ms: percentile(sortedMs, 0.95),
      totalBytes: recordsForCommand.reduce(
        (sum, record) => sum + record.bytes,
        0,
      ),
      totalTokens: recordsForCommand.reduce(
        (sum, record) => sum + record.tokens,
        0,
      ),
    });
  }
  return result.sort(
    (left, right) =>
      right.count - left.count ||
      left.site.localeCompare(right.site) ||
      left.cmd.localeCompare(right.cmd) ||
      left.transport.localeCompare(right.transport),
  );
}

function parseLegacyUsageRecord(value: unknown): UsageRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("record must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.ts !== "string" ||
    !Number.isFinite(Date.parse(record.ts)) ||
    typeof record.site !== "string" ||
    typeof record.cmd !== "string" ||
    typeof record.strategy !== "string" ||
    !finiteNonNegative(record.tokens) ||
    !finiteNonNegative(record.ms) ||
    !finiteNonNegative(record.bytes) ||
    typeof record.exit !== "number" ||
    !Number.isInteger(record.exit)
  ) {
    throw new Error("record does not match the legacy usage schema");
  }
  const transport =
    typeof record.transport === "string" &&
    ["cli", "mcp", "acp", "bench", "hub"].includes(record.transport)
      ? (record.transport as UsageRecord["transport"])
      : "cli";
  return {
    ts: record.ts,
    site: record.site,
    cmd: record.cmd,
    strategy: record.strategy,
    transport,
    tokens: record.tokens,
    ms: record.ms,
    bytes: record.bytes,
    exit: record.exit,
  };
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function percentile(sorted: number[], percentileValue: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * percentileValue;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}
