import { describe, expect, it } from "vitest";

import {
  buildWindowsOverlayPowerShellScript,
  WindowsWin32OverlayDaemonProvider,
} from "../../src/compute/windows-overlay.js";
import { buildComputeActionVisualEvidence } from "../../src/compute/visual-timeline.js";

describe("Windows Win32 compute overlay", () => {
  it("builds a topmost click-through multi-screen PowerShell HUD daemon", () => {
    const source = buildWindowsOverlayPowerShellScript();

    expect(source).toContain("Add-Type -AssemblyName System.Windows.Forms");
    expect(source).toContain("WS_EX_TRANSPARENT");
    expect(source).toContain("TopMost = $true");
    expect(source).toContain("AllScreens");
    expect(source).toContain('if ([string]$wire.kind -eq "ready")');
    expect(source).toContain("action_id = $script:ResponseActionId");
    expect(source).toContain("Write-Protocol $wire.id $wire.kind");
    expect(source).toContain("while (($line = [Console]::In.ReadLine())");
  });

  it("renders through the shared overlay request and retains virtual pointer state", async () => {
    const evidence = buildComputeActionVisualEvidence({
      tool: "computer-use.click",
      action: "compute_click",
      params: { x: 120, y: 240, pointerStart: { x: 12, y: 24 } },
      ok: true,
      transport: "desktop-uia",
    });
    const requests: Array<{ target: { x: number; y: number } }> = [];
    const provider = new WindowsWin32OverlayDaemonProvider({
      platform: "win32",
      sessionFactory: async () => ({
        async render(request) {
          requests.push(request);
          return {
            provider: "windows-win32",
            status: "arrived",
            acknowledged_at_ms: request.duration_ms,
          };
        },
        async close() {},
      }),
    });

    const status = await provider.render(evidence.visual_action);

    expect(status).toMatchObject({
      provider: "windows-win32",
      status: "arrived",
    });
    expect(requests[0]).toMatchObject({
      action: "compute_click",
      visual_style: "mac-glass-pointer-v1",
      state: "press",
      affordance: {
        cursor: "mac-pointer",
        halo: "pressure-bloom",
        click_ripple: true,
      },
      target: { x: 120, y: 240 },
    });
    expect(provider.currentPoint()).toMatchObject({ x: 120, y: 240 });
  });
});
