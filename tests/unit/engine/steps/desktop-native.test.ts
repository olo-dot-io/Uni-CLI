import { afterEach, describe, it, expect } from "vitest";
import { ok } from "../../../../src/core/envelope.js";
import {
  executeStep,
  getBus,
  _resetTransportBusForTests,
} from "../../../../src/engine/executor.js";
import {
  DESKTOP_AX_STEP_HANDLERS,
  type DesktopAxStepContext,
} from "../../../../src/engine/steps/desktop-ax.js";
import {
  DESKTOP_SIDECAR_STEP_HANDLERS,
  getDesktopSidecarStepHandler,
  type DesktopSidecarStepContext,
} from "../../../../src/engine/steps/desktop-sidecar.js";
import { createTransportBus } from "../../../../src/transport/bus.js";
import type {
  ActionRequest,
  ActionResult,
  Capability,
  Snapshot,
  TransportAdapter,
  TransportContext,
  TransportKind,
} from "../../../../src/transport/types.js";

class FakeTransport implements TransportAdapter {
  readonly capability: Capability;
  readonly calls: ActionRequest[] = [];
  openCount = 0;

  constructor(
    readonly kind: TransportKind,
    steps: readonly string[],
  ) {
    this.capability = {
      steps,
      snapshotFormats: ["os-ax"],
      mutatesHost: true,
    };
  }

  async open(_ctx: TransportContext): Promise<void> {
    this.openCount++;
  }

  async snapshot(): Promise<Snapshot> {
    return { format: "json", data: "{}" };
  }

  async action<T = unknown>(req: ActionRequest): Promise<ActionResult<T>> {
    this.calls.push(req);
    return ok({ kind: req.kind, params: req.params }) as ActionResult<T>;
  }

  async close(): Promise<void> {}
}

describe("desktop native step handlers", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
    _resetTransportBusForTests();
  });

  it("AX handlers cover every direct AX verb advertised by the transport", () => {
    expect(Object.keys(DESKTOP_AX_STEP_HANDLERS).sort()).toEqual(
      [
        "applescript",
        "ax_apps",
        "ax_background_click",
        "ax_focus",
        "ax_focused_read",
        "ax_menu_select",
        "ax_press",
        "ax_screenshot",
        "ax_scroll",
        "ax_set_value",
        "ax_snapshot",
        "ax_windows",
        "clipboard_read",
        "clipboard_write",
        "focus_window",
        "launch_app",
      ].sort(),
    );
  });

  it("sidecar handlers cover every direct UIA and AT-SPI verb", () => {
    expect(Object.keys(DESKTOP_SIDECAR_STEP_HANDLERS).sort()).toEqual(
      [
        "atspi_apps",
        "atspi_assert",
        "atspi_find",
        "atspi_focus",
        "atspi_invoke",
        "atspi_observe",
        "atspi_press",
        "atspi_screenshot",
        "atspi_scroll",
        "atspi_set_value",
        "atspi_snapshot",
        "atspi_wait",
        "atspi_windows",
        "uia_apps",
        "uia_assert",
        "uia_find",
        "uia_focus",
        "uia_invoke",
        "uia_observe",
        "uia_press",
        "uia_screenshot",
        "uia_scroll",
        "uia_set_value",
        "uia_snapshot",
        "uia_wait",
        "uia_windows",
      ].sort(),
    );
  });

  it("routes direct AX inventory through the bus", async () => {
    const bus = createTransportBus();
    const adapter = new FakeTransport("desktop-ax", ["ax_apps"]);
    bus.register(adapter);
    const ctx: DesktopAxStepContext = {
      bus,
      platform: "darwin",
      transportCtx: { vars: {}, bus },
    };

    const envelope = await DESKTOP_AX_STEP_HANDLERS.ax_apps(ctx, {
      includeHidden: true,
    });

    expect(envelope.ok).toBe(true);
    expect(adapter.openCount).toBe(1);
    expect(adapter.calls).toEqual([
      { kind: "ax_apps", params: { includeHidden: true } },
    ]);
  });

  it("routes direct UIA sidecar actions through the bus", async () => {
    expect(getDesktopSidecarStepHandler("uia_snapshot")).toBe(
      DESKTOP_SIDECAR_STEP_HANDLERS.uia_snapshot,
    );

    const bus = createTransportBus();
    const adapter = new FakeTransport("desktop-uia", ["uia_snapshot"]);
    bus.register(adapter);
    const ctx: DesktopSidecarStepContext = {
      bus,
      platform: "win32",
      transportCtx: { vars: {}, bus },
    };

    const envelope = await DESKTOP_SIDECAR_STEP_HANDLERS.uia_snapshot(ctx, {
      app: "Notepad",
    });

    expect(envelope.ok).toBe(true);
    expect(adapter.openCount).toBe(1);
    expect(adapter.calls).toEqual([
      { kind: "uia_snapshot", params: { app: "Notepad" } },
    ]);
  });

  it("routes direct AT-SPI sidecar actions through the bus", async () => {
    expect(getDesktopSidecarStepHandler("atspi_wait")).toBe(
      DESKTOP_SIDECAR_STEP_HANDLERS.atspi_wait,
    );

    const bus = createTransportBus();
    const adapter = new FakeTransport("desktop-atspi", ["atspi_wait"]);
    bus.register(adapter);
    const ctx: DesktopSidecarStepContext = {
      bus,
      platform: "linux",
      transportCtx: { vars: {}, bus },
    };

    const envelope = await DESKTOP_SIDECAR_STEP_HANDLERS.atspi_wait(ctx, {
      title: "Terminal",
    });

    expect(envelope.ok).toBe(true);
    expect(adapter.openCount).toBe(1);
    expect(adapter.calls).toEqual([
      { kind: "atspi_wait", params: { title: "Terminal" } },
    ]);
  });

  it("executor dispatches direct sidecar steps instead of silently skipping them", async () => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });
    _resetTransportBusForTests();
    const adapter = new FakeTransport("desktop-uia", ["uia_snapshot"]);
    getBus().register(adapter);

    const ctx = await executeStep(
      { data: null, args: {}, vars: {} },
      "uia_snapshot",
      { app: "Notepad" },
      0,
    );

    expect(ctx.data).toEqual({
      kind: "uia_snapshot",
      params: { app: "Notepad" },
    });
    expect(adapter.calls).toEqual([
      { kind: "uia_snapshot", params: { app: "Notepad" } },
    ]);
  });
});
