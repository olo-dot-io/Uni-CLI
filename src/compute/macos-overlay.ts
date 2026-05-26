/**
 * @owner   src/compute/macos-overlay.ts
 * @does    Render compute visual_action evidence through a macOS AppKit full-screen HUD.
 * @needs   Swift runtime, AppKit, src/compute/overlay.ts
 * @feeds   future computer-use native overlay orchestration
 * @breaks  Non-click-through or key windows can steal focus from the real action transport.
 * @invariants The overlay is visual-only, click-through, non-key, and spans every visible screen.
 * @side-effects launches a Swift/AppKit helper on macOS and may keep a daemon process per provider.
 * @perf    one persistent Swift process per daemon provider; one-shot provider spawns per render.
 * @concurrency daemon provider serializes render requests; native AppKit state is process-local
 * @test    tests/unit/compute-macos-overlay-swift.test.ts
 * @stability experimental
 * @since   0.224.0
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computeOverlayRequestFromAction,
  type ComputeOverlayRequest,
  type ComputeOverlayProvider,
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

export interface MacosOverlayShell {
  run(
    command: string,
    args: readonly string[],
    opts?: { input?: string; timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string }>;
}

export interface MacosAppKitOverlayProviderOptions {
  platform?: NodeJS.Platform;
  shell?: MacosOverlayShell;
  scriptPath?: string;
}

export type MacosOverlayDaemonSession = ComputeOverlayDaemonSession;

export interface MacosAppKitOverlayDaemonProviderOptions {
  platform?: NodeJS.Platform;
  scriptPath?: string;
  sessionFactory?: () => Promise<MacosOverlayDaemonSession>;
}

export class MacosAppKitOverlayProvider implements ComputeOverlayProvider {
  readonly provider = "macos-appkit";

  private readonly platform: NodeJS.Platform;
  private readonly shell: MacosOverlayShell;
  private readonly scriptPath: string | undefined;
  private lastPoint: ComputeVisualCursorPoint | undefined;

  constructor(opts: MacosAppKitOverlayProviderOptions = {}) {
    this.platform = opts.platform ?? process.platform;
    this.shell = opts.shell ?? defaultShell;
    this.scriptPath = opts.scriptPath;
  }

  currentPoint(): ComputeVisualCursorPoint | undefined {
    return this.lastPoint;
  }

  async render(
    action: ComputeVisualAction,
  ): Promise<ComputeVisualOverlayStatus> {
    const request = computeOverlayRequestFromAction(action);
    if (!request) {
      return { provider: "macos-appkit", status: "not_requested" };
    }
    if (this.platform !== "darwin") {
      return { provider: "macos-appkit", status: "unavailable" };
    }

    let tmpRoot: string | undefined;
    const scriptPath =
      this.scriptPath ??
      join(
        (tmpRoot = await mkdtemp(join(tmpdir(), "unicli-overlay-"))),
        "main.swift",
      );

    try {
      if (!this.scriptPath) {
        await writeFile(scriptPath, buildMacosOverlaySwiftScript(), "utf8");
      }
      const result = await this.shell.run("swift", [scriptPath], {
        input: JSON.stringify(request),
        timeoutMs: Math.max(1_000, request.duration_ms + 1_500),
      });
      const status = parseOverlayStatus(result.stdout);
      if (status.status === "arrived") {
        this.lastPoint = pointFromOverlayTarget(request);
      }
      return status;
    } catch (error) {
      return {
        provider: "macos-appkit",
        status: "failed",
        error: errorMessage(error),
      };
    } finally {
      if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
    }
  }
}

export class MacosAppKitOverlayDaemonProvider implements ComputeOverlayProvider {
  readonly provider = "macos-appkit";

  private readonly platform: NodeJS.Platform;
  private readonly scriptPath: string | undefined;
  private readonly sessionFactory:
    | (() => Promise<MacosOverlayDaemonSession>)
    | undefined;
  private session: MacosOverlayDaemonSession | undefined;
  private tmpRoot: string | undefined;
  private lastPoint: ComputeVisualCursorPoint | undefined;

  constructor(opts: MacosAppKitOverlayDaemonProviderOptions = {}) {
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
    if (!request) {
      return { provider: "macos-appkit", status: "not_requested" };
    }
    if (this.platform !== "darwin") {
      return { provider: "macos-appkit", status: "unavailable" };
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
        provider: "macos-appkit",
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

  private async ensureSession(): Promise<MacosOverlayDaemonSession> {
    if (this.session) return this.session;
    if (this.sessionFactory) {
      this.session = await this.sessionFactory();
      return this.session;
    }

    const scriptPath =
      this.scriptPath ??
      join(
        (this.tmpRoot = await mkdtemp(join(tmpdir(), "unicli-overlayd-"))),
        "main.swift",
      );
    if (!this.scriptPath) {
      await writeFile(scriptPath, buildMacosOverlayDaemonSwiftScript(), "utf8");
    }
    this.session = new StdioComputeOverlayDaemonSession("swift", [scriptPath]);
    return this.session;
  }
}

export function buildMacosOverlaySwiftScript(): string {
  return String.raw`
import AppKit
import Foundation
import QuartzCore

let cursorVisualStyle = "mac-glass-pointer-v1"
let cursorSkin = "mac-pointer"

struct OverlaySample: Decodable {
  let at_ms: Double
  let x: Double
  let y: Double
  let screenIndex: Int?
}

struct OverlayAffordance: Decodable {
  let cursor: String?
  let halo: String?
  let trail: Bool?
  let click_ripple: Bool?
}

struct OverlayRequest: Decodable {
  let action_id: String
  let action: String
  let visual_style: String?
  let state: String?
  let affordance: OverlayAffordance?
  let target: OverlaySample
  let duration_ms: Double
  let samples: [OverlaySample]
}

final class ComputeOverlayWindow: NSWindow {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

final class ComputeOverlayView: NSView {
  private let haloLayer = CAShapeLayer()
  private let stateLayer = CAShapeLayer()
  private let coreLayer = CAShapeLayer()
  private let trailLayer = CAShapeLayer()
  private let screenFrame: NSRect

  init(frame: NSRect, screenFrame: NSRect) {
    self.screenFrame = screenFrame
    super.init(frame: frame)
    wantsLayer = true
    layer?.backgroundColor = NSColor.clear.cgColor
    trailLayer.fillColor = NSColor.clear.cgColor
    trailLayer.strokeColor = NSColor(calibratedRed: 0.76, green: 0.60, blue: 0.32, alpha: 0.52).cgColor
    trailLayer.lineWidth = 2
    trailLayer.lineCap = .round
    haloLayer.fillColor = NSColor(calibratedRed: 0.98, green: 0.96, blue: 0.90, alpha: 0.98).cgColor
    haloLayer.strokeColor = NSColor(calibratedRed: 0.09, green: 0.07, blue: 0.05, alpha: 0.96).cgColor
    haloLayer.lineWidth = 2.25
    haloLayer.shadowColor = NSColor(calibratedWhite: 0.0, alpha: 0.45).cgColor
    haloLayer.shadowRadius = 10
    haloLayer.shadowOpacity = 0.72
    haloLayer.shadowOffset = .zero
    stateLayer.fillColor = NSColor.clear.cgColor
    stateLayer.strokeColor = NSColor(calibratedRed: 0.76, green: 0.60, blue: 0.32, alpha: 0.78).cgColor
    stateLayer.lineWidth = 1.5
    stateLayer.opacity = 0
    coreLayer.fillColor = NSColor.clear.cgColor
    coreLayer.strokeColor = NSColor(calibratedWhite: 1.0, alpha: 0.72).cgColor
    coreLayer.lineWidth = 1
    layer?.addSublayer(trailLayer)
    layer?.addSublayer(haloLayer)
    layer?.addSublayer(stateLayer)
    layer?.addSublayer(coreLayer)
  }

  required init?(coder: NSCoder) { nil }

  func update(point: CGPoint, trail: [CGPoint], request: OverlayRequest, elapsedMs: Double, durationMs: Double) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    let local = CGPoint(x: point.x - screenFrame.minX, y: point.y - screenFrame.minY)
    let hotspot = local
    let pointerPath = CGMutablePath()
    pointerPath.move(to: local)
    pointerPath.addLine(to: CGPoint(x: local.x, y: local.y + 45))
    pointerPath.addLine(to: CGPoint(x: local.x + 13, y: local.y + 32))
    pointerPath.addLine(to: CGPoint(x: local.x + 21, y: local.y + 55))
    pointerPath.addLine(to: CGPoint(x: local.x + 31, y: local.y + 51))
    pointerPath.addLine(to: CGPoint(x: local.x + 23, y: local.y + 29))
    pointerPath.addLine(to: CGPoint(x: local.x + 43, y: local.y + 29))
    pointerPath.closeSubpath()
    let highlightPath = CGMutablePath()
    highlightPath.move(to: CGPoint(x: local.x + 6, y: local.y + 8))
    highlightPath.addLine(to: CGPoint(x: local.x + 6, y: local.y + 34))
    let trailPath = CGMutablePath()
    for (index, global) in trail.enumerated() {
      let p = CGPoint(x: global.x - screenFrame.minX, y: global.y - screenFrame.minY)
      if index == 0 { trailPath.move(to: p) } else { trailPath.addLine(to: p) }
    }
    let state = request.state ?? ""
    let halo = request.affordance?.halo ?? ""
    let clickRipple = request.affordance?.click_ripple ?? false
    let pressProgress = durationMs > 0 ? elapsedMs / durationMs : 1
    let isPressure = (state == "press" || halo == "pressure-bloom" || clickRipple) && pressProgress >= 0.78
    let isOrbit = state == "wait" || halo == "busy-orbit"
    let statePath = CGMutablePath()
    statePath.addEllipse(in: CGRect(x: local.x - 14, y: local.y - 14, width: 30, height: 30))
    haloLayer.path = pointerPath
    coreLayer.path = highlightPath
    trailLayer.path = trailPath
    stateLayer.path = statePath
    stateLayer.opacity = isPressure || isOrbit ? 1 : 0
    stateLayer.lineDashPattern = isOrbit ? [4 as NSNumber, 5 as NSNumber] : nil
    CATransaction.commit()
  }
}

let data = FileHandle.standardInput.readDataToEndOfFile()
let request = try JSONDecoder().decode(OverlayRequest.self, from: data)
let displayHeight = NSScreen.screens.map { $0.frame.maxY }.max() ?? 0

func appKitPoint(_ sample: OverlaySample) -> CGPoint {
  CGPoint(x: sample.x, y: displayHeight - sample.y)
}

func sampleAt(elapsedMs: Double) -> OverlaySample {
  guard let first = request.samples.first else { return request.target }
  var previous = first
  for sample in request.samples.dropFirst() {
    if sample.at_ms >= elapsedMs {
      let span = max(1, sample.at_ms - previous.at_ms)
      let t = min(1, max(0, (elapsedMs - previous.at_ms) / span))
      return OverlaySample(
        at_ms: elapsedMs,
        x: previous.x + (sample.x - previous.x) * t,
        y: previous.y + (sample.y - previous.y) * t,
        screenIndex: sample.screenIndex ?? previous.screenIndex
      )
    }
    previous = sample
  }
  return request.target
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
var views: [ComputeOverlayView] = []
for screen in NSScreen.screens {
  let window = ComputeOverlayWindow(
    contentRect: screen.frame,
    styleMask: [.borderless],
    backing: .buffered,
    defer: false,
    screen: screen
  )
  window.level = .screenSaver
  window.backgroundColor = .clear
  window.isOpaque = false
  window.hasShadow = false
  window.ignoresMouseEvents = true
  window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
  let view = ComputeOverlayView(frame: NSRect(origin: .zero, size: screen.frame.size), screenFrame: screen.frame)
  window.contentView = view
  window.orderFrontRegardless()
  views.append(view)
}

let start = ProcessInfo.processInfo.systemUptime
let duration = max(120, request.duration_ms)
Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { timer in
  let elapsed = (ProcessInfo.processInfo.systemUptime - start) * 1000
  let sample = sampleAt(elapsedMs: elapsed)
  let point = appKitPoint(sample)
  let trail = request.samples.filter { $0.at_ms <= elapsed }.suffix(10).map(appKitPoint)
  for view in views { view.update(point: point, trail: trail, request: request, elapsedMs: elapsed, durationMs: duration) }
  if elapsed >= duration {
    print("{\"provider\":\"macos-appkit\",\"status\":\"arrived\",\"acknowledged_at_ms\":\(Int(duration))}")
    fflush(stdout)
    timer.invalidate()
    app.terminate(nil)
  }
}

app.run()
`;
}

export function buildMacosOverlayDaemonSwiftScript(): string {
  return String.raw`
import AppKit
import Foundation
import QuartzCore

let cursorVisualStyle = "mac-glass-pointer-v1"
let cursorSkin = "mac-pointer"

struct OverlaySample: Decodable {
  let at_ms: Double
  let x: Double
  let y: Double
  let screenIndex: Int?
}

struct OverlayAffordance: Decodable {
  let cursor: String?
  let halo: String?
  let trail: Bool?
  let click_ripple: Bool?
}

struct OverlayRequest: Decodable {
  let action_id: String
  let action: String
  let visual_style: String?
  let state: String?
  let affordance: OverlayAffordance?
  let target: OverlaySample
  let duration_ms: Double
  let samples: [OverlaySample]
}

final class ComputeOverlayWindow: NSWindow {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

final class ComputeOverlayView: NSView {
  private let haloLayer = CAShapeLayer()
  private let stateLayer = CAShapeLayer()
  private let coreLayer = CAShapeLayer()
  private let trailLayer = CAShapeLayer()
  private let screenFrame: NSRect

  init(frame: NSRect, screenFrame: NSRect) {
    self.screenFrame = screenFrame
    super.init(frame: frame)
    wantsLayer = true
    layer?.backgroundColor = NSColor.clear.cgColor
    trailLayer.fillColor = NSColor.clear.cgColor
    trailLayer.strokeColor = NSColor(calibratedRed: 0.76, green: 0.60, blue: 0.32, alpha: 0.52).cgColor
    trailLayer.lineWidth = 2
    trailLayer.lineCap = .round
    haloLayer.fillColor = NSColor(calibratedRed: 0.98, green: 0.96, blue: 0.90, alpha: 0.98).cgColor
    haloLayer.strokeColor = NSColor(calibratedRed: 0.09, green: 0.07, blue: 0.05, alpha: 0.96).cgColor
    haloLayer.lineWidth = 2.25
    haloLayer.shadowColor = NSColor(calibratedWhite: 0.0, alpha: 0.45).cgColor
    haloLayer.shadowRadius = 10
    haloLayer.shadowOpacity = 0.72
    haloLayer.shadowOffset = .zero
    stateLayer.fillColor = NSColor.clear.cgColor
    stateLayer.strokeColor = NSColor(calibratedRed: 0.76, green: 0.60, blue: 0.32, alpha: 0.78).cgColor
    stateLayer.lineWidth = 1.5
    stateLayer.opacity = 0
    coreLayer.fillColor = NSColor.clear.cgColor
    coreLayer.strokeColor = NSColor(calibratedWhite: 1.0, alpha: 0.72).cgColor
    coreLayer.lineWidth = 1
    layer?.addSublayer(trailLayer)
    layer?.addSublayer(haloLayer)
    layer?.addSublayer(stateLayer)
    layer?.addSublayer(coreLayer)
  }

  required init?(coder: NSCoder) { nil }

  func update(point: CGPoint, trail: [CGPoint], request: OverlayRequest, elapsedMs: Double, durationMs: Double) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    let local = CGPoint(x: point.x - screenFrame.minX, y: point.y - screenFrame.minY)
    let hotspot = local
    let pointerPath = CGMutablePath()
    pointerPath.move(to: local)
    pointerPath.addLine(to: CGPoint(x: local.x, y: local.y + 45))
    pointerPath.addLine(to: CGPoint(x: local.x + 13, y: local.y + 32))
    pointerPath.addLine(to: CGPoint(x: local.x + 21, y: local.y + 55))
    pointerPath.addLine(to: CGPoint(x: local.x + 31, y: local.y + 51))
    pointerPath.addLine(to: CGPoint(x: local.x + 23, y: local.y + 29))
    pointerPath.addLine(to: CGPoint(x: local.x + 43, y: local.y + 29))
    pointerPath.closeSubpath()
    let highlightPath = CGMutablePath()
    highlightPath.move(to: CGPoint(x: local.x + 6, y: local.y + 8))
    highlightPath.addLine(to: CGPoint(x: local.x + 6, y: local.y + 34))
    let trailPath = CGMutablePath()
    for (index, global) in trail.enumerated() {
      let p = CGPoint(x: global.x - screenFrame.minX, y: global.y - screenFrame.minY)
      if index == 0 { trailPath.move(to: p) } else { trailPath.addLine(to: p) }
    }
    let state = request.state ?? ""
    let halo = request.affordance?.halo ?? ""
    let clickRipple = request.affordance?.click_ripple ?? false
    let pressProgress = durationMs > 0 ? elapsedMs / durationMs : 1
    let isPressure = (state == "press" || halo == "pressure-bloom" || clickRipple) && pressProgress >= 0.78
    let isOrbit = state == "wait" || halo == "busy-orbit"
    let statePath = CGMutablePath()
    statePath.addEllipse(in: CGRect(x: local.x - 14, y: local.y - 14, width: 30, height: 30))
    haloLayer.path = pointerPath
    coreLayer.path = highlightPath
    trailLayer.path = trailPath
    stateLayer.path = statePath
    stateLayer.opacity = isPressure || isOrbit ? 1 : 0
    stateLayer.lineDashPattern = isOrbit ? [4 as NSNumber, 5 as NSNumber] : nil
    CATransaction.commit()
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let displayHeight = NSScreen.screens.map { $0.frame.maxY }.max() ?? 0
var views: [ComputeOverlayView] = []
var activeTimer: Timer?

for screen in NSScreen.screens {
  let window = ComputeOverlayWindow(
    contentRect: screen.frame,
    styleMask: [.borderless],
    backing: .buffered,
    defer: false,
    screen: screen
  )
  window.level = .screenSaver
  window.backgroundColor = .clear
  window.isOpaque = false
  window.hasShadow = false
  window.ignoresMouseEvents = true
  window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
  let view = ComputeOverlayView(frame: NSRect(origin: .zero, size: screen.frame.size), screenFrame: screen.frame)
  window.contentView = view
  window.orderFrontRegardless()
  views.append(view)
}

print("{\"provider\":\"macos-appkit\",\"status\":\"ready\"}")
fflush(stdout)

func appKitPoint(_ sample: OverlaySample) -> CGPoint {
  CGPoint(x: sample.x, y: displayHeight - sample.y)
}

func sampleAt(_ request: OverlayRequest, elapsedMs: Double) -> OverlaySample {
  guard let first = request.samples.first else { return request.target }
  var previous = first
  for sample in request.samples.dropFirst() {
    if sample.at_ms >= elapsedMs {
      let span = max(1, sample.at_ms - previous.at_ms)
      let t = min(1, max(0, (elapsedMs - previous.at_ms) / span))
      return OverlaySample(
        at_ms: elapsedMs,
        x: previous.x + (sample.x - previous.x) * t,
        y: previous.y + (sample.y - previous.y) * t,
        screenIndex: sample.screenIndex ?? previous.screenIndex
      )
    }
    previous = sample
  }
  return request.target
}

func render(request: OverlayRequest) {
  activeTimer?.invalidate()
  let start = ProcessInfo.processInfo.systemUptime
  let duration = max(120, request.duration_ms)
  activeTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { timer in
    let elapsed = (ProcessInfo.processInfo.systemUptime - start) * 1000
    let sample = sampleAt(request, elapsedMs: elapsed)
    let point = appKitPoint(sample)
    let trail = request.samples.filter { $0.at_ms <= elapsed }.suffix(10).map(appKitPoint)
    for view in views { view.update(point: point, trail: trail, request: request, elapsedMs: elapsed, durationMs: duration) }
    if elapsed >= duration {
      print("{\"provider\":\"macos-appkit\",\"status\":\"arrived\",\"acknowledged_at_ms\":\(Int(duration))}")
      fflush(stdout)
      timer.invalidate()
      activeTimer = nil
    }
  }
}

DispatchQueue.global(qos: .userInitiated).async {
  while let line = readLine() {
    guard let data = line.data(using: .utf8) else { continue }
    do {
      let request = try JSONDecoder().decode(OverlayRequest.self, from: data)
      DispatchQueue.main.async {
        render(request: request)
      }
    } catch {
      print("{\"provider\":\"macos-appkit\",\"status\":\"failed\",\"error\":\"invalid request\"}")
      fflush(stdout)
    }
  }
  DispatchQueue.main.async { app.terminate(nil) }
}

app.run()
`;
}

function parseOverlayStatus(stdout: string): ComputeVisualOverlayStatus {
  try {
    const value = JSON.parse(
      stdout.trim(),
    ) as Partial<ComputeVisualOverlayStatus>;
    if (value.provider === "macos-appkit" && typeof value.status === "string") {
      return value as ComputeVisualOverlayStatus;
    }
  } catch {
    // handled below
  }
  return {
    provider: "macos-appkit",
    status: "failed",
    error: "overlay sidecar returned invalid JSON",
  };
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

const defaultShell: MacosOverlayShell = {
  run(command, args, opts) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: opts?.timeoutMs ?? 2_000,
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        if (code !== 0) {
          reject(new Error(stderr || `${command} exited with code ${code}`));
          return;
        }
        resolve({ stdout, stderr });
      });
      if (opts?.input !== undefined) {
        child.stdin.write(opts.input);
      }
      child.stdin.end();
    });
  },
};
