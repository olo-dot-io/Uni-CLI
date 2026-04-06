/**
 * Tests for the self-repair loop components.
 * Tests individual functions — does NOT test the full engine loop (requires Claude CLI).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  extractMetric,
  buildDefaultConfig,
} from "../../src/engine/repair/config.js";
import { RepairLogger, type LogEntry } from "../../src/engine/repair/logger.js";
import {
  buildRepairPrompt,
  getStuckHint,
  type RepairLoopContext,
} from "../../src/engine/repair/prompt.js";
import {
  classifyFailure,
  type FailureType,
} from "../../src/engine/repair/failure-classifier.js";
import { judgeOutput } from "../../src/engine/repair/eval.js";
import type { RepairContext } from "../../src/engine/diagnostic.js";

// ── extractMetric ────────────────────────────────────────────────────

describe("extractMetric", () => {
  const pattern = /SCORE=(\d+)\/(\d+)/;

  it("parses SCORE=5/10 and returns 5", () => {
    const result = extractMetric("Some output SCORE=5/10 done", pattern);
    expect(result).toBe(5);
  });

  it("parses SCORE=0/10 and returns 0", () => {
    const result = extractMetric("SCORE=0/10", pattern);
    expect(result).toBe(0);
  });

  it("parses SCORE=10/10 and returns 10", () => {
    const result = extractMetric("SCORE=10/10 perfect!", pattern);
    expect(result).toBe(10);
  });

  it("returns null when no match", () => {
    const result = extractMetric("no score here", pattern);
    expect(result).toBeNull();
  });

  it("returns null for empty string", () => {
    const result = extractMetric("", pattern);
    expect(result).toBeNull();
  });

  it("works with custom patterns", () => {
    const custom = /passed:\s*(\d+)/;
    const result = extractMetric("passed: 7 out of 10", custom);
    expect(result).toBe(7);
  });
});

// ── buildDefaultConfig ──────────────────────────────────────────────

describe("buildDefaultConfig", () => {
  it("builds defaults for site only", () => {
    const config = buildDefaultConfig("zhihu");
    expect(config.site).toBe("zhihu");
    expect(config.command).toBeUndefined();
    expect(config.maxIterations).toBe(20);
    expect(config.timeout).toBe(90_000);
    expect(config.direction).toBe("higher");
    expect(config.minDelta).toBe(0);
    expect(config.scope).toEqual([
      "src/adapters/zhihu/**/*.yaml",
      "src/adapters/zhihu/**/*.ts",
    ]);
    expect(config.verify).toBe("npx unicli test zhihu");
    expect(config.guard).toBeUndefined();
  });

  it("builds defaults for site + command", () => {
    const config = buildDefaultConfig("zhihu", "hot");
    expect(config.site).toBe("zhihu");
    expect(config.command).toBe("hot");
    expect(config.verify).toBe("npx unicli test zhihu hot");
  });

  it("metricPattern matches SCORE=N/M format", () => {
    const config = buildDefaultConfig("test");
    const match = config.metricPattern.exec("SCORE=3/5");
    expect(match).not.toBeNull();
    expect(match![1]).toBe("3");
    expect(match![2]).toBe("5");
  });
});

// ── RepairLogger ────────────────────────────────────────────────────

