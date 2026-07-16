/**
 * @owner   src/compute/windows-overlay.ts
 * @does    Render compute visual_action evidence through a Windows Win32 full-screen HUD.
 * @needs   PowerShell, .NET Windows Forms, src/compute/overlay-daemon.ts
 * @feeds   platform compute overlay selection, doctor compute, computer-use HUD rendering
 * @breaks  A non-click-through or activating HUD window can steal focus from UIA dispatch.
 * @invariants The HUD is visual-only, topmost, click-through, and driven by visual_action pointer samples.
 * @side-effects launches a PowerShell helper process on Windows.
 * @perf    one persistent PowerShell process per provider instance.
 * @concurrency daemon session serializes render requests.
 * @test    tests/unit/compute-windows-overlay.test.ts
 * @stability experimental
 * @since   0.224.0
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computeOverlayRequestFromAction,
  type ComputeOverlayProvider,
  type ComputeOverlayRequest,
} from "./overlay.js";
import {
  StdioComputeOverlayDaemonSession,
  type ComputeOverlayDaemonSession,
} from "./overlay-daemon.js";
import type {
  ComputeVisualAction,
  ComputeVisualCursorPoint,
  ComputeVisualOverlayStatus,
} from "./visual-timeline.js";

export interface WindowsWin32OverlayDaemonProviderOptions {
  platform?: NodeJS.Platform;
  scriptPath?: string;
  sessionFactory?: () => Promise<ComputeOverlayDaemonSession>;
}

export class WindowsWin32OverlayDaemonProvider implements ComputeOverlayProvider {
  readonly provider = "windows-win32";

  private readonly platform: NodeJS.Platform;
  private readonly scriptPath: string | undefined;
  private readonly sessionFactory:
    | (() => Promise<ComputeOverlayDaemonSession>)
    | undefined;
  private session: ComputeOverlayDaemonSession | undefined;
  private tmpRoot: string | undefined;
  private lastPoint: ComputeVisualCursorPoint | undefined;

  constructor(opts: WindowsWin32OverlayDaemonProviderOptions = {}) {
    this.platform = opts.platform ?? process.platform;
    this.scriptPath = opts.scriptPath;
    this.sessionFactory = opts.sessionFactory;
  }

  currentPoint(): ComputeVisualCursorPoint | undefined {
    return this.lastPoint;
  }

  async render(
    action: ComputeVisualAction,
  ): Promise<ComputeVisualOverlayStatus> {
    const request = computeOverlayRequestFromAction(action);
    if (!request) return { provider: this.provider, status: "not_requested" };
    if (this.platform !== "win32") {
      return { provider: this.provider, status: "unavailable" };
    }
    try {
      const session = await this.ensureSession();
      const status = await session.render(
        request,
        Math.max(1_000, request.duration_ms + 1_500),
      );
      if (status.status === "arrived") {
        this.lastPoint = pointFromOverlayTarget(request);
      }
      return status;
    } catch (error) {
      return {
        provider: this.provider,
        status: "failed",
        error: errorMessage(error),
      };
    }
  }

  async close(): Promise<void> {
    await this.session?.close();
    this.session = undefined;
    if (this.tmpRoot) {
      await rm(this.tmpRoot, { recursive: true, force: true });
      this.tmpRoot = undefined;
    }
  }

  private async ensureSession(): Promise<ComputeOverlayDaemonSession> {
    if (this.session) return this.session;
    if (this.sessionFactory) {
      this.session = await this.sessionFactory();
      return this.session;
    }

    const scriptPath =
      this.scriptPath ??
      join(
        (this.tmpRoot = await mkdtemp(join(tmpdir(), "unicli-overlay-win-"))),
        "overlay.ps1",
      );
    if (!this.scriptPath) {
      await writeFile(
        scriptPath,
        buildWindowsOverlayPowerShellScript(),
        "utf8",
      );
    }
    this.session = new StdioComputeOverlayDaemonSession("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
    ]);
    return this.session;
  }
}

export function buildWindowsOverlayPowerShellScript(): string {
  return String.raw`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class UniCliOverlayNative {
  public const int GWL_EXSTYLE = -20;
  public const int WS_EX_TRANSPARENT = 0x00000020;
  public const int WS_EX_LAYERED = 0x00080000;
  public const int WS_EX_NOACTIVATE = 0x08000000;
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
}
"@

$script:CursorVisualStyle = "mac-glass-pointer-v1"
$script:CursorSkin = "mac-pointer"
$script:Request = $null
$script:ResponseId = $null
$script:ResponseKind = $null
$script:ResponseActionId = $null
$script:StartedAt = [DateTime]::UtcNow
$script:Trail = New-Object System.Collections.ArrayList
$script:Timer = New-Object System.Windows.Forms.Timer
$script:Timer.Interval = 16
$script:Forms = New-Object System.Collections.ArrayList

function Write-Protocol($id, $kind, $data) {
  $payload = @{ id = $id; kind = $kind; ok = $true; data = $data }
  [Console]::Out.WriteLine(($payload | ConvertTo-Json -Compress -Depth 8))
  [Console]::Out.Flush()
}

function Convert-Sample($sample) {
  [pscustomobject]@{
    at_ms = [double]$sample.at_ms
    x = [double]$sample.x
    y = [double]$sample.y
  }
}

function Get-SampleAt([double]$elapsedMs) {
  $samples = @($script:Request.samples)
  if ($samples.Count -eq 0) { return (Convert-Sample $script:Request.target) }
  $previous = $samples[0]
  foreach ($sample in $samples[1..($samples.Count - 1)]) {
    if ([double]$sample.at_ms -ge $elapsedMs) {
      $span = [Math]::Max(1, [double]$sample.at_ms - [double]$previous.at_ms)
      $t = [Math]::Min(1, [Math]::Max(0, ($elapsedMs - [double]$previous.at_ms) / $span))
      return [pscustomobject]@{
        at_ms = $elapsedMs
        x = [double]$previous.x + (([double]$sample.x - [double]$previous.x) * $t)
        y = [double]$previous.y + (([double]$sample.y - [double]$previous.y) * $t)
      }
    }
    $previous = $sample
  }
  return (Convert-Sample $script:Request.target)
}

function New-OverlayForm($screen) {
  $form = New-Object System.Windows.Forms.Form
  $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
  $form.ShowInTaskbar = $false
  $form.TopMost = $true
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
  $form.Bounds = $screen.Bounds
  $form.BackColor = [System.Drawing.Color]::Black
  $form.TransparencyKey = [System.Drawing.Color]::Black
  $form.Opacity = 0.96
  $form.Add_Shown({
    $style = [UniCliOverlayNative]::GetWindowLong($this.Handle, [UniCliOverlayNative]::GWL_EXSTYLE)
    [void][UniCliOverlayNative]::SetWindowLong($this.Handle, [UniCliOverlayNative]::GWL_EXSTYLE, $style -bor [UniCliOverlayNative]::WS_EX_TRANSPARENT -bor [UniCliOverlayNative]::WS_EX_LAYERED -bor [UniCliOverlayNative]::WS_EX_NOACTIVATE)
  })
  $form.Add_Paint({
    param($sender, $event)
    if ($null -eq $script:Request) { return }
    $elapsedMs = ([DateTime]::UtcNow - $script:StartedAt).TotalMilliseconds
    $durationMs = [Math]::Max(120, [double]$script:Request.duration_ms)
    $pressProgress = $elapsedMs / $durationMs
    $point = Get-SampleAt $elapsedMs
    $bounds = $sender.Bounds
    $x = [float]($point.x - $bounds.X)
    $y = [float]($point.y - $bounds.Y)
    $g = $event.Graphics
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $outlinePen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(245, 23, 19, 15)), 2.2
    $highlightPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(190, 255, 255, 255)), 1
    $fillBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(250, 246, 240, 227))
    $statePen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(198, 193, 154, 82)), 1.5
    $trailPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(120, 193, 154, 82)), 2
    $trailPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $trailPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    if ($script:Trail.Count -gt 1) {
      for ($i = 1; $i -lt $script:Trail.Count; $i++) {
        $a = $script:Trail[$i - 1]
        $b = $script:Trail[$i]
        $g.DrawLine($trailPen, [float]($a.x - $bounds.X), [float]($a.y - $bounds.Y), [float]($b.x - $bounds.X), [float]($b.y - $bounds.Y))
      }
    }
    $hotspot = [System.Drawing.PointF]::new($x, $y)
    $pointerPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    [void]$pointerPath.AddPolygon([System.Drawing.PointF[]]@(
      [System.Drawing.PointF]::new($x, $y),
      [System.Drawing.PointF]::new($x, $y + 45),
      [System.Drawing.PointF]::new($x + 13, $y + 32),
      [System.Drawing.PointF]::new($x + 21, $y + 55),
      [System.Drawing.PointF]::new($x + 31, $y + 51),
      [System.Drawing.PointF]::new($x + 23, $y + 29),
      [System.Drawing.PointF]::new($x + 43, $y + 29)
    ))
    $g.FillPath($fillBrush, $pointerPath)
    $g.DrawPath($outlinePen, $pointerPath)
    $g.DrawLine($highlightPen, $x + 6, $y + 8, $x + 6, $y + 34)
    $state = [string]$script:Request.state
    $halo = ""
    $clickRipple = $false
    if ($null -ne $script:Request.affordance) {
      $halo = [string]$script:Request.affordance.halo
      $clickRipple = [bool]$script:Request.affordance.click_ripple
    }
    $isPressure = ($state -eq "press" -or $halo -eq "pressure-bloom" -or $clickRipple) -and $pressProgress -ge 0.78
    $isOrbit = $state -eq "wait" -or $halo -eq "busy-orbit"
    if ($isOrbit) {
      $statePen.DashPattern = @(4, 5)
      $g.DrawEllipse($statePen, $hotspot.X - 14, $hotspot.Y - 14, 30, 30)
    } elseif ($isPressure) {
      $g.DrawEllipse($statePen, $hotspot.X - 14, $hotspot.Y - 14, 30, 30)
    }
  })
  return $form
}

function Start-Render($wire) {
  $script:Request = $wire.params.request
  $script:ResponseId = $wire.id
  $script:ResponseKind = $wire.kind
  $script:ResponseActionId = $wire.params.request.action_id
  $script:StartedAt = [DateTime]::UtcNow
  [void]$script:Trail.Clear()
  $script:Timer.Stop()
  $script:Timer.Start()
}

function Handle-Request($wire) {
  if ([string]$wire.kind -eq "ready") {
    Write-Protocol $wire.id $wire.kind @{ provider = "windows-win32"; status = "ready" }
    return
  }
  if ([string]$wire.kind -ne "render" -or $null -eq $wire.params.request) {
    Write-Protocol $wire.id $wire.kind @{ provider = "windows-win32"; status = "failed"; error = "invalid request" }
    return
  }
  Start-Render $wire
}

$script:Timer.Add_Tick({
  if ($null -eq $script:Request) { return }
  $elapsed = ([DateTime]::UtcNow - $script:StartedAt).TotalMilliseconds
  $duration = [Math]::Max(120, [double]$script:Request.duration_ms)
  $point = Get-SampleAt $elapsed
  [void]$script:Trail.Add($point)
  while ($script:Trail.Count -gt 10) { $script:Trail.RemoveAt(0) }
  foreach ($form in $script:Forms) { $form.Invalidate() }
  if ($elapsed -ge $duration) {
    $script:Timer.Stop()
    Write-Protocol $script:ResponseId $script:ResponseKind @{
      provider = "windows-win32"
      status = "arrived"
      action_id = $script:ResponseActionId
      acknowledged_at_ms = [int]$duration
    }
    $script:Request = $null
    $script:ResponseId = $null
    $script:ResponseKind = $null
    $script:ResponseActionId = $null
  }
})

foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
  [void]$script:Forms.Add((New-OverlayForm $screen))
}

foreach ($form in $script:Forms) { $form.Show() }

[System.Threading.ThreadPool]::QueueUserWorkItem({
  while (($line = [Console]::In.ReadLine()) -ne $null) {
    try {
      $wire = $line | ConvertFrom-Json
      [void][System.Windows.Forms.Application]::OpenForms[0].BeginInvoke([Action[object]]{ param($r) Handle-Request $r }, $wire)
    } catch {
      Write-Protocol 0 "<parse>" @{ provider = "windows-win32"; status = "failed"; error = "invalid request" }
    }
  }
  [System.Windows.Forms.Application]::Exit()
}) | Out-Null

[System.Windows.Forms.Application]::Run()
`;
}

function pointFromOverlayTarget(
  request: ComputeOverlayRequest,
): ComputeVisualCursorPoint {
  return {
    x: request.target.x,
    y: request.target.y,
    coordinate_space: {
      kind: "screen-pixels",
      origin: "top-left",
      ...(request.target.screenIndex !== undefined
        ? { screenIndex: request.target.screenIndex }
        : {}),
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
