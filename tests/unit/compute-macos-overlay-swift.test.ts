import { describe, expect, it } from "vitest";
import {
  buildMacosOverlayDaemonSwiftScript,
  buildMacosOverlaySwiftScript,
  MacosAppKitOverlayDaemonProvider,
  MacosAppKitOverlayProvider,
} from "../../src/compute/macos-overlay.js";
import { StdioComputeOverlayDaemonSession } from "../../src/compute/overlay-daemon.js";
import { buildComputeActionVisualEvidence } from "../../src/compute/visual-timeline.js";

describe("macOS AppKit compute overlay", () => {
  it("builds a click-through all-spaces full-screen overlay script", () => {
    const source = buildMacosOverlaySwiftScript();

    expect(source).toContain("final class ComputeOverlayWindow: NSWindow");
    expect(source).toContain("override var canBecomeKey: Bool { false }");
    expect(source).toContain("NSScreen.screens");
    expect(source).toContain("window.level = .screenSaver");
    expect(source).toContain("window.ignoresMouseEvents = true");
    expect(source).toContain(".canJoinAllSpaces");
    expect(source).toContain(".fullScreenAuxiliary");
  });

  it("builds a long-lived JSONL daemon overlay script", () => {
    const source = buildMacosOverlayDaemonSwiftScript();

    expect(source).toContain("while let line = readLine()");
    expect(source).toContain('\\"status\\":\\"ready\\"');
    expect(source).toContain("DispatchQueue.main.async");
    expect(source).toContain("render(request:");
    expect(source).toContain("NSScreen.screens");
    expect(source).toContain("window.ignoresMouseEvents = true");
  });

  it("passes the unified visual action request to the Swift sidecar", async () => {
    const evidence = buildComputeActionVisualEvidence({
      tool: "computer-use.click",
      action: "compute_click",
      params: {
        ref: "@e7",
        bounds: { x: 10, y: 20, w: 100, h: 40 },
        pointerStart: { x: 12, y: 18 },
      },
      ok: true,
      transport: "desktop-ax",
    });
    const calls: Array<{
      command: string;
      args: readonly string[];
      input?: string;
    }> = [];
    const provider = new MacosAppKitOverlayProvider({
      platform: "darwin",
      shell: {
        async run(command, args, opts) {
          calls.push({ command, args, input: opts?.input });
          return {
            stdout: JSON.stringify({
              provider: "macos-appkit",
              status: "arrived",
              acknowledged_at_ms: 240,
            }),
            stderr: "",
          };
        },
      },
      scriptPath: "/tmp/unicli-compute-overlay.swift",
    });

    const overlay = await provider.render(evidence.visual_action);

    expect(overlay).toEqual({
      provider: "macos-appkit",
      status: "arrived",
      acknowledged_at_ms: 240,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "swift",
      args: ["/tmp/unicli-compute-overlay.swift"],
    });
    const request = JSON.parse(calls[0]!.input ?? "{}") as {
      samples?: Array<{ x: number; y: number }>;
    };
    expect(request).toMatchObject({
      action_id: evidence.visual_action.action_id,
      visual_style: "mac-glass-pointer-v1",
      state: "press",
      affordance: {
        cursor: "mac-pointer",
        halo: "pressure-bloom",
        click_ripple: true,
      },
      target: { x: 60, y: 40 },
    });
    expect(request.samples).toHaveLength(16);
    expect(request.samples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ x: 12, y: 18 }),
        expect.objectContaining({ x: 60, y: 40 }),
      ]),
    );
  });

  it("reuses one daemon session for multiple overlay renders", async () => {
    const first = buildComputeActionVisualEvidence({
      tool: "computer-use.click",
      action: "compute_click",
      params: { x: 10, y: 20, pointerStart: { x: 1, y: 2 } },
      ok: true,
      transport: "desktop-ax",
    });
    const second = buildComputeActionVisualEvidence({
      tool: "computer-use.click",
      action: "compute_click",
      params: { x: 80, y: 90, pointerStart: { x: 10, y: 20 } },
      ok: true,
      transport: "desktop-ax",
    });
    const requests: Array<{ target: { x: number; y: number } }> = [];
    let starts = 0;
    const provider = new MacosAppKitOverlayDaemonProvider({
      platform: "darwin",
      sessionFactory: async () => {
        starts += 1;
        return {
          async render(request) {
            requests.push(request);
            return {
              provider: "macos-appkit",
              status: "arrived",
              acknowledged_at_ms: request.duration_ms,
            };
          },
          async close() {},
        };
      },
    });

    await provider.render(first.visual_action);
    await provider.render(second.visual_action);

    expect(starts).toBe(1);
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.target)).toEqual([
      expect.objectContaining({ x: 10, y: 20 }),
      expect.objectContaining({ x: 80, y: 90 }),
    ]);
    expect(provider.currentPoint()).toMatchObject({ x: 80, y: 90 });
  });

  it("does not start the render timeout until the daemon reports ready", async () => {
    const script = `
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ provider: "macos-appkit", status: "ready" }) + "\\n");
      }, 80);
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        for (const line of chunk.trim().split(/\\n+/)) {
          if (!line) continue;
          const request = JSON.parse(line);
          process.stdout.write(JSON.stringify({
            provider: "macos-appkit",
            status: "arrived",
            acknowledged_at_ms: request.duration_ms,
          }) + "\\n");
        }
      });
    `;
    const session = new StdioComputeOverlayDaemonSession(
      process.execPath,
      ["-e", script],
      { readyTimeoutMs: 500 },
    );

    try {
      const status = await session.render(
        {
          action_id: "test-action",
          action: "compute_click",
          visual_style: "mac-glass-pointer-v1",
          state: "press",
          affordance: {
            cursor: "mac-pointer",
            halo: "pressure-bloom",
            click_ripple: true,
          },
          target: { at_ms: 120, x: 10, y: 20 },
          duration_ms: 120,
          samples: [
            { at_ms: 0, x: 1, y: 2 },
            { at_ms: 120, x: 10, y: 20 },
          ],
        },
        30,
      );

      expect(status).toEqual({
        provider: "macos-appkit",
        status: "arrived",
        acknowledged_at_ms: 120,
      });
    } finally {
      await session.close();
    }
  });
});
