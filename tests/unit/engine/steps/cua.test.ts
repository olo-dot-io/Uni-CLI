/**
 * CUA step handler tests.
 *
 * These handlers are thin — they ask the bus for an adapter, open it,
 * and forward an ActionRequest. Tests register a CuaTransport against
 * a MockBackend so the full path exercises the bus dispatch + envelope
 * contract without any network.
 */

import { describe, it, expect } from "vitest";
import {
  handleCuaSnapshot,
  handleCuaClick,
  handleCuaType,
  handleCuaAssert,
  CUA_STEP_HANDLERS,
} from "../../../../src/engine/steps/cua.js";
import { createTransportBus } from "../../../../src/transport/bus.js";
import {
  CuaTransport,
  MockBackend,
} from "../../../../src/transport/adapters/cua.js";
import type { TransportBus } from "../../../../src/transport/types.js";

function makeBus(backend = new MockBackend()): {
  bus: TransportBus;
  backend: MockBackend;
} {
  const bus = createTransportBus();
  bus.register(new CuaTransport({ backend }));
  return { bus, backend };
}

describe("CUA step handlers", () => {
  it("CUA_STEP_HANDLERS covers all 11 cua_* verbs", () => {
    expect(Object.keys(CUA_STEP_HANDLERS).sort()).toEqual(
      [
        "cua_ask",
        "cua_assert",
        "cua_backend",
        "cua_click",
        "cua_drag",
        "cua_key",
        "cua_launch",
        "cua_scroll",
        "cua_snapshot",
        "cua_type",
        "cua_wait",
      ].sort(),
    );
  });

  it("handleCuaSnapshot routes through the bus to the mock backend", async () => {
    const { bus, backend } = makeBus();
    const envelope = await handleCuaSnapshot(
      { bus, transportCtx: { vars: {}, bus } },
      {},
    );
    expect(envelope.ok).toBe(true);
    expect(backend.history.at(-1)?.verb).toBe("snapshot");
  });

  it("handleCuaClick records click on the backend", async () => {
    const { bus, backend } = makeBus();
    const envelope = await handleCuaClick(
      { bus, transportCtx: { vars: {}, bus } },
      { x: 10, y: 20 },
    );
    expect(envelope.ok).toBe(true);
    expect(backend.history.at(-1)?.verb).toBe("click");
    expect(backend.history.at(-1)?.args.slice(0, 2)).toEqual([10, 20]);
  });

  it("handleCuaType forwards the typed text", async () => {
    const { bus, backend } = makeBus();
    const envelope = await handleCuaType(
      { bus, transportCtx: { vars: {}, bus } },
      { text: "search query" },
    );
    expect(envelope.ok).toBe(true);
    expect(backend.history.at(-1)?.args?.[0]).toBe("search query");
  });

  it("handleCuaAssert with mock backend always passes", async () => {
    const { bus } = makeBus();
    const envelope = await handleCuaAssert(
      { bus, transportCtx: { vars: {}, bus } },
      { predicate: "screen is ready" },
    );
    expect(envelope.ok).toBe(true);
  });

  it("bus returns typed envelope when no cua transport is registered", async () => {
    const bus = createTransportBus();
    // Deliberately do NOT register CuaTransport.
    await expect(
      handleCuaSnapshot(
        { bus, transportCtx: { vars: {}, bus } },
        {},
      ),
    ).rejects.toThrow(/no transport/i);
  });
});
