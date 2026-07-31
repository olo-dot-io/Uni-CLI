/**
 * VisualTransport adapter tests.
 *
 * The transport wraps a pluggable backend. Tests exercise the mock path
 * end-to-end and verify the remote placeholder fails closed through the
 * same envelope path without reaching the network.
 */

import { describe, it, expect } from "vitest";
import {
  VisualTransport,
  MockBackend,
  RemoteVisualBackend,
  UnavailableVisualBackend,
  selectVisualBackend,
  type VisualBackend,
  type VisualEnv,
} from "../../../../src/transport/adapters/visual.js";
import { createTransportBus } from "../../../../src/transport/bus.js";
import type { TransportContext } from "../../../../src/transport/types.js";

function makeCtx(): TransportContext {
  return { vars: {}, bus: createTransportBus() };
}

describe("selectVisualBackend", () => {
  it("fails closed when VISUAL_BACKEND is unset", () => {
    const env: VisualEnv = {};
    const backend = selectVisualBackend(env);
    expect(backend.name).toBe("unavailable");
    expect(backend).toBeInstanceOf(UnavailableVisualBackend);
  });

  it("selects MockBackend only when explicitly requested", () => {
    const backend = selectVisualBackend({ VISUAL_BACKEND: "mock" });
    expect(backend.name).toBe("mock");
    expect(backend).toBeInstanceOf(MockBackend);
  });

  it("selects RemoteVisualBackend when a remote endpoint is configured", () => {
    const env: VisualEnv = {
      VISUAL_BACKEND: "remote",
      VISUAL_BACKEND_ENDPOINT: "http://localhost:8800",
      VISUAL_BACKEND_API_KEY: "test-key",
    };
    const backend = selectVisualBackend(env);
    expect(backend.name).toBe("remote");
    expect(backend).toBeInstanceOf(RemoteVisualBackend);
  });

  it("fails closed when VISUAL_BACKEND=remote has no endpoint", () => {
    const env: VisualEnv = { VISUAL_BACKEND: "remote" };
    const backend = selectVisualBackend(env);
    expect(backend.name).toBe("unavailable");
    expect(backend).toBeInstanceOf(UnavailableVisualBackend);
  });

  it("fails closed for unknown VISUAL_BACKEND values", () => {
    const env: VisualEnv = { VISUAL_BACKEND: "no-such-backend" };
    const backend = selectVisualBackend(env);
    expect(backend.name).toBe("unavailable");
    expect(backend).toBeInstanceOf(UnavailableVisualBackend);
  });
});

