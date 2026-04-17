import { describe, it, expect } from "vitest";
import {
  makeEnvelope,
  makeError,
  validateEnvelope,
  SCHEMA_VERSION,
  type AgentEnvelope,
  type EnvelopeContext,
} from "../../../src/output/envelope.js";

const baseCtx: EnvelopeContext = {
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

  it("returns data as object and meta.count undefined for record payload", () => {
    const env = makeEnvelope(baseCtx, { foo: "bar" });
    expect(env.data).toEqual({ foo: "bar" });
    expect(env.meta.count).toBeUndefined();
  });

  it("preserves pagination in meta if provided in ctx", () => {
    const ctx: EnvelopeContext = {
      ...baseCtx,
      pagination: { next_cursor: "abc", has_more: true },
    };
    const env = makeEnvelope(ctx, []);
    expect(env.meta.pagination).toEqual({ next_cursor: "abc", has_more: true });
  });

  it("populates all optional meta fields from ctx when provided", () => {
    const ctx: EnvelopeContext = {
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
    };
    expect(() => validateEnvelope(env)).toThrow("ok=false but error is null");
  });

  it("throws when schema_version is not 2", () => {
    const env = {
      ...makeEnvelope(baseCtx, []),
      schema_version: "1" as typeof SCHEMA_VERSION,
    };
    expect(() => validateEnvelope(env)).toThrow('schema_version must be "2"');
  });
});
