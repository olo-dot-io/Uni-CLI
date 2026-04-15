/**
 * CuaTransport adapter tests.
 *
 * The transport wraps a pluggable backend. All network-using backends
 * (anthropic/trycua/opencua/scrapybara) are stubbed in v0.212 — these
 * tests exercise the MockBackend path end-to-end so the offline suite
 * never reaches the internet.
 */

import { describe, it, expect } from "vitest";
import {
  CuaTransport,
  MockBackend,
  AnthropicBackend,
  TrycuaBackend,
  OpenCuaBackend,
  ScrapybaraBackend,
  selectCuaBackend,
  type CuaBackend,
  type CuaEnv,
} from "../../../../src/transport/adapters/cua.js";
import { createTransportBus } from "../../../../src/transport/bus.js";
import type { TransportContext } from "../../../../src/transport/types.js";

function makeCtx(): TransportContext {
  return { vars: {}, bus: createTransportBus() };
}

describe("selectCuaBackend", () => {
  it("falls back to MockBackend when CUA_BACKEND is unset", () => {
    const env: CuaEnv = {};
    const backend = selectCuaBackend(env);
    expect(backend.name).toBe("mock");
  });

  it("selects AnthropicBackend when ANTHROPIC_API_KEY is set", () => {
    const env: CuaEnv = {
      CUA_BACKEND: "anthropic",
      ANTHROPIC_API_KEY: "sk-ant-test",
    };
    const backend = selectCuaBackend(env);
    expect(backend.name).toBe("anthropic");
    expect(backend).toBeInstanceOf(AnthropicBackend);
  });

  it("selects TrycuaBackend when CUA_BACKEND=trycua + TRYCUA_API_KEY", () => {
    const env: CuaEnv = { CUA_BACKEND: "trycua", TRYCUA_API_KEY: "t-test" };
    const backend = selectCuaBackend(env);
    expect(backend.name).toBe("trycua");
    expect(backend).toBeInstanceOf(TrycuaBackend);
  });

  it("selects OpenCuaBackend when CUA_BACKEND=opencua + OPENCUA_ENDPOINT", () => {
    const env: CuaEnv = {
      CUA_BACKEND: "opencua",
      OPENCUA_ENDPOINT: "http://localhost:8000",
    };
    const backend = selectCuaBackend(env);
    expect(backend.name).toBe("opencua");
    expect(backend).toBeInstanceOf(OpenCuaBackend);
  });

  it("selects ScrapybaraBackend when CUA_BACKEND=scrapybara + SCRAPYBARA_API_KEY", () => {
    const env: CuaEnv = {
      CUA_BACKEND: "scrapybara",
      SCRAPYBARA_API_KEY: "s-test",
    };
    const backend = selectCuaBackend(env);
    expect(backend.name).toBe("scrapybara");
    expect(backend).toBeInstanceOf(ScrapybaraBackend);
  });

  it("falls back to mock when CUA_BACKEND=anthropic but no key", () => {
    const env: CuaEnv = { CUA_BACKEND: "anthropic" };
    const backend = selectCuaBackend(env);
    expect(backend.name).toBe("mock");
  });

  it("treats unknown CUA_BACKEND values as mock fallback", () => {
    const env: CuaEnv = { CUA_BACKEND: "no-such-backend" };
    const backend = selectCuaBackend(env);
    expect(backend.name).toBe("mock");
  });
});

