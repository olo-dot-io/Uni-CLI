/**
 * Tests for the invocation kernel — the unified entry point every
 * surface (CLI / MCP / ACP / bench) funnels through in v0.213.3.
 *
 * Covers:
 *   - compileAll produces one entry per (adapter, command)
 *   - execute() rejects invalid bag.args with a structured error
 *   - buildInvocation returns null for unknown site/cmd
 *   - Trace IDs are ULIDs (26 chars, Crockford Base32, time-sortable)
 *   - validate() rejects additionalProperties (strict mode)
 *
 * All tests use real ajv — no mocks of the validation layer.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  compileAll,
  buildInvocation,
  execute,
  getCompiled,
  _resetCompiledCacheForTests,
} from "../../../src/engine/invoke.js";
import { AdapterType } from "../../../src/types.js";
import type { AdapterManifest } from "../../../src/types.js";
import { registerAdapter } from "../../../src/registry.js";

function mkAdapter(overrides?: Partial<AdapterManifest>): AdapterManifest {
  return {
    name: "inv-site",
    type: AdapterType.WEB_API,
    commands: {
      hello: {
        name: "hello",
        description: "say hello",
        adapterArgs: [
          { name: "target", type: "str", required: true },
          { name: "limit", type: "int", default: 10 },
        ],
        func: async (_page: unknown, kwargs: Record<string, unknown>) => ({
          greeting: `hi ${String(kwargs.target)}`,
          limit: kwargs.limit,
        }),
      },
      fail: {
        name: "fail",
        adapterArgs: [{ name: "url", type: "str", format: "uri" }],
        func: async () => ({ x: 1 }),
      },
    },
    ...overrides,
  };
}

beforeEach(() => {
  _resetCompiledCacheForTests();
});

describe("compileAll", () => {
  it("produces one CompiledCommand per (adapter, command) in the registry", () => {
    const a = mkAdapter();
    const cache = compileAll([a]);
    expect(cache.size).toBe(2);
    expect(cache.has("inv-site.hello")).toBe(true);
    expect(cache.has("inv-site.fail")).toBe(true);
  });

  it("multiple adapters accumulate", () => {
    const a = mkAdapter();
    const b = mkAdapter({
      name: "other-site",
      commands: {
        one: {
          name: "one",
          adapterArgs: [],
          func: async () => ({}),
        },
      },
    });
    const cache = compileAll([a, b]);
    expect(cache.size).toBe(3);
    expect(cache.has("other-site.one")).toBe(true);
  });

  it("each CompiledCommand exposes jsonSchema + example + channels", () => {
    const a = mkAdapter();
    compileAll([a]);
    const compiled = getCompiled("inv-site", "hello");
    expect(compiled).toBeDefined();
    expect(compiled!.channels).toEqual(["shell", "file", "stdin"]);
    expect(compiled!.jsonSchema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
    });
    expect(compiled!.example).toHaveProperty("target");
    expect(compiled!.example.limit).toBe(10);
    expect(compiled!.argByName.get("target")?.required).toBe(true);
  });
});

describe("validate (draft-2020-12 + strict mode)", () => {
  beforeEach(() => {
    compileAll([mkAdapter()]);
  });

  it("accepts a well-formed payload", () => {
    const compiled = getCompiled("inv-site", "hello")!;
    const res = compiled.validate({ target: "ziming", limit: 5 });
    expect(res.ok).toBe(true);
  });

  it("rejects missing required field", () => {
    const compiled = getCompiled("inv-site", "hello")!;
    const res = compiled.validate({});
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.length).toBeGreaterThan(0);
      expect(res.errors[0].keyword).toBe("required");
    }
  });

  it("rejects additionalProperties (strict mode)", () => {
    const compiled = getCompiled("inv-site", "hello")!;
    const res = compiled.validate({ target: "x", unknownField: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.keyword === "additionalProperties")).toBe(
        true,
      );
    }
  });

  it("rejects a URI format violation (fail-closed format-assertion)", () => {
    const compiled = getCompiled("inv-site", "fail")!;
    const res = compiled.validate({ url: "not a url" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors[0].keyword).toBe("format");
      expect(res.errors[0].message).toContain("uri");
    }
  });

  it("accepts a valid URI", () => {
    const compiled = getCompiled("inv-site", "fail")!;
    const res = compiled.validate({ url: "https://example.com/path" });
    expect(res.ok).toBe(true);
  });
});

describe("buildInvocation", () => {
  beforeEach(() => {
    const a = mkAdapter();
    registerAdapter(a);
    compileAll([a]);
  });

  it("returns null for an unknown site", () => {
    const inv = buildInvocation("cli", "nope", "hello", {
      args: {},
      source: "shell",
    });
    expect(inv).toBeNull();
  });

  it("returns null for an unknown command on a known site", () => {
    const inv = buildInvocation("cli", "inv-site", "missing", {
      args: {},
      source: "shell",
    });
    expect(inv).toBeNull();
  });

  it("returns an Invocation with a ULID trace_id for valid site/cmd", () => {
    const inv = buildInvocation("cli", "inv-site", "hello", {
      args: { target: "ziming" },
      source: "shell",
    });
    expect(inv).not.toBeNull();
    expect(inv!.adapter.name).toBe("inv-site");
    expect(inv!.cmdName).toBe("hello");
    expect(inv!.surface).toBe("cli");
    expect(inv!.trace_id).toHaveLength(26);
    // ULID alphabet is Crockford Base32 — excludes I, L, O, U
    expect(inv!.trace_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("successive trace_ids are distinct and monotonically non-decreasing (time-sortable)", async () => {
    const a = buildInvocation("cli", "inv-site", "hello", {
      args: { target: "x" },
      source: "shell",
    })!;
    // Defer a tick so clock advances at least 1 ms on most runtimes.
    await new Promise((r) => setTimeout(r, 2));
    const b = buildInvocation("cli", "inv-site", "hello", {
      args: { target: "y" },
      source: "shell",
    })!;
    expect(a.trace_id).not.toBe(b.trace_id);
    // First 10 chars encode the ms timestamp.
    expect(b.trace_id.slice(0, 10) >= a.trace_id.slice(0, 10)).toBe(true);
  });
});

describe("execute (end-to-end)", () => {
  beforeEach(() => {
    const a = mkAdapter();
    registerAdapter(a);
    compileAll([a]);
  });

  it("runs the happy path and returns results + success envelope", async () => {
    const inv = buildInvocation("cli", "inv-site", "hello", {
      args: { target: "world" },
      source: "shell",
    })!;
    const res = await execute(inv);
    expect(res.exitCode).toBe(0);
    expect(res.results).toEqual([{ greeting: "hi world", limit: undefined }]);
    expect(res.envelope.error).toBeUndefined();
    expect(res.envelope.next_actions?.length ?? 0).toBeGreaterThan(0);
    // next_actions should have the concrete site/cmd substituted.
    const firstCmd = res.envelope.next_actions![0].command;
    expect(firstCmd).toContain("inv-site");
    expect(firstCmd).toContain("hello");
    expect(firstCmd).not.toContain("${site}");
  });

  it("rejects an invalid bag.args with a structured error matching the schema", async () => {
    const inv = buildInvocation("cli", "inv-site", "fail", {
      args: { url: "not a url" },
      source: "shell",
    })!;
    const res = await execute(inv);
    expect(res.exitCode).toBe(2); // USAGE_ERROR
    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe("invalid_input");
    expect(res.error!.message).toMatch(/uri/);
    expect(res.envelope.error).toEqual(res.error);
  });

  it("populates envelope.duration_ms >= 0", async () => {
    const inv = buildInvocation("cli", "inv-site", "hello", {
      args: { target: "z" },
      source: "shell",
    })!;
    const res = await execute(inv);
    expect(res.envelope.duration_ms).toBeGreaterThanOrEqual(0);
    expect(res.envelope.command).toBe("inv-site.hello");
  });
});
