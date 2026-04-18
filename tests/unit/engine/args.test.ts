/**
 * Tests for the agent-native ArgBag resolver. Covers the TC0 thesis:
 * shell-derived args are lossy when payloads contain quotes/emoji/JSON;
 * stdin and --args-file channels must survive every pathological payload.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveArgs, readArgsFile } from "../../../src/engine/args.js";
import type { AdapterArg } from "../../../src/types.js";

const schema: AdapterArg[] = [
  { name: "query", type: "str", positional: true, required: true },
  { name: "limit", type: "int", default: 10 },
  { name: "locale", type: "str", default: "en_US" },
];

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "unicli-args-test-"));
});

afterEach(() => {
  try {
    unlinkSync(join(tmp, "args.json"));
  } catch {
    /* ignore */
  }
});

describe("resolveArgs — shell channel (baseline)", () => {
  it("merges positional + option + default", () => {
    const r = resolveArgs({
      opts: { limit: "25" },
      positionals: ["hello"],
      schema,
      stdinIsTTY: true,
    });
    expect(r.args.query).toBe("hello");
    expect(r.args.limit).toBe(25);
    expect(r.args.locale).toBe("en_US");
    expect(r.source).toBe("shell");
  });

  it("coerces int/bool/float types", () => {
    const s: AdapterArg[] = [
      { name: "n", type: "int", default: 0 },
      { name: "ratio", type: "float", default: 0 },
      { name: "flag", type: "bool", default: false },
    ];
    const r = resolveArgs({
      opts: { n: "42", ratio: "0.5", flag: "true" },
      positionals: [],
      schema: s,
      stdinIsTTY: true,
    });
    expect(r.args.n).toBe(42);
    expect(r.args.ratio).toBeCloseTo(0.5);
    expect(r.args.flag).toBe(true);
  });
});

describe("resolveArgs — args-file channel", () => {
  it("reads JSON file and overrides shell args", () => {
    const path = join(tmp, "args.json");
    writeFileSync(
      path,
      JSON.stringify({ query: "from-file", limit: 99 }),
      "utf-8",
    );
    const r = resolveArgs({
      opts: { limit: "25" },
      positionals: ["from-shell"],
      schema,
      argsFile: path,
      stdinIsTTY: true,
    });
    expect(r.args.query).toBe("from-file");
    expect(r.args.limit).toBe(99);
    expect(r.source).toBe("mixed");
  });

  it("throws with clear message on missing file", () => {
    expect(() =>
      resolveArgs({
        opts: {},
        positionals: [],
        schema,
        argsFile: "/nonexistent/path.json",
        stdinIsTTY: true,
      }),
    ).toThrow(/cannot read --args-file/);
  });

  it("rejects non-object JSON", () => {
    const path = join(tmp, "args.json");
    writeFileSync(path, "[1,2,3]", "utf-8");
    expect(() => readArgsFile(path)).toThrow(/must be a JSON object/);
  });
});

describe("resolveArgs — stdin channel (TC0 escape hatch)", () => {
  it("auto-detects JSON body when non-TTY", () => {
    const stdinBody = JSON.stringify({
      query: "payload with \"quotes\" and 'emoji' 🎉\nand newlines",
      limit: 5,
    });
    const r = resolveArgs({
      opts: {},
      positionals: [],
      schema,
      stdinBody,
      stdinIsTTY: false,
    });
    expect(r.args.query).toContain("🎉");
    expect(r.args.query).toContain("\n");
    expect(r.args.limit).toBe(5);
    expect(r.source).toBe("stdin");
  });

  it("carries payloads with max nested quoting (ICS≥8)", () => {
    // The exact payload that kills shell invocation: 4 levels of nesting,
    // backslashes, and a `$` that the shell would expand.
    const pathological = 'outer "middle \\"inner `backtick` $var\\" end" close';
    const stdinBody = JSON.stringify({ query: pathological });
    const r = resolveArgs({
      opts: {},
      positionals: [],
      schema,
      stdinBody,
      stdinIsTTY: false,
    });
    expect(r.args.query).toBe(pathological);
  });

  it("rejects non-JSON stdin when `-` was requested", () => {
    expect(() =>
      resolveArgs({
        opts: {},
        positionals: ["-"],
        schema,
        stdinBody: "not json",
        stdinIsTTY: false,
      }),
    ).toThrow(/JSON object required/);
  });

  it("stdin takes precedence over file and shell", () => {
    const path = join(tmp, "args.json");
    writeFileSync(
      path,
      JSON.stringify({ query: "from-file", limit: 99 }),
      "utf-8",
    );
    const r = resolveArgs({
      opts: { limit: "25" },
      positionals: ["from-shell"],
      schema,
      argsFile: path,
      stdinBody: JSON.stringify({ query: "from-stdin" }),
      stdinIsTTY: false,
    });
    expect(r.args.query).toBe("from-stdin");
    expect(r.args.limit).toBe(99); // file, not overridden by stdin
    expect(r.source).toBe("mixed");
  });

  it("ignores empty / whitespace-only stdin", () => {
    const r = resolveArgs({
      opts: {},
      positionals: ["hello"],
      schema,
      stdinBody: "   \n  ",
      stdinIsTTY: false,
    });
    expect(r.args.query).toBe("hello");
    expect(r.source).toBe("shell");
  });

  it("ignores stdin when TTY is detected (interactive shell)", () => {
    const r = resolveArgs({
      opts: {},
      positionals: ["hello"],
      schema,
      stdinIsTTY: true,
    });
    expect(r.args.query).toBe("hello");
    expect(r.source).toBe("shell");
  });
});

describe("resolveArgs — schema evolution tolerance", () => {
  it("passes through extra JSON keys not in schema", () => {
    const r = resolveArgs({
      opts: {},
      positionals: [],
      schema,
      stdinBody: JSON.stringify({
        query: "x",
        unknown_future_field: "future-value",
        nested: { a: 1 },
      }),
      stdinIsTTY: false,
    });
    expect(r.args.unknown_future_field).toBe("future-value");
    expect(r.args.nested).toEqual({ a: 1 });
  });
});
