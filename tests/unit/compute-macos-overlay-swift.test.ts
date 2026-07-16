import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(source).toContain("struct WireRequest: Decodable");
    expect(source).toContain('wire.kind == "ready"');
    expect(source).toContain("writeStatus(id:");
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
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        for (const line of chunk.trim().split(/\\n+/)) {
          if (!line) continue;
          const wire = JSON.parse(line);
          if (wire.kind === "ready") {
            setTimeout(() => process.stdout.write(JSON.stringify({
              id: wire.id,
              kind: wire.kind,
              ok: true,
              data: { provider: "macos-appkit", status: "ready" },
            }) + "\\n"), 80);
            continue;
          }
          const request = wire.params.request;
          process.stdout.write(JSON.stringify({
            id: wire.id,
            kind: wire.kind,
            ok: true,
            data: {
              provider: "macos-appkit",
              status: "arrived",
              action_id: request.action_id,
              acknowledged_at_ms: request.duration_ms,
            },
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

  it("retires a timed-out overlay generation before rendering the next action", async () => {
    const directory = mkdtempSync(join(tmpdir(), "unicli-overlay-timeout-"));
    const firstGenerationMarker = join(directory, "first-generation.txt");
    const lateAnimationMarker = join(directory, "late-animation.txt");
    const script = `
      const fs = require("node:fs");
      const readline = require("node:readline");
      const first = ${JSON.stringify(firstGenerationMarker)};
      const late = ${JSON.stringify(lateAnimationMarker)};
      readline.createInterface({ input: process.stdin }).on("line", (line) => {
        const wire = JSON.parse(line);
        if (wire.kind === "ready") {
          process.stdout.write(JSON.stringify({
            id: wire.id,
            kind: wire.kind,
            ok: true,
            data: { provider: "macos-appkit", status: "ready" },
          }) + "\\n");
          return;
        }
        const request = wire.params.request;
        if (!fs.existsSync(first)) {
          fs.writeFileSync(first, String(process.pid));
          setTimeout(() => {
            fs.writeFileSync(late, request.action_id);
            process.stdout.write(JSON.stringify({
              id: wire.id,
              kind: wire.kind,
              ok: true,
              data: {
                provider: "macos-appkit",
                status: "arrived",
                action_id: request.action_id,
              },
            }) + "\\n");
          }, 200);
          return;
        }
        process.stdout.write(JSON.stringify({
          id: wire.id,
          kind: wire.kind,
          ok: true,
          data: {
            provider: "macos-appkit",
            status: "arrived",
            action_id: request.action_id,
          },
        }) + "\\n");
      });
    `;
    const session = new StdioComputeOverlayDaemonSession(process.execPath, [
      "-e",
      script,
    ]);

    try {
      await expect(session.render(overlayRequest("first"), 30)).rejects.toThrow(
        "response timed out",
      );
      await expect(
        session.render(overlayRequest("second"), 500),
      ).resolves.toEqual({
        provider: "macos-appkit",
        status: "arrived",
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(existsSync(lateAnimationMarker)).toBe(false);
    } finally {
      await session.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("contains overlay descendants before close resolves", async () => {
    const directory = mkdtempSync(join(tmpdir(), "unicli-overlay-close-"));
    const lateAnimationMarker = join(directory, "late-animation.txt");
    const script = `
      const { spawn } = require("node:child_process");
      const readline = require("node:readline");
      readline.createInterface({ input: process.stdin }).on("line", (line) => {
        const wire = JSON.parse(line);
        if (wire.kind === "ready") {
          spawn(process.execPath, ["-e", ${JSON.stringify(
            `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(lateAnimationMarker)}, "late"), 200)`,
          )}], { stdio: "inherit" });
          process.stdout.write(JSON.stringify({
            id: wire.id,
            kind: wire.kind,
            ok: true,
            data: { provider: "macos-appkit", status: "ready" },
          }) + "\\n");
          return;
        }
        const request = wire.params.request;
        process.stdout.write(JSON.stringify({
          id: wire.id,
          kind: wire.kind,
          ok: true,
          data: {
            provider: "macos-appkit",
            status: "arrived",
            action_id: request.action_id,
          },
        }) + "\\n");
      });
    `;
    const session = new StdioComputeOverlayDaemonSession(process.execPath, [
      "-e",
      script,
    ]);

    try {
      await session.render(overlayRequest("close"), 500);
      await session.close();
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(existsSync(lateAnimationMarker)).toBe(false);
    } finally {
      await session.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function overlayRequest(actionId: string) {
  return {
    action_id: actionId,
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
  };
}
