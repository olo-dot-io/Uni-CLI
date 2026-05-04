import { describe, it, expect } from "vitest";
import { DesktopUiaTransport } from "../../../../src/transport/adapters/desktop-uia.js";
import { createTransportBus } from "../../../../src/transport/bus.js";
import type { SidecarClient } from "../../../../src/transport/sidecar.js";
import type { TransportContext } from "../../../../src/transport/types.js";

function makeCtx(): TransportContext {
  return { vars: {}, bus: createTransportBus() };
}

class FakeSidecar implements SidecarClient {
  readonly calls: Array<{ kind: string; params: Record<string, unknown> }> = [];
  closeCount = 0;

  constructor(
    private readonly responder: (
      kind: string,
      params: Record<string, unknown>,
    ) => Promise<unknown>,
  ) {}

  async call<T = unknown>(
    kind: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    this.calls.push({ kind, params });
    return (await this.responder(kind, params)) as T;
  }

  async close(): Promise<void> {
    this.closeCount++;
  }
}

describe("DesktopUiaTransport", () => {
  it("declares kind = desktop-uia and win32 platform gate", () => {
    const t = new DesktopUiaTransport();
    expect(t.kind).toBe("desktop-uia");
    expect(t.capability.platforms).toContain("win32");
    expect(t.capability.steps).toContain("uia_invoke");
    expect(t.capability.steps).toContain("uia_assert");
    expect(t.capability.steps).toContain("launch_app");
    expect(t.capability.steps).not.toContain("ax_focus");
    expect(t.capability.steps).not.toContain("focus_window");
    expect(t.capability.steps).not.toContain("clipboard_read");
    expect(t.capability.steps).not.toContain("clipboard_write");
  });

  it("declines actions without spawning a sidecar on non-Windows hosts", async () => {
    const t = new DesktopUiaTransport({ platform: "darwin" });
    await t.open(makeCtx());
    const res = await t.action({ kind: "uia_invoke", params: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.transport).toBe("desktop-uia");
      expect(res.error.exit_code).toBe(69);
      expect(res.error.minimum_capability).toBe("desktop-uia.uia_invoke");
      expect(res.error.suggestion).toMatch(/Windows|CUA/i);
    }
  });

  it("forwards UIA actions to the long-lived sidecar on Windows", async () => {
    const sidecar = new FakeSidecar(async () => ({
      invoked: true,
      stable: "desktop-uia:123:Window[0]/Button[0]",
    }));
    const t = new DesktopUiaTransport({ platform: "win32", sidecar });
    await t.open(makeCtx());

    const res = await t.action({
      kind: "uia_invoke",
      params: { ref: "@e1" },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({
        invoked: true,
        stable: "desktop-uia:123:Window[0]/Button[0]",
      });
    }
    expect(sidecar.calls).toEqual([
      { kind: "uia_invoke", params: { ref: "@e1" } },
    ]);
  });

  it("forwards UIA assert actions to the sidecar on Windows", async () => {
    const sidecar = new FakeSidecar(async () => ({
      asserted: true,
      via: "top_level_window_inventory",
    }));
    const t = new DesktopUiaTransport({ platform: "win32", sidecar });
    await t.open(makeCtx());

    const res = await t.action({
      kind: "uia_assert",
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
      { kind: "uia_assert", params: { text: "Settings" } },
    ]);
  });

  it("maps sidecar failures into transport envelopes", async () => {
    const sidecar = new FakeSidecar(async () => {
      throw {
        transport: "desktop-uia",
        action: "uia_invoke",
        reason: "no element matched @e1",
        suggestion: "re-snapshot",
        minimum_capability: "desktop-uia.uia_invoke",
        exit_code: 66,
      };
    });
    const t = new DesktopUiaTransport({ platform: "win32", sidecar });
    await t.open(makeCtx());

    const res = await t.action({ kind: "uia_invoke", params: { ref: "@e1" } });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatchObject({
        transport: "desktop-uia",
        action: "uia_invoke",
        reason: "no element matched @e1",
        suggestion: "re-snapshot",
        minimum_capability: "desktop-uia.uia_invoke",
        exit_code: 66,
      });
    }
  });

  it("normalizes UIA sidecar failures to remedy taxonomy keys", async () => {
    const cases = [
      {
        reason: "no element matched @e1",
        minimumCapability: "desktop-uia.no_element",
      },
      {
        reason: "target does not expose the Invoke pattern",
        minimumCapability: "desktop-uia.not_invokable",
      },
      {
        reason: "operation timed out after 5000ms",
        minimumCapability: "desktop-uia.timeout",
      },
      {
        reason: "access denied by UI Automation",
        minimumCapability: "desktop-uia.permission",
      },
    ];

    for (const item of cases) {
      const sidecar = new FakeSidecar(async () => {
        throw {
          transport: "desktop-uia",
          action: "uia_invoke",
          reason: item.reason,
          suggestion: "inspect the UIA host",
          minimum_capability: "desktop-uia.uia_invoke",
          exit_code: 69,
        };
      });
      const t = new DesktopUiaTransport({ platform: "win32", sidecar });
      await t.open(makeCtx());

      const res = await t.action({
        kind: "uia_invoke",
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
    const t = new DesktopUiaTransport({ platform: "win32", sidecar });
    await t.open(makeCtx());

    const res = await t.action({ kind: "uia_invoke", params: { ref: "@e1" } });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatchObject({
        transport: "desktop-uia",
        action: "uia_invoke",
        minimum_capability: "desktop-uia.sidecar_crashed",
        retryable: true,
        exit_code: 75,
      });
    }
  });

  it("snapshot delegates to uia_snapshot and returns a JSON snapshot", async () => {
    const raw = {
      role: "Window",
      name: "Notepad",
      path: "Window[0]",
      scope: "123",
    };
    const sidecar = new FakeSidecar(async () => raw);
    const t = new DesktopUiaTransport({ platform: "win32", sidecar });
    await t.open(makeCtx());

    const snapshot = await t.snapshot({ format: "json" });

    expect(snapshot).toEqual({
      format: "json",
      encoding: "json",
      data: JSON.stringify(raw),
    });
    expect(sidecar.calls).toEqual([
      { kind: "uia_snapshot", params: { format: "json" } },
    ]);
  });

  it("encodes compact snapshots from sidecar raw nodes and stores refs", async () => {
    const raw = {
      role: "Window",
      name: "Notepad",
      path: "Window[0]",
      scope: "pid-42",
      bounds: { x: 100, y: 120, width: 800, height: 600 },
      states: ["visible"],
    };
    const sidecar = new FakeSidecar(async () => raw);
    const ctx = makeCtx();
    const t = new DesktopUiaTransport({ platform: "win32", sidecar });
    await t.open(ctx);

    const snapshot = await t.snapshot({ format: "compact" });

    expect(snapshot).toEqual({
      format: "text",
      encoding: "compact",
      data: '@e1 window "Notepad" 800x600@100,120 {visible}',
      refs: { count: 1, scope: "pid-42" },
    });
    expect(ctx.bus.refs.resolve("@e1")).toMatchObject({
      stable: "desktop-uia:pid-42:Window[0]",
      bounds: { x: 100, y: 120, w: 800, h: 600 },
    });
    expect(sidecar.calls).toEqual([
      { kind: "uia_snapshot", params: { format: "compact" } },
    ]);
  });

  it("close shuts down the sidecar idempotently", async () => {
    const sidecar = new FakeSidecar(async () => ({}));
    const t = new DesktopUiaTransport({ platform: "win32", sidecar });
    await t.open(makeCtx());
    await t.close();
    await t.close();
    expect(sidecar.closeCount).toBe(1);
  });
});
