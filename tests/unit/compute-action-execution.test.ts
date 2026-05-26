import { describe, expect, it } from "vitest";

import { executeComputeAction } from "../../src/compute/action-execution.js";
import { ok } from "../../src/core/envelope.js";
import { createTransportBus, RefAllocator } from "../../src/transport/bus.js";
import type { ComputeOverlayProvider } from "../../src/compute/overlay.js";
import type { ComputeVisualCursorPoint } from "../../src/compute/visual-timeline.js";
import type {
  ActionRequest,
  ActionResult,
  Capability,
  Snapshot,
  TransportAdapter,
  TransportContext,
  TransportKind,
} from "../../src/transport/types.js";

class StubTransport implements TransportAdapter {
  readonly capability: Capability;
  readonly calls: ActionRequest[] = [];
  nextResults: ActionResult<unknown>[] = [];

  constructor(
    readonly kind: TransportKind,
    steps: readonly string[],
    private readonly result: ActionResult<unknown>,
  ) {
    this.capability = {
      steps,
      snapshotFormats: [],
      mutatesHost: true,
    };
  }

  async open(_ctx: TransportContext): Promise<void> {}

  async snapshot(): Promise<Snapshot> {
    return { format: "text", data: "" };
  }

  async action<T = unknown>(req: ActionRequest): Promise<ActionResult<T>> {
    this.calls.push(req);
    const next = this.nextResults.shift();
    if (next) return next as ActionResult<T>;
    return this.result as ActionResult<T>;
  }

  async close(): Promise<void> {}
}

