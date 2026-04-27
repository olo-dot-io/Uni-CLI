/**
 * Tests for the invocation kernel — the unified entry point every
 * surface (CLI / MCP / ACP / bench) funnels through in v0.213.3.
 *
 * Covers:
 *   - compileAll produces one entry per (adapter, command)
 *   - execute() rejects invalid bag.args with a structured error
 *   - buildInvocation returns null for unknown site/cmd
 *   - Trace IDs are ULIDs (26 chars, Crockford Base32, monotonic in same ms)
 *   - validate() rejects additionalProperties (strict mode)
 *   - Success next_actions carry the literal site/cmd (no placeholders)
 *
 * All tests use real ajv — no mocks of the validation layer.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  compileAll,
  buildInvocation,
  execute,
  getCompiled,
  newULID,
  _resetCompiledCacheForTests,
  _resetULIDForTests,
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
      paged: {
        name: "paged",
        paginated: true,
        adapterArgs: [],
        func: async () => ({ ok: true }),
      },
    },
    ...overrides,
  };
}

beforeEach(() => {
  _resetCompiledCacheForTests();
  _resetULIDForTests();
});

describe("compileAll", () => {
  it("produces one CompiledCommand per (adapter, command) in the registry", () => {
    const a = mkAdapter();
    const cache = compileAll([a]);
    expect(cache.size).toBe(3);
    expect(cache.has("inv-site.hello")).toBe(true);
    expect(cache.has("inv-site.fail")).toBe(true);
    expect(cache.has("inv-site.paged")).toBe(true);
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
    expect(cache.size).toBe(4);
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
});

describe("newULID monotonicity (ulid/spec §Monotonicity)", () => {
  it("2000 IDs generated in a tight synchronous loop sort strictly ascending", () => {
    const ids: string[] = [];
    for (let i = 0; i < 2000; i++) ids.push(newULID());
    for (let i = 0; i < ids.length - 1; i++) {
      expect(ids[i] < ids[i + 1]).toBe(true);
    }
  });

  it("IDs remain 26 chars and stay in the Crockford alphabet under load", () => {
    const re = /^[0-9A-HJKMNP-TV-Z]{26}$/;
    for (let i = 0; i < 500; i++) {
      const id = newULID();
      expect(id).toHaveLength(26);
      expect(id).toMatch(re);
    }
  });

  it("distinct calls at a fixed Date.now() mock still sort ascending", () => {
    const origNow = Date.now;
    try {
      const fixed = 1_700_000_000_000;
      Date.now = () => fixed;
      const ids = Array.from({ length: 100 }, () => newULID());
      for (let i = 0; i < ids.length - 1; i++) {
        expect(ids[i] < ids[i + 1]).toBe(true);
      }
      // All share the same 10-char timestamp prefix (same ms).
      const prefix = ids[0].slice(0, 10);
      for (const id of ids) expect(id.slice(0, 10)).toBe(prefix);
    } finally {
      Date.now = origNow;
    }
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
    // next_actions carry the literal site name — no `${site}` placeholder
    // round-trip (R2 I2 fix).
    const firstCmd = res.envelope.next_actions![0].command;
    expect(firstCmd).toContain("inv-site");
    expect(firstCmd).toContain("hello");
    expect(firstCmd).not.toContain("${site}");
    expect(firstCmd).not.toContain("${cmd}");
  });

  it("paginated command surfaces a --cursor next_action", async () => {
    const inv = buildInvocation("cli", "inv-site", "paged", {
      args: {},
      source: "shell",
    })!;
    const res = await execute(inv);
    expect(res.exitCode).toBe(0);
    const cmds = (res.envelope.next_actions ?? []).map((a) => a.command);
    expect(cmds.some((c) => c.includes("--cursor"))).toBe(true);
  });

  it("non-paginated command omits the --cursor next_action", async () => {
    const inv = buildInvocation("cli", "inv-site", "hello", {
      args: { target: "x" },
      source: "shell",
    })!;
    const res = await execute(inv);
    const cmds = (res.envelope.next_actions ?? []).map((a) => a.command);
    expect(cmds.every((c) => !c.includes("--cursor"))).toBe(true);
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

  it("enforces locked permission profile inside the shared kernel", async () => {
    const permissionAdapter = mkAdapter({
      name: "permission-fixture",
      commands: {
        send: {
          name: "send",
          description: "Send a message",
          adapterArgs: [{ name: "text", type: "str", required: true }],
          func: async () => ({ sent: true }),
        },
      },
    });
    registerAdapter(permissionAdapter);
    compileAll([permissionAdapter]);

    const inv = buildInvocation(
      "cli",
      "permission-fixture",
      "send",
      {
        args: { text: "hello" },
        source: "shell",
      },
      { permissionProfile: "locked" },
    )!;
    const res = await execute(inv);
    expect(res.exitCode).toBe(77);
    expect(res.error).toMatchObject({
      code: "permission_denied",
      adapter_path: "src/adapters/permission-fixture/send.yaml",
    });
  });

  it("rejects invalid permission profile names in the shared kernel", async () => {
    const inv = buildInvocation(
      "cli",
      "inv-site",
      "hello",
      {
        args: { target: "z" },
        source: "shell",
      },
      { permissionProfile: "lokced" },
    )!;
    const res = await execute(inv);
    expect(res.exitCode).toBe(2);
    expect(res.error).toMatchObject({
      code: "invalid_input",
    });
    expect(res.error?.message).toContain("invalid permission profile");
  });

  it("uses target surface for successful desktop command envelopes", async () => {
    const desktopAdapter = mkAdapter({
      name: "desktop-fixture",
      type: AdapterType.DESKTOP,
      commands: {
        mutate: {
          name: "mutate",
          description: "Apply a local document mutation",
          adapterArgs: [],
          func: async () => ({ ok: true }),
        },
      },
    });
    registerAdapter(desktopAdapter);
    compileAll([desktopAdapter]);

    const inv = buildInvocation(
      "cli",
      "desktop-fixture",
      "mutate",
      {
        args: {},
        source: "shell",
      },
      { permissionProfile: "locked", approved: true },
    )!;
    const res = await execute(inv);
    expect(res.exitCode).toBe(0);
    expect(res.envelope.surface).toBe("desktop");
  });
});