describe("VisualTransport", () => {
  it("declares kind = visual", () => {
    const t = new VisualTransport({ backend: new MockBackend() });
    expect(t.kind).toBe("visual");
  });

  it("capability.steps covers all 11 visual_* verbs", () => {
    const t = new VisualTransport({ backend: new MockBackend() });
    const expected = [
      "visual_snapshot",
      "visual_click",
      "visual_type",
      "visual_key",
      "visual_scroll",
      "visual_drag",
      "visual_wait",
      "visual_assert",
      "visual_ask",
      "visual_backend",
      "visual_launch",
    ];
    for (const s of expected) expect(t.capability.steps).toContain(s);
    expect(t.capability.mutatesHost).toBe(true);
  });

  it("visual_snapshot returns base64 bytes from the mock backend", async () => {
    const backend = new MockBackend();
    const t = new VisualTransport({ backend });
    await t.open(makeCtx());
    const res = await t.action<{
      backend: string;
      width: number;
      height: number;
      base64: string;
    }>({ kind: "visual_snapshot", params: {} });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.backend).toBe("mock");
      expect(res.data.width).toBe(1);
      expect(res.data.height).toBe(1);
      expect(res.data.base64.length).toBeGreaterThan(10);
    }
    expect(backend.history.at(-1)?.verb).toBe("snapshot");
  });

  it("visual_click records coordinates on the backend", async () => {
    const backend = new MockBackend();
    const t = new VisualTransport({ backend });
    await t.open(makeCtx());
    const res = await t.action({
      kind: "visual_click",
      params: { x: 100, y: 200, button: "right" },
      canMutate: false,
    });
    expect(res.ok).toBe(true);
    expect(res.effect_verdict?.evidence).not.toBe("declared_read");
    const last = backend.history.at(-1);
    expect(last?.verb).toBe("click");
    expect(last?.args).toEqual([100, 200, "right"]);
  });

  it("visual_type records the typed string", async () => {
    const backend = new MockBackend();
    const t = new VisualTransport({ backend });
    await t.open(makeCtx());
    const res = await t.action({
      kind: "visual_type",
      params: { text: "hello world" },
    });
    expect(res.ok).toBe(true);
    expect(backend.history.at(-1)?.args?.[0]).toBe("hello world");
  });

  it("visual_key accepts compute-style combo params", async () => {
    const backend = new MockBackend();
    const t = new VisualTransport({ backend });
    await t.open(makeCtx());
    const res = await t.action({
      kind: "visual_key",
      params: { combo: "cmd+a" },
    });
    expect(res.ok).toBe(true);
    expect(backend.history.at(-1)?.args?.[0]).toBe("cmd+a");
  });

  it("visual_click with missing coords returns usage_error envelope", async () => {
    const t = new VisualTransport({ backend: new MockBackend() });
    await t.open(makeCtx());
    const res = await t.action({ kind: "visual_click", params: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.transport).toBe("visual");
      expect(res.error.exit_code).toBe(2);
    }
  });

  it("unknown action returns an err envelope, never throws", async () => {
    const t = new VisualTransport({ backend: new MockBackend() });
    await t.open(makeCtx());
    const res = await t.action({
      kind: "not_a_visual_step",
      params: {},
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.minimum_capability).toBe("visual.not_a_visual_step");
    }
  });

  it("visual_assert passes when mock backend answers yes", async () => {
    const t = new VisualTransport({ backend: new MockBackend() });
    await t.open(makeCtx());
    const res = await t.action({
      kind: "visual_assert",
      params: { predicate: "screen shows export dialog" },
    });
    expect(res.ok).toBe(true);
  });

  it("visual_ask returns answer from the backend", async () => {
    const t = new VisualTransport({ backend: new MockBackend() });
    await t.open(makeCtx());
    const res = await t.action<{ answer: string }>({
      kind: "visual_ask",
      params: { question: "Is the modal open?" },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.answer).toBe("yes");
    }
  });

  it("visual_backend reports the active backend", async () => {
    const t = new VisualTransport({ backend: new MockBackend() });
    await t.open(makeCtx());
    const res = await t.action<{ backend: string }>({
      kind: "visual_backend",
      params: {},
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.backend).toBe("mock");
  });

  it("envelopes BackendNotReadyError when a real backend is selected", async () => {
    const remote = new RemoteVisualBackend("http://localhost:8800", "test");
    const t = new VisualTransport({ backend: remote });
    await t.open(makeCtx());
    const res = await t.action({
      kind: "visual_snapshot",
      params: {},
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.exit_code).toBe(78); // CONFIG_ERROR
      expect(res.error.minimum_capability).toBe("visual.snapshot");
    }
  });

  it("fails default actions and snapshots instead of fabricating mock success", async () => {
    const transport = new VisualTransport({ env: {} });

    const action = await transport.action({
      kind: "visual_click",
      params: { x: 10, y: 20 },
    });
    expect(action).toMatchObject({
      ok: false,
      error: {
        exit_code: 78,
        reason: expect.stringContaining("mock must be selected explicitly"),
      },
    });
    await expect(transport.snapshot()).rejects.toThrow(
      /mock must be selected explicitly/,
    );
  });

  it("invalidates a cached screenshot after mutation and backend replacement", async () => {
    const first = new MockBackend();
    const second = new MockBackend();
    const transport = new VisualTransport({ backend: first });

    await transport.snapshot();
    await transport.snapshot();
    expect(
      first.history.filter(({ verb }) => verb === "snapshot"),
    ).toHaveLength(1);

    const click = await transport.action({
      kind: "visual_click",
      params: { x: 10, y: 20 },
    });
    expect(click.ok).toBe(true);
    await transport.snapshot();
    expect(
      first.history.filter(({ verb }) => verb === "snapshot"),
    ).toHaveLength(2);

    transport.setBackend(second);
    await transport.snapshot();
    expect(
      second.history.filter(({ verb }) => verb === "snapshot"),
    ).toHaveLength(1);
  });

  it("invalidates a cached screenshot before a dispatched mutation loses its acknowledgement", async () => {
    let captures = 0;
    const backend: VisualBackend = {
      name: "mock",
      cancellation: "request-contained-v1",
      async snapshot() {
        captures++;
        return { base64: "", width: captures, height: 1 };
      },
      async click() {
        throw new Error("click completed but acknowledgement was lost");
      },
      async type() {},
      async key() {},
      async scroll() {},
      async drag() {},
      async wait() {},
    };
    const transport = new VisualTransport({ backend });

    expect((await transport.snapshot()).width).toBe(1);
    const mutation = await transport.action({
      kind: "visual_click",
      params: { x: 10, y: 20 },
    });
    expect(mutation.ok).toBe(false);
    expect((await transport.snapshot()).width).toBe(2);
  });

  it("fails visual_assert when the backend cannot evaluate predicates", async () => {
    const backend: VisualBackend = {
      name: "mock",
      cancellation: "request-contained-v1",
      async snapshot() {
        return { base64: "", width: 0, height: 0 };
      },
      async click() {},
      async type() {},
      async key() {},
      async scroll() {},
      async drag() {},
      async wait() {},
    };
    const transport = new VisualTransport({ backend });

    const result = await transport.action({
      kind: "visual_assert",
      params: { predicate: "the dialog is open" },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        exit_code: 69,
        minimum_capability: "visual.assert",
      },
    });
  });

  it("fails closed before invoking a legacy backend without cancellation containment", async () => {
    let invoked = false;
    const legacyBackend = {
      name: "mock" as const,
      async snapshot() {
        return { base64: "", width: 0, height: 0 };
      },
      async click() {
        invoked = true;
      },
      async type() {},
      async key() {},
      async scroll() {},
      async drag() {},
      async wait() {},
    } as unknown as VisualBackend;
    const transport = new VisualTransport({ backend: legacyBackend });
    await transport.open(makeCtx());

    const result = await transport.action({
      kind: "visual_click",
      params: { x: 10, y: 20 },
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        exit_code: 78,
        reason: expect.stringContaining("request-contained-v1"),
      },
    });
    expect(invoked).toBe(false);
  });

  it("propagates active wait cancellation through the backend contract", async () => {
    const transport = new VisualTransport({
      backend: new RemoteVisualBackend("http://localhost:8800"),
    });
    await transport.open(makeCtx());
    const controller = new AbortController();
    const cancellation = new Error("cancel visual wait");
    const action = transport.action({
      kind: "visual_wait",
      params: { ms: 10_000 },
      signal: controller.signal,
    });
    controller.abort(cancellation);

    await expect(action).rejects.toBe(cancellation);
  });

  it("visual_launch uses the backend launch when available", async () => {
    const backend = new MockBackend();
    const t = new VisualTransport({ backend });
    await t.open(makeCtx());
    const res = await t.action({
      kind: "visual_launch",
      params: { app: "Figma" },
    });
    expect(res.ok).toBe(true);
    expect(backend.history.at(-1)?.verb).toBe("launch");
  });

  it("visual_launch on a backend without launch() returns service_unavailable", async () => {
    const minimal: VisualBackend = {
      name: "mock",
      cancellation: "request-contained-v1",
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
    const t = new VisualTransport({ backend: minimal });
    await t.open(makeCtx());
    const res = await t.action({
      kind: "visual_launch",
      params: { app: "Figma" },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.exit_code).toBe(69);
    }
  });

  it("close is idempotent", async () => {
    const t = new VisualTransport({ backend: new MockBackend() });
    await t.open(makeCtx());
    await t.close();
    await t.close();
  });
});
