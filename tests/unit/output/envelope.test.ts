import { describe, it, expect } from "vitest";
import {
  makeEnvelope,
  makeError,
  makeCtx,
  validateEnvelope,
  DEFAULT_SURFACE,
  SCHEMA_VERSION,
  type AgentEnvelope,
  type AgentContext,
} from "../../../src/output/envelope.js";

const baseCtx: AgentContext = {
  command: "twitter.search",
  duration_ms: 42,
};

describe("makeEnvelope", () => {
  it("returns ok=true, count=0, data=[], error=null, schema_version=2 for empty array", () => {
    const env = makeEnvelope(baseCtx, []);
    expect(env.ok).toBe(true);
    expect(env.meta.count).toBe(0);
    expect(env.data).toEqual([]);
    expect(env.error).toBeNull();
    expect(env.schema_version).toBe(SCHEMA_VERSION);
  });

  it("returns count=2 for two-item array", () => {
    const env = makeEnvelope(baseCtx, [{ a: 1 }, { a: 2 }]);
    expect(env.meta.count).toBe(2);
  });

  it("returns count=1 for single-element array", () => {
    const env = makeEnvelope(baseCtx, [{ a: 1 }]);
    expect(env.meta.count).toBe(1);
  });

  it("returns data as object and meta.count undefined for record payload", () => {
    const env = makeEnvelope(baseCtx, { foo: "bar" });
    expect(env.data).toEqual({ foo: "bar" });
    expect(env.meta.count).toBeUndefined();
  });

  it("preserves pagination in meta if provided in ctx", () => {
    const ctx: AgentContext = {
      ...baseCtx,
      pagination: { next_cursor: "abc", has_more: true },
    };
    const env = makeEnvelope(ctx, []);
    expect(env.meta.pagination).toEqual({ next_cursor: "abc", has_more: true });
  });

  it("populates all optional meta fields from ctx when provided", () => {
    const ctx: AgentContext = {
      command: "github.repos",
      duration_ms: 100,
      adapter_version: "1.2.3",
      surface: "web",
      operator: "test-op",
    };
    const env = makeEnvelope(ctx, []);
    expect(env.meta.adapter_version).toBe("1.2.3");
    expect(env.meta.surface).toBe("web");
    expect(env.meta.operator).toBe("test-op");
  });
});

describe("makeError", () => {
  it("returns ok=false, data=null, error with code+message", () => {
    const env = makeError(baseCtx, { code: "x", message: "y" });
    expect(env.ok).toBe(false);
    expect(env.data).toBeNull();
    expect(env.error).toEqual({ code: "x", message: "y" });
  });

  it("makeEnvelope ignores ctx.error (only used by format())", () => {
    const env = makeEnvelope(
      { command: "x.y", duration_ms: 0, error: { code: "e", message: "m" } },
      [],
    );
    expect(env.ok).toBe(true);
    expect(env.error).toBeNull();
  });
});