describe("CuaTransport", () => {
  it("declares kind = cua", () => {
    const t = new CuaTransport({ backend: new MockBackend() });
    expect(t.kind).toBe("cua");
  });

  it("capability.steps covers all 11 cua_* verbs", () => {
    const t = new CuaTransport({ backend: new MockBackend() });
    const expected = [
      "cua_snapshot",
      "cua_click",
      "cua_type",
      "cua_key",
      "cua_scroll",
      "cua_drag",
      "cua_wait",
      "cua_assert",
      "cua_ask",
      "cua_backend",
      "cua_launch",
    ];
    for (const s of expected) expect(t.capability.steps).toContain(s);
    expect(t.capability.mutatesHost).toBe(true);
  });

  it("cua_snapshot returns base64 bytes from the mock backend", async () => {
    const backend = new MockBackend();
    const t = new CuaTransport({ backend });
    await t.open(makeCtx());
    const res = await t.action<{
      backend: string;
      width: number;
      height: number;
      base64: string;
    }>({ kind: "cua_snapshot", params: {} });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.backend).toBe("mock");
      expect(res.data.width).toBe(1);
      expect(res.data.height).toBe(1);
      expect(res.data.base64.length).toBeGreaterThan(10);
    }
    expect(backend.history.at(-1)?.verb).toBe("snapshot");
  });

  it("cua_click records coordinates on the backend", async () => {
    const backend = new MockBackend();
    const t = new CuaTransport({ backend });
    await t.open(makeCtx());
    const res = await t.action({
      kind: "cua_click",
      params: { x: 100, y: 200, button: "right" },
    });
    expect(res.ok).toBe(true);
    const last = backend.history.at(-1);
    expect(last?.verb).toBe("click");
    expect(last?.args).toEqual([100, 200, "right"]);
  });

  it("cua_type records the typed string", async () => {
    const backend = new MockBackend();
    const t = new CuaTransport({ backend });
    await t.open(makeCtx());
    const res = await t.action({
      kind: "cua_type",
      params: { text: "hello world" },
    });
    expect(res.ok).toBe(true);
    expect(backend.history.at(-1)?.args?.[0]).toBe("hello world");
  });

  it("cua_click with missing coords returns usage_error envelope", async () => {
    const t = new CuaTransport({ backend: new MockBackend() });
    await t.open(makeCtx());
    const res = await t.action({ kind: "cua_click", params: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.transport).toBe("cua");
      expect(res.error.exit_code).toBe(2);
    }
  });

  it("unknown action returns an err envelope, never throws", async () => {
    const t = new CuaTransport({ backend: new MockBackend() });
    await t.open(makeCtx());
    const res = await t.action({
      kind: "not_a_cua_step",
      params: {},
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.minimum_capability).toBe("cua.not_a_cua_step");
    }
  });

  it("cua_assert passes when mock backend answers yes", async () => {
    const t = new CuaTransport({ backend: new MockBackend() });
    await t.open(makeCtx());
    const res = await t.action({
      kind: "cua_assert",
      params: { predicate: "screen shows export dialog" },
    });
    expect(res.ok).toBe(true);
  });

  it("cua_ask returns answer from the backend", async () => {
    const t = new CuaTransport({ backend: new MockBackend() });
    await t.open(makeCtx());
    const res = await t.action<{ answer: string }>({
      kind: "cua_ask",
      params: { question: "Is the modal open?" },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.answer).toBe("yes");
    }
  });

  it("cua_backend reports the active backend", async () => {
    const t = new CuaTransport({ backend: new MockBackend() });
    await t.open(makeCtx());
    const res = await t.action<{ backend: string }>({
      kind: "cua_backend",
      params: {},
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.backend).toBe("mock");
  });

  it("envelopes BackendNotReadyError when a real backend is selected", async () => {
    const anthropic = new AnthropicBackend("sk-test-fake");
    const t = new CuaTransport({ backend: anthropic });
    await t.open(makeCtx());
    const res = await t.action({
      kind: "cua_snapshot",
      params: {},
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.exit_code).toBe(78); // CONFIG_ERROR
      expect(res.error.minimum_capability).toBe("cua.snapshot");
    }
  });

  it("cua_launch uses the backend launch when available", async () => {
    const backend = new MockBackend();
    const t = new CuaTransport({ backend });
    await t.open(makeCtx());
    const res = await t.action({
      kind: "cua_launch",
      params: { app: "Figma" },
    });
    expect(res.ok).toBe(true);
    expect(backend.history.at(-1)?.verb).toBe("launch");
  });

  it("cua_launch on a backend without launch() returns service_unavailable", async () => {
    const minimal: CuaBackend = {
      name: "mock",
      async snapshot() {
        return { base64: "", width: 0, height: 0 };
      },
      async click() {},
      async type() {},
      async key() {},
      async scroll() {},
      async drag() {},
      async wait() {},
      // no launch
    };
    const t = new CuaTransport({ backend: minimal });
    await t.open(makeCtx());
    const res = await t.action({
      kind: "cua_launch",
      params: { app: "Figma" },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.exit_code).toBe(69);
    }
  });

  it("close is idempotent", async () => {
    const t = new CuaTransport({ backend: new MockBackend() });
    await t.open(makeCtx());
    await t.close();
    await t.close();
  });
});
