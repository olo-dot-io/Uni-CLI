/**
 * @owner   tests::unit::usage-ledger
 * @does    Proves strict legacy parsing, event projection, argument validation, filtering, and aggregation.
 * @needs   real temporary JSONL files and local event store
 * @feeds   `unicli usage report` regression coverage
 * @breaks  Silent corruption or widened invalid filters produces false operational conclusions.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  aggregate,
  filterSince,
  InvalidUsageArgumentError,
  loadUsage,
  loadUsageSources,
  parseSinceArg,
  parseUsageLimit,
  UsageLedgerError,
  type UsageRecord,
} from "../../src/runtime/usage-ledger.js";
import {
  _resetLocalEventLogForTests,
  appendLocalEvent,
  createLocalEvent,
  createLocalEventStore,
} from "../../src/runtime/local-event-log.js";

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    ts: "2026-07-18T12:00:00.000Z",
    site: "github",
    cmd: "search",
    strategy: "public",
    transport: "cli",
    tokens: 0,
    ms: 100,
    bytes: 1000,
    exit: 0,
    ...overrides,
  };
}

describe("usage sources", () => {
  let tempDir: string;
  let ledgerPath: string;
  let eventRoot: string;
  const initialNoLog = process.env.UNICLI_NO_LOG;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "unicli-usage-"));
    ledgerPath = join(tempDir, "usage.jsonl");
    eventRoot = join(tempDir, "events");
    delete process.env.UNICLI_NO_LOG;
    delete process.env.UNICLI_NO_LEDGER;
    _resetLocalEventLogForTests();
  });

  afterEach(() => {
    if (initialNoLog === undefined) delete process.env.UNICLI_NO_LOG;
    else process.env.UNICLI_NO_LOG = initialNoLog;
    delete process.env.UNICLI_NO_LEDGER;
    _resetLocalEventLogForTests();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("loads valid legacy rows and defaults their transport to CLI", () => {
    const legacy = { ...record() } as Record<string, unknown>;
    delete legacy.transport;
    writeFileSync(ledgerPath, `${JSON.stringify(legacy)}\n`);

    expect(loadUsage(ledgerPath)).toEqual([record()]);
  });

  it("surfaces malformed JSON and schema drift with exact lines", () => {
    writeFileSync(ledgerPath, `${JSON.stringify(record())}\nnot-json\n`);
    expect(() => loadUsage(ledgerPath)).toThrowError(
      expect.objectContaining<Partial<UsageLedgerError>>({
        code: "malformed_jsonl",
        line: 2,
      }),
    );

    writeFileSync(ledgerPath, `${JSON.stringify({ site: "github" })}\n`);
    expect(() => loadUsage(ledgerPath)).toThrowError(
      expect.objectContaining<Partial<UsageLedgerError>>({
        code: "malformed_jsonl",
        line: 1,
      }),
    );
  });

  it("rejects unknown legacy fields and invalid explicit transports", () => {
    writeFileSync(
      ledgerPath,
      `${JSON.stringify({ ...record(), secret: "must-not-be-ignored" })}\n`,
    );
    expect(() => loadUsage(ledgerPath)).toThrowError(
      expect.objectContaining<Partial<UsageLedgerError>>({
        code: "malformed_jsonl",
        line: 1,
      }),
    );

    writeFileSync(
      ledgerPath,
      `${JSON.stringify({ ...record(), transport: "unknown" })}\n`,
    );
    expect(() => loadUsage(ledgerPath)).toThrowError(
      expect.objectContaining<Partial<UsageLedgerError>>({
        code: "malformed_jsonl",
        line: 1,
      }),
    );
  });

  it("combines legacy rows with tool events across transports", () => {
    writeFileSync(ledgerPath, `${JSON.stringify(record())}\n`);
    const eventStore = createLocalEventStore({ rootDir: eventRoot });
    const eventTimestamp = new Date().toISOString();
    expect(
      appendLocalEvent(
        createLocalEvent({
          event_name: "unicli.tool.call.completed",
          timestamp: eventTimestamp,
          invocation_id: "01KTEST0000000000000000000",
          transport: "mcp",
          command: "huggingface.search",
          site: "huggingface",
          cmd: "search",
          strategy: "public",
          operation_role: "standalone",
          outcome: "error",
          exit_code: 75,
          duration_ms: 250,
          result_count: 0,
          result_bytes: 0,
          error_type: "rate_limited",
          retryable: true,
        }),
        eventStore,
      ).ok,
    ).toBe(true);

    const sources = loadUsageSources({
      ledgerPath,
      eventStore,
      now: Date.parse(eventTimestamp),
    });
    expect(sources).toMatchObject({
      legacy_records: 1,
      event_records: 1,
    });
    expect(sources.records).toEqual([
      record(),
      record({
        ts: eventTimestamp,
        site: "huggingface",
        transport: "mcp",
        ms: 250,
        bytes: 0,
        exit: 75,
      }),
    ]);
  });

  it("keeps nested CLI work while excluding only its direct child event", () => {
    const eventStore = createLocalEventStore({ rootDir: eventRoot });
    appendLocalEvent(
      createLocalEvent({
        event_name: "unicli.cli.invocation.completed",
        invocation_id: "cli-1",
        transport: "cli",
        command: "github.search",
        operation_role: "invocation",
        outcome: "success",
        exit_code: 0,
        duration_ms: 10,
      }),
      eventStore,
    );
    appendLocalEvent(
      createLocalEvent({
        event_name: "unicli.tool.call.completed",
        invocation_id: "tool-1",
        trace_id: "tool-1",
        parent_invocation_id: "cli-1",
        transport: "cli",
        command: "github.search",
        site: "github",
        cmd: "search",
        strategy: "public",
        operation_role: "direct",
        outcome: "success",
        exit_code: 0,
        duration_ms: 8,
      }),
      eventStore,
    );
    appendLocalEvent(
      createLocalEvent({
        event_name: "unicli.tool.call.completed",
        invocation_id: "tool-2",
        trace_id: "tool-2",
        parent_invocation_id: "cli-1",
        transport: "cli",
        command: "huggingface.search",
        site: "huggingface",
        cmd: "search",
        strategy: "public",
        operation_role: "nested",
        outcome: "success",
        exit_code: 0,
        duration_ms: 7,
      }),
      eventStore,
    );

    const sources = loadUsageSources({
      ledgerPath,
      eventStore,
      now: Date.parse("2026-07-18T13:00:00.000Z"),
    });
    expect(sources.event_records).toBe(2);
    expect(sources.records[0]).toMatchObject({
      site: "github",
      cmd: "search",
      transport: "cli",
      ms: 10,
    });
    expect(sources.records[1]).toMatchObject({
      site: "huggingface",
      cmd: "search",
      transport: "cli",
      ms: 7,
    });
  });

  it("uses the kernel child identity for MCP adapter calls without double counting", () => {
    const eventStore = createLocalEventStore({ rootDir: eventRoot });
    appendLocalEvent(
      createLocalEvent({
        event_name: "unicli.tool.call.completed",
        invocation_id: "mcp-1",
        transport: "mcp",
        command: "mcp.unicli_run",
        site: "mcp",
        cmd: "unicli_run",
        strategy: "handler",
        operation_role: "invocation",
        outcome: "success",
        exit_code: 0,
        duration_ms: 20,
      }),
      eventStore,
    );
    appendLocalEvent(
      createLocalEvent({
        event_name: "unicli.tool.call.completed",
        invocation_id: "tool-1",
        parent_invocation_id: "mcp-1",
        trace_id: "tool-1",
        transport: "mcp",
        command: "github.search",
        site: "github",
        cmd: "search",
        strategy: "public",
        operation_role: "direct",
        outcome: "success",
        exit_code: 0,
        duration_ms: 18,
      }),
      eventStore,
    );

    const sources = loadUsageSources({
      ledgerPath,
      eventStore,
      now: Date.parse("2026-07-18T13:00:00.000Z"),
    });
    expect(sources.event_records).toBe(1);
    expect(sources.records[0]).toMatchObject({
      site: "github",
      cmd: "search",
      transport: "mcp",
      ms: 18,
    });
  });
});

describe("usage argument parsing", () => {
  it("parses supported positive windows", () => {
    expect(parseSinceArg(undefined)).toBe(0);
    expect(parseSinceArg("7d")).toBe(7 * 86_400_000);
    expect(parseSinceArg("24h")).toBe(24 * 3_600_000);
    expect(parseSinceArg("30m")).toBe(30 * 60_000);
    expect(parseSinceArg("60s")).toBe(60_000);
    expect(parseSinceArg("60")).toBe(60_000);
  });

  it.each(["", "0", "7days", "-1h", "1.5h"])(
    "rejects invalid --since value %j",
    (value) => {
      expect(() => parseSinceArg(value)).toThrowError(
        expect.objectContaining<Partial<InvalidUsageArgumentError>>({
          argument: "since",
        }),
      );
    },
  );

  it("accepts bounded integer limits and rejects fallback-prone inputs", () => {
    expect(parseUsageLimit(undefined)).toBe(20);
    expect(parseUsageLimit("1")).toBe(1);
    expect(parseUsageLimit("10000")).toBe(10_000);
    for (const value of ["0", "-1", "1.5", "20junk", "10001", ""]) {
      expect(() => parseUsageLimit(value)).toThrowError(
        expect.objectContaining<Partial<InvalidUsageArgumentError>>({
          argument: "limit",
        }),
      );
    }
  });
});

describe("usage filtering and aggregation", () => {
  it("keeps records on the inclusive trailing-window boundary", () => {
    const now = Date.parse("2026-07-18T12:00:00Z");
    const records = [
      record({ ts: "2026-07-11T12:00:00Z" }),
      record({ ts: "2026-07-18T11:59:00Z" }),
      record({ ts: "2026-07-01T12:00:00Z" }),
    ];
    expect(filterSince(records, parseSinceArg("7d"), now)).toHaveLength(2);
  });

  it("groups by transport and computes median, p95, errors, and bytes", () => {
    const records = [
      ...Array.from({ length: 10 }, (_, index) =>
        record({
          ms: index * 100,
          exit: index < 9 ? 0 : 1,
        }),
      ),
      record({ transport: "mcp", exit: 66, bytes: 5 }),
    ];
    const rows = aggregate(records);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      transport: "cli",
      count: 10,
      totalBytes: 10_000,
    });
    expect(rows[0].errorRate).toBeCloseTo(0.1, 2);
    expect(rows[0].medianMs).toBeCloseTo(450, 0);
    expect(rows[0].p95Ms).toBeGreaterThan(800);
    expect(rows[1]).toMatchObject({
      transport: "mcp",
      count: 1,
      errorRate: 0,
      totalBytes: 5,
    });
  });

  it("sorts equal-count rows deterministically", () => {
    const rows = aggregate([
      record({ site: "z", cmd: "b" }),
      record({ site: "a", cmd: "c" }),
      record({ site: "a", cmd: "b" }),
    ]);
    expect(rows.map((row) => `${row.site}.${row.cmd}`)).toEqual([
      "a.b",
      "a.c",
      "z.b",
    ]);
  });
});
