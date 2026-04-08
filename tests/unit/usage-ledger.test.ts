/**
 * Cost ledger — append, load, filter, aggregate. Uses a temp ledger path so
 * tests don't pollute the user's real ~/.unicli/usage.jsonl.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  recordUsage,
  loadUsage,
  filterSince,
  parseSinceArg,
  aggregate,
} from "../../src/runtime/usage-ledger.js";

describe("usage-ledger", () => {
  let dir: string;
  let ledger: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "unicli-ledger-"));
    ledger = join(dir, "usage.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the ledger directory and writes JSONL", () => {
    recordUsage(
      {
        site: "hackernews",
        cmd: "top",
        strategy: "public",
        tokens: 0,
        ms: 487,
        bytes: 12450,
        exit: 0,
      },
      ledger,
    );
    expect(existsSync(ledger)).toBe(true);
    const records = loadUsage(ledger);
    expect(records).toHaveLength(1);
    expect(records[0].site).toBe("hackernews");
    expect(records[0].cmd).toBe("top");
    expect(records[0].ms).toBe(487);
    expect(records[0].ts).toMatch(/T/);
  });

  it("appends multiple records", () => {
    for (let i = 0; i < 5; i++) {
      recordUsage(
        {
          site: "x",
          cmd: "y",
          strategy: "public",
          tokens: 0,
          ms: 100 + i,
          bytes: 0,
          exit: 0,
        },
        ledger,
      );
    }
    expect(loadUsage(ledger)).toHaveLength(5);
  });

  it("respects UNICLI_NO_LEDGER opt-out", () => {
    process.env.UNICLI_NO_LEDGER = "1";
    try {
      recordUsage(
        {
          site: "x",
          cmd: "y",
          strategy: "public",
          tokens: 0,
          ms: 1,
          bytes: 0,
          exit: 0,
        },
        ledger,
      );
      expect(existsSync(ledger)).toBe(false);
    } finally {
      delete process.env.UNICLI_NO_LEDGER;
    }
  });

  it("loadUsage returns [] when ledger does not exist", () => {
    expect(loadUsage(ledger)).toEqual([]);
  });

  it("loadUsage skips malformed lines", () => {
    // Write a record then a junk line
    recordUsage(
      {
        site: "x",
        cmd: "y",
        strategy: "public",
        tokens: 0,
        ms: 1,
        bytes: 0,
        exit: 0,
      },
      ledger,
    );
    const { appendFileSync } = require("node:fs") as typeof import("node:fs");
    appendFileSync(ledger, "this is not json\n");
    appendFileSync(ledger, '{"missing":"site"}\n');
    const records = loadUsage(ledger);
    expect(records).toHaveLength(1);
  });
});

describe("filterSince + parseSinceArg", () => {
  it("parses 7d, 24h, 30m, 60s", () => {
    expect(parseSinceArg("7d")).toBe(7 * 86_400_000);
    expect(parseSinceArg("24h")).toBe(24 * 3_600_000);
    expect(parseSinceArg("30m")).toBe(30 * 60_000);
    expect(parseSinceArg("60s")).toBe(60_000);
    expect(parseSinceArg("60")).toBe(60_000);
  });

  it("returns 0 for invalid input", () => {
    expect(parseSinceArg(undefined)).toBe(0);
    expect(parseSinceArg("")).toBe(0);
    expect(parseSinceArg("7days")).toBe(0);
  });

  it("filters records strictly within the window", () => {
    const now = Date.parse("2026-04-08T12:00:00Z");
    const records = [
      {
        ts: "2026-04-01T12:00:00Z", // 7 days ago — boundary
        site: "a",
        cmd: "b",
        strategy: "public",
        tokens: 0,
        ms: 1,
        bytes: 0,
        exit: 0,
      },
      {
        ts: "2026-04-08T11:59:00Z", // 1 minute ago
        site: "a",
        cmd: "b",
        strategy: "public",
        tokens: 0,
        ms: 1,
        bytes: 0,
        exit: 0,
      },
      {
        ts: "2026-03-25T12:00:00Z", // 14 days ago
        site: "a",
        cmd: "b",
        strategy: "public",
        tokens: 0,
        ms: 1,
        bytes: 0,
        exit: 0,
      },
    ];
    const last7Days = filterSince(records, parseSinceArg("7d"), now);
    // Boundary record (exactly 7d) is kept (>=), 14d-old is dropped
    expect(last7Days).toHaveLength(2);
  });
});

describe("aggregate", () => {
  it("computes median, p95, error rate per site/cmd", () => {
    const ts = "2026-04-08T12:00:00Z";
    const records = [
      ...Array.from({ length: 10 }, (_, i) => ({
        ts,
        site: "x",
        cmd: "y",
        strategy: "public",
        tokens: 0,
        ms: i * 100,
        bytes: 1000,
        exit: i < 9 ? 0 : 1, // 1 failure out of 10
      })),
    ];
    const rows = aggregate(records);
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(10);
    expect(rows[0].errorRate).toBeCloseTo(0.1, 2);
    expect(rows[0].medianMs).toBeCloseTo(450, 0);
    expect(rows[0].p95Ms).toBeGreaterThan(800);
    expect(rows[0].totalBytes).toBe(10_000);
  });

  it("does not count exit 66 (empty result) as error", () => {
    const records = [
      {
        ts: "2026-04-08T12:00:00Z",
        site: "x",
        cmd: "y",
        strategy: "public",
        tokens: 0,
        ms: 100,
        bytes: 0,
        exit: 66,
      },
    ];
    expect(aggregate(records)[0].errorRate).toBe(0);
  });

  it("returns rows sorted by count desc", () => {
    const ts = "2026-04-08T12:00:00Z";
    const records = [
      ...Array.from({ length: 5 }, () => ({
        ts,
        site: "a",
        cmd: "1",
        strategy: "public",
        tokens: 0,
        ms: 1,
        bytes: 0,
        exit: 0,
      })),
      ...Array.from({ length: 10 }, () => ({
        ts,
        site: "b",
        cmd: "2",
        strategy: "public",
        tokens: 0,
        ms: 1,
        bytes: 0,
        exit: 0,
      })),
    ];
    const rows = aggregate(records);
    expect(rows[0].cmd).toBe("2");
    expect(rows[0].count).toBe(10);
    expect(rows[1].count).toBe(5);
  });
});
