/**
 * formatter.test.ts — v2 envelope format() + detectFormat + isAgentUA
 *
 * 12 cases covering:
 *   1-3:  json/md/yaml envelope wrap
 *   4-5:  csv/compact unchanged (array-only legacy)
 *   6:    table deprecated → md + stderr warning
 *   7:    error path via ctx.error
 *   8-11: detectFormat env overrides + TTY/non-TTY + CLAUDE_CODE
 *   12:   isAgentUA
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  format,
  detectFormat,
  isAgentUA,
} from "../../../src/output/formatter.js";
import type { AgentContext } from "../../../src/output/envelope.js";

const ctx: AgentContext = {
  command: "twitter.search",
  duration_ms: 15,
  surface: "web",
};

// ── 1. json envelope ─────────────────────────────────────────────────────────

it("1. format json returns parseable v2 envelope with ok/data/meta", () => {
  const out = format([{ a: 1 }], undefined, "json", ctx);
  const env = JSON.parse(out);
  expect(env.ok).toBe(true);
  expect(env.schema_version).toBe("2");
  expect(env.data).toHaveLength(1);
  expect(env.meta.count).toBe(1);
  expect(env.command).toBe("twitter.search");
  expect(env.error).toBeNull();
});

it("1b. format json with empty array gives count=0 data=[]", () => {
  const out = format([], undefined, "json", ctx);
  const env = JSON.parse(out);
  expect(env.ok).toBe(true);
  expect(env.meta.count).toBe(0);
  expect(env.data).toEqual([]);
});

// ── 2. md envelope ───────────────────────────────────────────────────────────

it('2. format md returns frontmatter with ok:true and schema_version:"2"', () => {
  const out = format([{ a: 1 }], undefined, "md", ctx);
  expect(out.startsWith("---\n")).toBe(true);
  expect(out).toContain("ok: true");
  expect(out).toContain('schema_version: "2"');
  expect(out).toContain("## Data");
});

// ── 3. yaml envelope ─────────────────────────────────────────────────────────

it('3. format yaml contains ok:true and schema_version:"2"', () => {
  const out = format([{ a: 1 }], undefined, "yaml", ctx);
  expect(out).toContain("ok: true");
  expect(out).toContain('schema_version: "2"');
});

// ── 4. csv unchanged ─────────────────────────────────────────────────────────

it("4. format csv with empty data returns empty string (unchanged legacy)", () => {
  const out = format([], undefined, "csv", ctx);
  expect(out).toBe("");
});

// ── 5. compact unchanged ─────────────────────────────────────────────────────

it("5. format compact single row returns pipe-separated values (unchanged)", () => {
  const out = format([{ a: 1 }], ["a"], "compact", ctx);
  expect(out).toBe("1");
});

// ── 6. table deprecated ──────────────────────────────────────────────────────

it("6. format table emits stderr warning + returns md envelope", () => {
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const out = format([], undefined, "table", ctx);
  expect(spy).toHaveBeenCalled();
  const msg = String(spy.mock.calls[0]?.[0] ?? "");
  expect(msg).toMatch(/deprecated/i);
  expect(msg).toMatch(/md/i);
  // Falls through to md envelope
  expect(out).toContain("ok: true");
  spy.mockRestore();
});

// ── 7. error path via ctx.error ───────────────────────────────────────────────

it("7. format md with ctx.error returns error envelope with ## Error section", () => {
  const errCtx: AgentContext = {
    ...ctx,
    error: { code: "ENOAUTH", message: "not authenticated" },
  };
  const out = format(null, undefined, "md", errCtx);
  expect(out).toContain("ok: false");
  expect(out).toContain("## Error");
  expect(out).toContain("ENOAUTH");
});

// ── 8. detectFormat non-TTY → md ─────────────────────────────────────────────

it("8. detectFormat non-TTY returns md (v0.213 changed from json)", () => {
  const stored = process.stdout.isTTY;
  Object.defineProperty(process.stdout, "isTTY", {
    value: false,
    configurable: true,
  });
  try {
    expect(detectFormat(undefined)).toBe("md");
  } finally {
    Object.defineProperty(process.stdout, "isTTY", {
      value: stored,
      configurable: true,
    });
  }
});

// ── 9. UNICLI_OUTPUT env override ────────────────────────────────────────────

describe("9. detectFormat env override UNICLI_OUTPUT", () => {
  beforeEach(() => {
    process.env.UNICLI_OUTPUT = "yaml";
  });
  afterEach(() => {
    delete process.env.UNICLI_OUTPUT;
  });

  it("returns yaml when UNICLI_OUTPUT=yaml", () => {
    expect(detectFormat(undefined)).toBe("yaml");
  });
});

// ── 10. CLAUDE_CODE forces md ────────────────────────────────────────────────

describe("10. detectFormat with CLAUDE_CODE=1 returns md on TTY", () => {
  beforeEach(() => {
    process.env.CLAUDE_CODE = "1";
  });
  afterEach(() => {
    delete process.env.CLAUDE_CODE;
  });

  it("returns md (agent UA detected)", () => {
    const stored = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
    try {
      expect(detectFormat(undefined)).toBe("md");
    } finally {
      Object.defineProperty(process.stdout, "isTTY", {
        value: stored,
        configurable: true,
      });
    }
  });
});

// ── 11. explicit explicit wins ────────────────────────────────────────────────

it("11. detectFormat explicit json returns json regardless of env", () => {
  expect(detectFormat("json")).toBe("json");
});

// ── 12. isAgentUA ─────────────────────────────────────────────────────────────

describe("12. isAgentUA", () => {
  afterEach(() => {
    delete process.env.CLAUDE_CODE;
    delete process.env.CODEX_CLI;
    delete process.env.USER_AGENT;
  });

  it("returns true when CLAUDE_CODE is set", () => {
    process.env.CLAUDE_CODE = "1";
    expect(isAgentUA()).toBe(true);
  });

  it("returns true when CODEX_CLI is set", () => {
    process.env.CODEX_CLI = "1";
    expect(isAgentUA()).toBe(true);
  });

  it("returns true when USER_AGENT matches Claude-Code pattern", () => {
    process.env.USER_AGENT = "Claude-Code/1.0";
    expect(isAgentUA()).toBe(true);
  });

  it("returns false when no agent env vars are set", () => {
    expect(isAgentUA()).toBe(false);
  });
});
