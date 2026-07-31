import { describe, expect, it } from "vitest";

import { captureComputeContext } from "../../src/compute/capture.js";
import { ok } from "../../src/core/envelope.js";
import { createTransportBus, RefAllocator } from "../../src/transport/bus.js";
import type {
  ActionRequest,
  ActionResult,
  Capability,
  Snapshot,
  TransportAdapter,
  TransportContext,
  TransportKind,
} from "../../src/transport/types.js";

class NativeCaptureStub implements TransportAdapter {
  readonly capability: Capability = {
    steps: [],
    snapshotFormats: ["os-ax"],
    mutatesHost: false,
  };
  readonly screenshotRequests: ActionRequest[] = [];
  private refs: TransportContext["refs"];

  constructor(
    readonly kind: TransportKind,
    private readonly snapshotWindowId: number,
    private readonly screenshotWindowId: number,
  ) {}

  async open(context: TransportContext): Promise<void> {
    this.refs = context.refs;
  }

  async snapshot(): Promise<Snapshot> {
    const alloc = new RefAllocator();
    alloc.alloc({
      stable: `${this.kind}:window-${String(this.snapshotWindowId)}:root`,
      role: "window",
      app: "Calculator",
      windowId: this.snapshotWindowId,
    });
    this.refs?.put(
      alloc.freeze(this.kind, `window-${String(this.snapshotWindowId)}`),
    );
    return {
      format: "text",
      data: '@e1 window "Calculator"',
      refs: { count: 1, scope: `window-${String(this.snapshotWindowId)}` },
    };
  }

  async action<T = unknown>(request: ActionRequest): Promise<ActionResult<T>> {
    if (request.kind.endsWith("_screenshot")) {
      this.screenshotRequests.push(request);
      return ok({
        mime: "image/png",
        windowId: this.screenshotWindowId,
      } as T);
    }
    return ok({ observed: true } as T);
  }

  async close(): Promise<void> {}
}

function nativeTransportKind(): TransportKind {
  if (process.platform === "darwin") return "desktop-ax";
  if (process.platform === "win32") return "desktop-uia";
  return "desktop-atspi";
}

describe("compute capture exact target", () => {
  it("binds the screenshot and replay trajectory to the window proven by the snapshot", async () => {
    const bus = createTransportBus();
    // REASON: only the host accessibility boundary is substituted; capture, selected-provider dispatch, ref allocation, and provenance stay real.
    const native = new NativeCaptureStub(nativeTransportKind(), 101, 101);
    bus.register(native);

    const result = await captureComputeContext(bus, { app: "Calculator" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(native.screenshotRequests).toHaveLength(1);
    expect(native.screenshotRequests[0]?.params).toMatchObject({
      app: "Calculator",
      windowId: 101,
    });
    expect(result.data).toMatchObject({
      app: "Calculator",
      windowId: 101,
      trajectory: {
        replayable: true,
        steps: [
          { action: "compute_snapshot", params: { windowId: 101 } },
          { action: "compute_screenshot", params: { windowId: 101 } },
        ],
      },
    });
  });

  it("rejects a transport result that contradicts the bound snapshot window", async () => {
    const bus = createTransportBus();
    // REASON: the contradictory host result is the external fault injected into the real capture and selected-provider path.
    const native = new NativeCaptureStub(nativeTransportKind(), 101, 202);
    bus.register(native);

    const result = await captureComputeContext(bus, { app: "Calculator" });

    expect(result).toMatchObject({
      ok: false,
      error: {
        minimum_capability: "compute.capture.target_changed",
        exit_code: 69,
      },
    });
  });
});