describe("RepairLogger", () => {
  let tempDir: string;
  let originalHome: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "repair-logger-test-"));
    originalHome = process.env.HOME ?? "";
    // Override HOME to use temp directory
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates log file with header on construction", () => {
    const logger = new RepairLogger("testsite");
    const logPath = join(tempDir, ".unicli", "repair", "testsite", "log.tsv");
    const content = readFileSync(logPath, "utf-8");
    expect(content).toContain("iteration\tmetric\tstatus");
  });

  it("appends entries and reads them back", () => {
    const logger = new RepairLogger("testsite");

    const entry: LogEntry = {
      iteration: 1,
      metric: 5,
      status: "keep",
      delta: 5,
      summary: "first fix",
      timestamp: "2026-01-01T00:00:00.000Z",
    };
    logger.append(entry);

    const all = logger.readAll();
    expect(all).toHaveLength(1);
    expect(all[0].iteration).toBe(1);
    expect(all[0].metric).toBe(5);
    expect(all[0].status).toBe("keep");
    expect(all[0].delta).toBe(5);
    expect(all[0].summary).toBe("first fix");
  });

  it("readLast returns last N entries", () => {
    const logger = new RepairLogger("testsite");

    for (let i = 1; i <= 5; i++) {
      logger.append({
        iteration: i,
        metric: i,
        status: "keep",
        delta: 1,
        summary: `iteration ${i}`,
        timestamp: new Date().toISOString(),
      });
    }

    const last3 = logger.readLast(3);
    expect(last3).toHaveLength(3);
    expect(last3[0].iteration).toBe(3);
    expect(last3[2].iteration).toBe(5);
  });

  it("readLast with N > total returns all entries", () => {
    const logger = new RepairLogger("testsite");
    logger.append({
      iteration: 1,
      metric: 1,
      status: "keep",
      delta: 1,
      summary: "only one",
      timestamp: new Date().toISOString(),
    });

    const result = logger.readLast(100);
    expect(result).toHaveLength(1);
  });

  it("consecutiveDiscards counts trailing discards", () => {
    const logger = new RepairLogger("testsite");
    logger.append({
      iteration: 1,
      metric: 5,
      status: "keep",
      delta: 5,
      summary: "kept",
      timestamp: new Date().toISOString(),
    });
    logger.append({
      iteration: 2,
      metric: 3,
      status: "discard",
      delta: -2,
      summary: "bad",
      timestamp: new Date().toISOString(),
    });
    logger.append({
      iteration: 3,
      metric: 2,
      status: "discard",
      delta: -3,
      summary: "worse",
      timestamp: new Date().toISOString(),
    });

    expect(logger.consecutiveDiscards()).toBe(2);
  });

  it("consecutiveDiscards returns 0 when last entry is keep", () => {
    const logger = new RepairLogger("testsite");
    logger.append({
      iteration: 1,
      metric: 5,
      status: "discard",
      delta: -1,
      summary: "bad",
      timestamp: new Date().toISOString(),
    });
    logger.append({
      iteration: 2,
      metric: 8,
      status: "keep",
      delta: 3,
      summary: "good",
      timestamp: new Date().toISOString(),
    });

    expect(logger.consecutiveDiscards()).toBe(0);
  });

  it("consecutiveDiscards returns 0 for empty log", () => {
    const logger = new RepairLogger("testsite");
    expect(logger.consecutiveDiscards()).toBe(0);
  });

  it("sanitizes tabs and newlines in summary", () => {
    const logger = new RepairLogger("testsite");
    logger.append({
      iteration: 1,
      metric: 5,
      status: "keep",
      delta: 5,
      summary: "has\ttabs\nand\nnewlines",
      timestamp: new Date().toISOString(),
    });

    const all = logger.readAll();
    expect(all[0].summary).toBe("has tabs and newlines");
  });
});

// ── buildRepairPrompt ───────────────────────────────────────────────