describe("compute action execution", () => {
  it("uses one enriched target for overlay, dispatch, and returned evidence", async () => {
    const bus = createTransportBus();
    const alloc = new RefAllocator();
    alloc.alloc({
      stable: "desktop-ax:calc:AXWindow[0]/AXButton[4]",
      role: "AXButton",
      name: "5",
      app: "Calculator",
      bounds: { x: 10, y: 20, w: 30, h: 40 },
      screenIndex: 2,
    });
    bus.refs.put(alloc.freeze("desktop-ax", "calc"));
    const ax = new StubTransport(
      "desktop-ax",
      ["ax_press"],
      ok({ transport: "desktop-ax" }),
    );
    bus.register(ax);
    const overlayCalls: string[] = [];
    const overlayProvider: ComputeOverlayProvider = {
      provider: "macos-appkit",
      async render(action) {
        overlayCalls.push(JSON.stringify(action.target?.point));
        return {
          provider: "macos-appkit",
          status: "arrived",
          acknowledged_at_ms: 240,
        };
      },
    };

    const execution = await executeComputeAction(
      bus,
      { kind: "compute_click", params: { ref: "@e1" } },
      {
        tool: "computer-use.click",
        platform: "darwin",
        overlayProvider,
      },
    );

    expect(execution.result.ok).toBe(true);
    expect(ax.calls[0]).toMatchObject({
      kind: "ax_press",
      params: {
        ref: "@e1",
        x: 25,
        y: 40,
        coordinateSpace: "screen",
        screenIndex: 2,
      },
    });
    expect(overlayCalls).toEqual([
      JSON.stringify({
        x: 25,
        y: 40,
        coordinate_space: {
          kind: "screen-pixels",
          origin: "top-left",
          screenIndex: 2,
        },
      }),
    ]);
    expect(execution.evidence.visual_action).toMatchObject({
      tool: "computer-use.click",
      action: "compute_click",
      target: {
        ref: "@e1",
        point: { x: 25, y: 40 },
      },
      dispatch: {
        status: "succeeded",
        transport: "desktop-ax",
        target: { x: 25, y: 40 },
      },
      overlay: {
        provider: "macos-appkit",
        status: "arrived",
        acknowledged_at_ms: 240,
      },
    });
  });

  it("starts the next pointer plan from the provider's retained virtual pointer", async () => {
    const bus = createTransportBus();
    const ax = new StubTransport(
      "desktop-ax",
      ["ax_press"],
      ok({ transport: "desktop-ax" }),
    );
    bus.register(ax);
    let currentPoint: ComputeVisualCursorPoint | undefined;
    const overlayProvider: ComputeOverlayProvider = {
      provider: "macos-appkit",
      currentPoint: () => currentPoint,
      async render(action) {
        currentPoint = action.target?.point;
        return {
          provider: "macos-appkit",
          status: "arrived",
          acknowledged_at_ms: 240,
        };
      },
    };

    await executeComputeAction(
      bus,
      { kind: "compute_click", params: { x: 10, y: 20 } },
      {
        tool: "computer-use.click",
        platform: "darwin",
        overlayProvider,
      },
    );
    const second = await executeComputeAction(
      bus,
      { kind: "compute_click", params: { x: 80, y: 90 } },
      {
        tool: "computer-use.click",
        platform: "darwin",
        overlayProvider,
      },
    );

    expect(second.evidence.visual_action.pointer_plan).toMatchObject({
      from: { x: 10, y: 20 },
      to: { x: 80, y: 90 },
    });
    expect(
      second.evidence.visual_action.pointer_plan?.samples[0],
    ).toMatchObject({
      x: 10,
      y: 20,
    });
    expect(
      second.evidence.visual_action.pointer_plan?.samples.at(-1),
    ).toMatchObject({
      x: 80,
      y: 90,
    });
  });

  it("waits for the virtual pointer to arrive before dispatching the action", async () => {
    const bus = createTransportBus();
    const events: string[] = [];
    const ax = new StubTransport(
      "desktop-ax",
      ["ax_press"],
      ok({ transport: "desktop-ax" }),
    );
    const originalAction = ax.action.bind(ax);
    ax.action = async (req) => {
      events.push("dispatch");
      return originalAction(req);
    };
    bus.register(ax);
    let releaseOverlay: (() => void) | undefined;
    const overlayProvider: ComputeOverlayProvider = {
      provider: "macos-appkit",
      async render() {
        events.push("overlay-start");
        await new Promise<void>((resolve) => {
          releaseOverlay = resolve;
        });
        events.push("overlay-arrived");
        return {
          provider: "macos-appkit",
          status: "arrived",
          acknowledged_at_ms: 240,
        };
      },
    };

    const executionPromise = executeComputeAction(
      bus,
      { kind: "compute_click", params: { x: 80, y: 90 } },
      {
        tool: "computer-use.click",
        platform: "darwin",
        overlayProvider,
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["overlay-start"]);

    releaseOverlay?.();
    const execution = await executionPromise;

    expect(execution.result.ok).toBe(true);
    expect(events).toEqual(["overlay-start", "overlay-arrived", "dispatch"]);
  });

  it("can attach post-action screenshot evidence to the visual action record", async () => {
    const bus = createTransportBus();
    const ax = new StubTransport(
      "desktop-ax",
      ["ax_press", "ax_screenshot"],
      ok({ transport: "desktop-ax" }),
    );
    ax.nextResults = [
      ok({ transport: "desktop-ax", clicked: true }),
      ok({
        transport: "desktop-ax",
        path: "/tmp/after.png",
        image: { sha256: "after-sha", width: 800, height: 600 },
      }),
    ];
    bus.register(ax);

    const execution = await executeComputeAction(
      bus,
      { kind: "compute_click", params: { x: 80, y: 90 } },
      {
        tool: "computer-use.click",
        platform: "darwin",
        postActionCapture: true,
      },
    );

    expect(ax.calls.map((call) => call.kind)).toEqual([
      "ax_press",
      "ax_screenshot",
    ]);
    expect(execution.evidence.visual_action.post_capture).toMatchObject({
      ok: true,
      transport: "desktop-ax",
      data: {
        path: "/tmp/after.png",
        image: { sha256: "after-sha", width: 800, height: 600 },
      },
    });
  });
});
