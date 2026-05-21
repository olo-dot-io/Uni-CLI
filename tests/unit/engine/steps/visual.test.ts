/**
 * Visual step handler tests.
 *
 * These handlers are thin — they ask the bus for an adapter, open it,
 * and forward an ActionRequest. Tests register a VisualTransport against
 * a MockBackend so the full path exercises the bus dispatch + envelope
 * contract without any network.
 */

import { describe, it, expect } from "vitest";
import {
  handleVisualSnapshot,
  handleVisualClick,
  handleVisualType,
  handleVisualAssert,
  VISUAL_STEP_HANDLERS,
} from "../../../../src/engine/steps/visual.js";
import { createTransportBus } from "../../../../src/transport/bus.js";
import {
  VisualTransport,
  MockBackend,
} from "../../../../src/transport/adapters/visual.js";
import type { TransportBus } from "../../../../src/transport/types.js";

function makeBus(backend = new MockBackend()): {
  bus: TransportBus;
  backend: MockBackend;
} {
  const bus = createTransportBus();
  bus.register(new VisualTransport({ backend }));
  return { bus, backend };
}

describe("Visual step handlers", () => {
  it("VISUAL_STEP_HANDLERS covers all 11 visual_* verbs", () => {
    expect(Object.keys(VISUAL_STEP_HANDLERS).sort()).toEqual(
      [
        "visual_ask",
        "visual_assert",
        "visual_backend",
        "visual_click",
        "visual_drag",
        "visual_key",
        "visual_launch",
        "visual_scroll",
        "visual_snapshot",
        "visual_type",
        "visual_wait",
      ].sort(),
    );
  });

  it("handleVisualSnapshot routes through the bus to the mock backend", async () => {
    const { bus, backend } = makeBus();
    const envelope = await handleVisualSnapshot(
      { bus, transportCtx: { vars: {}, bus } },
      {},
    );
    expect(envelope.ok).toBe(true);
    expect(backend.history.at(-1)?.verb).toBe("snapshot");
  });

  it("handleVisualClick records click on the backend", async () => {
    const { bus, backend } = makeBus();
    const envelope = await handleVisualClick(
      { bus, transportCtx: { vars: {}, bus } },
      { x: 10, y: 20 },
    );
    expect(envelope.ok).toBe(true);
    expect(backend.history.at(-1)?.verb).toBe("click");
    expect(backend.history.at(-1)?.args.slice(0, 2)).toEqual([10, 20]);
  });

  it("handleVisualType forwards the typed text", async () => {
    const { bus, backend } = makeBus();
    const envelope = await handleVisualType(
      { bus, transportCtx: { vars: {}, bus } },
      { text: "search query" },
    );
    expect(envelope.ok).toBe(true);
    expect(backend.history.at(-1)?.args?.[0]).toBe("search query");
  });

  it("handleVisualAssert with mock backend always passes", async () => {
    const { bus } = makeBus();
    const envelope = await handleVisualAssert(
      { bus, transportCtx: { vars: {}, bus } },
      { predicate: "screen is ready" },
    );
    expect(envelope.ok).toBe(true);
  });

  it("bus returns typed envelope when no visual transport is registered", async () => {
    const bus = createTransportBus();
    // Deliberately do NOT register VisualTransport.
    await expect(
      handleVisualSnapshot({ bus, transportCtx: { vars: {}, bus } }, {}),
    ).rejects.toThrow(/no transport/i);
  });
});