describe("validateEnvelope", () => {
  it("does not throw for valid success envelope", () => {
    expect(() => validateEnvelope(makeEnvelope(baseCtx, []))).not.toThrow();
  });

  it("throws when ok=true but error is not null", () => {
    const env: AgentEnvelope = {
      ...makeEnvelope(baseCtx, []),
      error: { code: "x", message: "y" },
    };
    expect(() => validateEnvelope(env)).toThrow(
      "ok=true but error is not null",
    );
  });

  it("throws when ok=false but error is null", () => {
    const env: AgentEnvelope = {
      ...makeError(baseCtx, { code: "x", message: "y" }),
      error: null,
    } as unknown as AgentEnvelope;
    expect(() => validateEnvelope(env)).toThrow("ok=false but error is null");
  });

  it("throws when schema_version is not 2", () => {
    const env = {
      ...makeEnvelope(baseCtx, []),
      schema_version: "1" as typeof SCHEMA_VERSION,
    };
    expect(() => validateEnvelope(env)).toThrow('schema_version must be "2"');
  });

  it("throws when ok=false but data is not null", () => {
    const env = {
      ok: false,
      schema_version: "2" as const,
      command: "x.y",
      meta: { duration_ms: 0 },
      data: [1],
      error: { code: "e", message: "m" },
    } as unknown as AgentEnvelope;
    expect(() => validateEnvelope(env)).toThrow(
      "ok=false but data is not null",
    );
  });

  it("throws when ok=true but data is null", () => {
    const env = {
      ok: true,
      schema_version: "2" as const,
      command: "x.y",
      meta: { duration_ms: 0 },
      data: null,
      error: null,
    } as unknown as AgentEnvelope;
    expect(() => validateEnvelope(env)).toThrow("ok=true but data is null");
  });

  it("throws when command is empty string", () => {
    const env = {
      ...makeEnvelope(baseCtx, []),
      command: "",
    } as unknown as AgentEnvelope;
    expect(() => validateEnvelope(env)).toThrow(
      'envelope.command must match "<site>.<command>"',
    );
  });

  it("throws when command has invalid format (no dot)", () => {
    const env = {
      ...makeEnvelope(baseCtx, []),
      command: "twitter",
    };
    expect(() => validateEnvelope(env)).toThrow(
      'envelope.command must match "<site>.<command>"',
    );
  });

  it("does not throw when command has valid format", () => {
    const env = makeEnvelope({ ...baseCtx, command: "twitter.search" }, []);
    expect(() => validateEnvelope(env)).not.toThrow();
  });

  it("throws when meta.duration_ms is not a number", () => {
    const env = {
      ...makeEnvelope(baseCtx, []),
      meta: {
        ...makeEnvelope(baseCtx, []).meta,
        duration_ms: "0" as unknown as number,
      },
    };
    expect(() => validateEnvelope(env)).toThrow("duration_ms must be a number");
  });

  it("throws when content[].type is invalid", () => {
    const env: AgentEnvelope = {
      ...makeEnvelope(baseCtx, []),
      content: [{ type: "video" as "text" }],
    };
    expect(() => validateEnvelope(env)).toThrow(
      'envelope.content[].type must be text|image|resource, got "video"',
    );
  });

  it("throws when meta.count mismatches data.length", () => {
    const env: AgentEnvelope = {
      ...makeEnvelope(baseCtx, [1, 2] as unknown as unknown[]),
      meta: { duration_ms: 42, count: 3 },
    };
    expect(() => validateEnvelope(env)).toThrow(
      "envelope.meta.count (3) disagrees with data.length (2)",
    );
  });
});

describe("DEFAULT_SURFACE", () => {
  it("is the string 'web' for v0.213.x", () => {
    expect(DEFAULT_SURFACE).toBe("web");
  });
});

describe("makeCtx", () => {
  it("populates command + surface=DEFAULT_SURFACE and leaves adapter_version/operator undefined when no opts", () => {
    const startedAt = Date.now() - 5;
    const ctx = makeCtx("core.list", startedAt);
    expect(ctx.command).toBe("core.list");
    expect(ctx.surface).toBe(DEFAULT_SURFACE);
    expect(ctx.surface).toBe("web");
    expect(ctx.adapter_version).toBeUndefined();
    expect(ctx.operator).toBeUndefined();
    expect(typeof ctx.duration_ms).toBe("number");
    expect(ctx.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("computes duration_ms as Date.now() - startedAt", () => {
    const before = Date.now();
    const ctx = makeCtx("core.list", before - 100);
    expect(ctx.duration_ms).toBeGreaterThanOrEqual(100);
    // Allow a generous upper bound for slow CI runners.
    expect(ctx.duration_ms).toBeLessThan(10_000);
  });

  it("lets opts.surface override DEFAULT_SURFACE", () => {
    const ctx = makeCtx("foo.bar", Date.now(), { surface: "desktop" });
    expect(ctx.surface).toBe("desktop");
  });

  it("propagates opts.adapterVersion and opts.operator", () => {
    const ctx = makeCtx("foo.bar", Date.now(), {
      adapterVersion: "3.14.1",
      operator: "cdp",
    });
    expect(ctx.adapter_version).toBe("3.14.1");
    expect(ctx.operator).toBe("cdp");
  });

  it("produces a context makeEnvelope accepts directly", () => {
    const env = makeEnvelope(makeCtx("core.list", Date.now()), []);
    expect(env.ok).toBe(true);
    expect(env.meta.surface).toBe("web");
    expect(env.command).toBe("core.list");
  });
});
