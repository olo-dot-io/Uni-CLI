import { describe, it, expect } from "vitest";
import { DesktopAtspiTransport } from "../../../../src/transport/adapters/desktop-atspi.js";
import { createTransportBus } from "../../../../src/transport/bus.js";
import type {
  SidecarCallOptions,
  SidecarClient,
} from "../../../../src/transport/sidecar.js";
import type { TransportContext } from "../../../../src/transport/types.js";

function makeCtx(): TransportContext {
  return { vars: {}, bus: createTransportBus() };
}

class FakeSidecar implements SidecarClient {
  readonly cancellation = "process-contained-v2" as const;
  readonly calls: Array<{ kind: string; params: Record<string, unknown> }> = [];
  readonly signals: Array<AbortSignal | undefined> = [];
  readonly deliveries: Array<SidecarCallOptions["cancellationDelivery"]> = [];
  closeCount = 0;

  constructor(
    private readonly responder: (
      kind: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
    ) => Promise<unknown>,
  ) {}

  async call<T = unknown>(
    kind: string,
    params: Record<string, unknown>,
    options?: SidecarCallOptions,
  ): Promise<T> {
    this.calls.push({ kind, params });
    this.signals.push(options?.signal);
    this.deliveries.push(options?.cancellationDelivery);
    return (await this.responder(kind, params, options?.signal)) as T;
  }

  async close(): Promise<void> {
    this.closeCount++;
  }
}