describe("buildRepairPrompt", () => {
  const defaultConfig = buildDefaultConfig("zhihu", "hot");

  const baseContext: RepairLoopContext = {
    iteration: 3,
    bestMetric: 5,
    currentMetric: 3,
    recentLog: [],
    gitLog: "abc123 feat: something\ndef456 fix: another",
    scopeFiles: ["src/adapters/zhihu/hot.yaml"],
    consecutiveDiscards: 0,
  };

  it("contains the goal with current and best scores", () => {
    const prompt = buildRepairPrompt(baseContext, defaultConfig);
    expect(prompt).toContain("Current score: 3");
    expect(prompt).toContain("Best score: 5");
  });

  it("contains scope patterns and resolved files", () => {
    const prompt = buildRepairPrompt(baseContext, defaultConfig);
    expect(prompt).toContain("src/adapters/zhihu/**/*.yaml");
    expect(prompt).toContain("src/adapters/zhihu/hot.yaml");
  });

  it("contains the verify command", () => {
    const prompt = buildRepairPrompt(baseContext, defaultConfig);
    expect(prompt).toContain("npx unicli test zhihu hot");
  });

  it("contains rules about atomic changes", () => {
    const prompt = buildRepairPrompt(baseContext, defaultConfig);
    expect(prompt).toContain("ONE atomic change");
    expect(prompt).toContain("Do NOT refactor");
  });

  it("includes git log when present", () => {
    const prompt = buildRepairPrompt(baseContext, defaultConfig);
    expect(prompt).toContain("abc123 feat: something");
  });

  it("includes failure guidance when provided", () => {
    const ctx = { ...baseContext, failureGuidance: "The CSS selector is broken." };
    const prompt = buildRepairPrompt(ctx, defaultConfig);
    expect(prompt).toContain("Failure Analysis");
    expect(prompt).toContain("The CSS selector is broken.");
  });

  it("includes stuck hint when provided", () => {
    const ctx = { ...baseContext, stuckHint: "Try the OPPOSITE" };
    const prompt = buildRepairPrompt(ctx, defaultConfig);
    expect(prompt).toContain("Hint (you are stuck)");
    expect(prompt).toContain("Try the OPPOSITE");
  });

  it("includes recent log entries when present", () => {
    const ctx: RepairLoopContext = {
      ...baseContext,
      recentLog: [
        {
          iteration: 1,
          metric: 3,
          status: "keep",
          delta: 3,
          summary: "initial fix",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    const prompt = buildRepairPrompt(ctx, defaultConfig);
    expect(prompt).toContain("Recent Repair History");
    expect(prompt).toContain("initial fix");
  });
});

// ── getStuckHint ────────────────────────────────────────────────────

describe("getStuckHint", () => {
  it("returns undefined for 0 consecutive discards", () => {
    expect(getStuckHint(0)).toBeUndefined();
  });

  it("returns undefined for 1 consecutive discard", () => {
    expect(getStuckHint(1)).toBeUndefined();
  });

  it("returns undefined for 2 consecutive discards", () => {
    expect(getStuckHint(2)).toBeUndefined();
  });

  it("returns re-read hint at 3", () => {
    const hint = getStuckHint(3);
    expect(hint).toBeDefined();
    expect(hint).toContain("Re-read ALL scope files");
  });

  it("returns review log hint at 5", () => {
    const hint = getStuckHint(5);
    expect(hint).toBeDefined();
    expect(hint).toContain("Review the entire results log");
  });

  it("returns opposite hint at 7", () => {
    const hint = getStuckHint(7);
    expect(hint).toBeDefined();
    expect(hint).toContain("OPPOSITE");
  });

  it("returns radical change hint at 9", () => {
    const hint = getStuckHint(9);
    expect(hint).toBeDefined();
    expect(hint).toContain("radical");
  });

  it("returns simplify hint at 11", () => {
    const hint = getStuckHint(11);
    expect(hint).toBeDefined();
    expect(hint).toContain("Simplify");
  });

  it("returns simplify hint for values >= 11", () => {
    expect(getStuckHint(15)).toContain("Simplify");
  });
});

// ── classifyFailure ─────────────────────────────────────────────────

describe("classifyFailure", () => {
  function makeContext(
    overrides: Partial<RepairContext> = {},
  ): RepairContext {
    return {
      error: { code: "GENERIC_ERROR", message: "something failed" },
      adapter: { site: "testsite", command: "cmd" },
      timestamp: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
  }

  it("detects selector_miss from error message", () => {
    const ctx = makeContext({
      error: {
        code: "GENERIC_ERROR",
        message: "element not found in page",
      },
    });
    const result = classifyFailure(ctx);
    expect(result.type).toBe("selector_miss");
    expect(result.guidance).toContain("CSS selector");
  });

  it("detects selector_miss from error code", () => {
    const ctx = makeContext({
      error: { code: "SELECTOR_MISS", message: "could not click" },
    });
    const result = classifyFailure(ctx);
    expect(result.type).toBe("selector_miss");
  });

  it("detects selector_miss from 'not found in DOM'", () => {
    const ctx = makeContext({
      error: {
        code: "GENERIC_ERROR",
        message: "Target not found in DOM tree",
      },
    });
    const result = classifyFailure(ctx);
    expect(result.type).toBe("selector_miss");
  });

  it("detects auth_expired from 401 status", () => {
    const ctx = makeContext({
      error: {
        code: "GENERIC_ERROR",
        message: "HTTP error 401 Unauthorized",
      },
    });
    const result = classifyFailure(ctx);
    expect(result.type).toBe("auth_expired");
    expect(result.preAction).toContain("auth setup testsite");
  });

  it("detects auth_expired from 403 status", () => {
    const ctx = makeContext({
      error: { code: "GENERIC_ERROR", message: "HTTP 403 forbidden" },
    });
    const result = classifyFailure(ctx);
    expect(result.type).toBe("auth_expired");
  });

  it("detects auth_expired from 'login' in message", () => {
    const ctx = makeContext({
      error: {
        code: "GENERIC_ERROR",
        message: "Redirected to login page",
      },
    });
    const result = classifyFailure(ctx);
    expect(result.type).toBe("auth_expired");
  });

  it("detects auth_expired from network 401", () => {
    const ctx = makeContext({
      page: {
        url: "https://example.com",
        snapshot: "",
        consoleErrors: [],
        networkRequests: [
          { url: "https://api.example.com/data", method: "GET", status: 401, type: "fetch" },
        ],
      },
    });
    const result = classifyFailure(ctx);
    expect(result.type).toBe("auth_expired");
  });

  it("detects api_versioned from 404 status", () => {
    const ctx = makeContext({
      error: { code: "GENERIC_ERROR", message: "HTTP 404 Not Found" },
    });
    const result = classifyFailure(ctx);
    expect(result.type).toBe("api_versioned");
    expect(result.guidance).toContain("endpoint");
  });

  it("detects api_versioned from 'unexpected' in message", () => {
    const ctx = makeContext({
      error: {
        code: "GENERIC_ERROR",
        message: "Unexpected response shape",
      },
    });
    const result = classifyFailure(ctx);
    expect(result.type).toBe("api_versioned");
  });

  it("detects rate_limited from 429 status", () => {
    const ctx = makeContext({
      error: {
        code: "GENERIC_ERROR",
        message: "HTTP 429 Too Many Requests",
      },
    });
    const result = classifyFailure(ctx);
    expect(result.type).toBe("rate_limited");
    expect(result.guidance).toContain("Rate limited");
  });

  it("detects rate_limited from 'throttle' in message", () => {
    const ctx = makeContext({
      error: { code: "GENERIC_ERROR", message: "Request throttle active" },
    });
    const result = classifyFailure(ctx);
    expect(result.type).toBe("rate_limited");
  });

  it("returns unknown for unclassifiable errors", () => {
    const ctx = makeContext({
      error: {
        code: "GENERIC_ERROR",
        message: "Something completely random happened",
      },
    });
    const result = classifyFailure(ctx);
    expect(result.type).toBe("unknown");
    expect(result.guidance).toContain("Unknown failure");
    expect(result.preAction).toBeUndefined();
  });

  it("has correct preAction for auth_expired", () => {
    const ctx = makeContext({
      error: { code: "GENERIC_ERROR", message: "unauthorized access" },
      adapter: { site: "zhihu", command: "hot" },
    });
    const result = classifyFailure(ctx);
    expect(result.type).toBe("auth_expired");
    expect(result.preAction).toBe("npx unicli auth setup zhihu");
  });
});

// ── judgeOutput ─────────────────────────────────────────────────────

describe("judgeOutput", () => {
  it("contains: returns true when output includes value", () => {
    expect(
      judgeOutput("hello world", { type: "contains", value: "world" }),
    ).toBe(true);
  });

  it("contains: returns false when output does not include value", () => {
    expect(
      judgeOutput("hello", { type: "contains", value: "world" }),
    ).toBe(false);
  });

  it("nonEmpty: returns true for non-empty output", () => {
    expect(judgeOutput("some output", { type: "nonEmpty" })).toBe(true);
  });

  it("nonEmpty: returns false for empty/whitespace output", () => {
    expect(judgeOutput("   \n  ", { type: "nonEmpty" })).toBe(false);
  });

  it("arrayMinLength: returns true when JSON array meets minimum", () => {
    expect(
      judgeOutput('[1,2,3]', { type: "arrayMinLength", value: 3 }),
    ).toBe(true);
  });

  it("arrayMinLength: returns false when JSON array is too short", () => {
    expect(
      judgeOutput('[1]', { type: "arrayMinLength", value: 3 }),
    ).toBe(false);
  });

  it("arrayMinLength: returns false for non-JSON output", () => {
    expect(
      judgeOutput("not json", { type: "arrayMinLength", value: 1 }),
    ).toBe(false);
  });

  it("arrayMinLength: returns false for non-array JSON", () => {
    expect(
      judgeOutput('{"a":1}', { type: "arrayMinLength", value: 1 }),
    ).toBe(false);
  });

  it("matchesPattern: returns true when regex matches", () => {
    expect(
      judgeOutput("version 2.5.0", {
        type: "matchesPattern",
        value: "\\d+\\.\\d+\\.\\d+",
      }),
    ).toBe(true);
  });

  it("matchesPattern: returns false when regex does not match", () => {
    expect(
      judgeOutput("no version", {
        type: "matchesPattern",
        value: "^\\d+\\.\\d+$",
      }),
    ).toBe(false);
  });
});