describe("DesktopAtspiTransport", () => {
  it("declares kind = desktop-atspi and linux platform gate", () => {
    const t = new DesktopAtspiTransport();
    expect(t.kind).toBe("desktop-atspi");
    expect(t.capability.platforms).toContain("linux");
    expect(t.capability.steps).toContain("atspi_invoke");
    expect(t.capability.steps).toContain("atspi_assert");
    expect(t.capability.steps).toContain("launch_app");
    expect(t.capability.steps).not.toContain("ax_focus");
    expect(t.capability.steps).not.toContain("focus_window");
    expect(t.capability.steps).not.toContain("clipboard_read");
    expect(t.capability.steps).not.toContain("clipboard_write");
  });

  it("declines actions without spawning a sidecar on non-Linux hosts", async () => {
    const t = new DesktopAtspiTransport({ platform: "darwin" });
    await t.open(makeCtx());
    const res = await t.action({ kind: "atspi_invoke", params: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.transport).toBe("desktop-atspi");
      expect(res.error.exit_code).toBe(69);
      expect(res.error.minimum_capability).toBe("desktop-atspi.atspi_invoke");
      expect(res.error.suggestion).toMatch(/Linux|Visual/i);
    }
  });

  it("forwards AT-SPI actions to the long-lived sidecar on Linux", async () => {
    const sidecar = new FakeSidecar(async () => ({
      invoked: true,
      stable: "desktop-atspi:123:frame[0]/push_button[0]",
    }));
    const t = new DesktopAtspiTransport({ platform: "linux", sidecar });
    await t.open(makeCtx());

    const res = await t.action({
      kind: "atspi_invoke",
      params: { ref: "@e1" },
      canMutate: false,
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({
        invoked: true,
        stable: "desktop-atspi:123:frame[0]/push_button[0]",
      });
    }
    expect(sidecar.calls).toEqual([
      { kind: "atspi_invoke", params: { ref: "@e1" } },
    ]);
    expect(sidecar.deliveries).toEqual(["outcome-ambiguous"]);
  });

  it("forwards AT-SPI assert actions to the sidecar on Linux", async () => {
    const sidecar = new FakeSidecar(async () => ({
      asserted: true,
      via: "top_level_window_inventory",
    }));
    const t = new DesktopAtspiTransport({ platform: "linux", sidecar });
    await t.open(makeCtx());

    const res = await t.action({
      kind: "atspi_assert",
      params: { text: "Settings" },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({
        asserted: true,
        via: "top_level_window_inventory",
      });
    }
    expect(sidecar.calls).toEqual([
      { kind: "atspi_assert", params: { text: "Settings" } },
    ]);
  });

  it("maps sidecar failures into transport envelopes", async () => {
    const sidecar = new FakeSidecar(async () => {
      throw {
        transport: "desktop-atspi",
        action: "atspi_invoke",
        reason: "no element matched @e1",
        suggestion: "re-snapshot",
        minimum_capability: "desktop-atspi.atspi_invoke",
        exit_code: 66,
      };
    });
    const t = new DesktopAtspiTransport({ platform: "linux", sidecar });
    await t.open(makeCtx());

    const res = await t.action({
      kind: "atspi_invoke",
      params: { ref: "@e1" },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatchObject({
        transport: "desktop-atspi",
        action: "atspi_invoke",
        reason: "no element matched @e1",
        suggestion: "re-snapshot",
        minimum_capability: "desktop-atspi.atspi_invoke",
        exit_code: 66,
      });
    }
  });

  it("normalizes AT-SPI sidecar failures to remedy taxonomy keys", async () => {
    const cases = [
      {
        reason: "no element matched @e1",
        minimumCapability: "desktop-atspi.no_element",
      },
      {
        reason: "AT-SPI D-Bus is not reachable",
        minimumCapability: "desktop-atspi.dbus_blocked",
      },
      {
        reason: "target exposes no accessibility attributes",
        minimumCapability: "desktop-atspi.no_a11y_attr",
      },
      {
        reason: "Wayland input helper missing",
        minimumCapability: "desktop-atspi.wayland-input",
      },
      {
        reason: "X11 input fallback requires xdotool",
        minimumCapability: "desktop-atspi.x11-input",
      },
    ];

    for (const item of cases) {
      const sidecar = new FakeSidecar(async () => {
        throw {
          transport: "desktop-atspi",
          action: "atspi_invoke",
          reason: item.reason,
          suggestion: "inspect the AT-SPI host",
          minimum_capability: "desktop-atspi.atspi_invoke",
          exit_code: 69,
        };
      });
      const t = new DesktopAtspiTransport({ platform: "linux", sidecar });
      await t.open(makeCtx());

      const res = await t.action({
        kind: "atspi_invoke",
        params: { ref: "@e1" },
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.minimum_capability).toBe(item.minimumCapability);
      }
    }
  });

  it("maps sidecar process crashes into retryable crash envelopes", async () => {
    const sidecar = new FakeSidecar(async () => {
      throw new Error("sidecar exited with code 7");
    });
    const t = new DesktopAtspiTransport({ platform: "linux", sidecar });
    await t.open(makeCtx());

    const res = await t.action({
      kind: "atspi_invoke",
      params: { ref: "@e1" },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatchObject({
        transport: "desktop-atspi",
        action: "atspi_invoke",
        minimum_capability: "desktop-atspi.sidecar_crashed",
        retryable: true,
        exit_code: 75,
      });
    }
  });

  it("snapshot delegates to atspi_snapshot and returns a JSON snapshot", async () => {
    const raw = {
      role: "frame",
      name: "Calculator",
      path: "frame[0]",
      scope: "123",
    };
    const sidecar = new FakeSidecar(async () => raw);
    const t = new DesktopAtspiTransport({ platform: "linux", sidecar });
    const ctx = makeCtx();
    await t.open(ctx);

    const snapshot = await t.snapshot({
      format: "json",
      params: { app: "Calculator" },
    });

    expect(snapshot).toEqual({
      format: "json",
      encoding: "json",
      data: JSON.stringify(raw),
      refs: { count: 1, scope: "123" },
    });
    expect(ctx.bus.refs.resolve("@e1")?.stable).toBe(
      "desktop-atspi:123:frame[0]",
    );
    expect(sidecar.calls).toEqual([
      {
        kind: "atspi_snapshot",
        params: { app: "Calculator", format: "json" },
      },
    ]);
  });

  it("propagates one AT-SPI snapshot failure instead of encoding false success", async () => {
    const failure = new Error("AT-SPI snapshot unavailable");
    const sidecar = new FakeSidecar(async () => {
      throw failure;
    });
    const t = new DesktopAtspiTransport({ platform: "linux", sidecar });
    await t.open(makeCtx());

    await expect(t.snapshot({ format: "compact" })).rejects.toBe(failure);
    expect(sidecar.calls).toEqual([
      { kind: "atspi_snapshot", params: { format: "compact" } },
    ]);
  });

  it("encodes compact snapshots from sidecar raw nodes and stores refs", async () => {
    const raw = {
      role: "Window",
      name: "Terminal",
      path: "Window[0]",
      scope: "window-0x03a00007",
      app: "Terminal",
      pid: 1234,
      windowId: "0x03a00007",
      bounds: { x: 10, y: 20, width: 640, height: 480 },
      states: ["visible"],
      children: [
        {
          role: "push_button",
          name: "Run",
          path: "Window[0]/push_button[0]",
          scope: "window-0x03a00007",
        },
      ],
    };
    const sidecar = new FakeSidecar(async () => raw);
    const ctx = makeCtx();
    const t = new DesktopAtspiTransport({ platform: "linux", sidecar });
    await t.open(ctx);

    const snapshot = await t.snapshot({ format: "compact" });

    expect(snapshot).toEqual({
      format: "text",
      encoding: "compact",
      data: '@e1 window "Terminal" 640x480@10,20 {visible} app=Terminal\n@e2 button "Run" app=Terminal',
      refs: { count: 2, scope: "window-0x03a00007" },
    });
    expect(ctx.bus.refs.resolve("@e1")).toMatchObject({
      stable: "desktop-atspi:window-0x03a00007:Window[0]",
      bounds: { x: 10, y: 20, w: 640, h: 480 },
      app: "Terminal",
      pid: 1234,
      windowId: "0x03a00007",
    });
    expect(ctx.bus.refs.resolve("@e2")).toMatchObject({
      stable: "desktop-atspi:window-0x03a00007:Window[0]/push_button[0]",
      app: "Terminal",
      pid: 1234,
      windowId: "0x03a00007",
    });
    expect(sidecar.calls).toEqual([
      { kind: "atspi_snapshot", params: { format: "compact" } },
    ]);
  });

  it("close shuts down the sidecar idempotently", async () => {
    const sidecar = new FakeSidecar(async () => ({}));
    const t = new DesktopAtspiTransport({ platform: "linux", sidecar });
    await t.open(makeCtx());
    await t.close();
    await t.close();
    expect(sidecar.closeCount).toBe(1);
  });
});
