/**
 * @owner   src/transport/adapters/desktop-ax-background-input-swift.ts
 * @does    Generate Swift for scoped macOS background window activation and pid-addressed input.
 * @needs   desktop-ax target resolution, background activation/window/input Swift fragments
 * @feeds   desktop-ax background click/type/press actions
 * @breaks  Invalid event fields or focus suppression regressions can steal focus or drop background input.
 */

import type { ResolvedAxTarget } from "./desktop-ax-swift.js";
import { swiftStringArray, swiftStringLiteral } from "./desktop-ax-swift.js";
import { swiftBackgroundActivationSupportCode } from "./desktop-ax-background-activation-swift.js";
import { swiftBackgroundDispatcherSupportCode } from "./desktop-ax-background-dispatch-swift.js";
import { swiftBackgroundWindowSupportCode } from "./desktop-ax-background-window-swift.js";

export type AxBackgroundInputAction = "click" | "type_text" | "press_key";

export interface AxBackgroundInputScriptOptions {
  action: AxBackgroundInputAction;
  x?: number;
  y?: number;
  coordinateSpace: "screen" | "window";
  button: number;
  clickCount: number;
  windowNumber?: number;
  text?: string;
  key?: string;
  clickBeforeText?: boolean;
}

export function buildAxBackgroundInputScript(
  target: ResolvedAxTarget,
  opts: AxBackgroundInputScriptOptions,
): string {
  const action = opts.action;
  const x = normalizeNumber(opts.x, 0);
  const y = normalizeNumber(opts.y, 0);
  const hasPoint =
    typeof opts.x === "number" &&
    Number.isFinite(opts.x) &&
    typeof opts.y === "number" &&
    Number.isFinite(opts.y);
  const coordinateSpace =
    opts.coordinateSpace === "screen" ? "screen" : "window";
  const button = Math.max(0, Math.trunc(opts.button));
  const clickCount = Math.max(1, Math.trunc(opts.clickCount));
  const windowNumber = opts.windowNumber
    ? Math.max(0, Math.trunc(opts.windowNumber))
    : 0;

  return [
    `import AppKit`,
    `import ApplicationServices`,
    `import Carbon.HIToolbox`,
    `import CoreFoundation`,
    `import CoreGraphics`,
    `import Darwin`,
    `import Foundation`,
    ``,
    ...buildRunningAppPrelude(target),
    swiftEmitHelper(),
    `let commandMode = "background_input"`,
    `let requestedAction = ${swiftStringLiteral(action)}`,
    `let inputX = CGFloat(${x})`,
    `let inputY = CGFloat(${y})`,
    `let hasInputPoint = ${hasPoint ? "true" : "false"}`,
    `let coordinateSpace = ${swiftStringLiteral(coordinateSpace)}`,
    `let buttonIndex = ${button}`,
    `let requestedClickCount = ${clickCount}`,
    `let requestedWindowNumber = ${windowNumber}`,
    `let inputText = ${swiftStringLiteral(opts.text ?? "")}`,
    `let inputKey = ${swiftStringLiteral(opts.key ?? "")}`,
    `let clickBeforeText = ${opts.clickBeforeText === false ? "false" : "true"}`,
    ``,
    swiftSupportCode(),
    ``,
    `guard let running else {`,
    `  emit(["found": false, "posted": false, "mode": commandMode, "action": requestedAction, "bundleId": bundleId, "localizedName": processName, "reason": "target_app_not_running"])`,
    `  exit(0)`,
    `}`,
    ``,
    `guard let window = targetWindow(pid: running.processIdentifier) else {`,
    `  emit(["found": true, "posted": false, "mode": commandMode, "action": requestedAction, "pid": Int(running.processIdentifier), "reason": "window_not_found"])`,
    `  exit(0)`,
    `}`,
    ``,
    `if requestedAction == "click" && !hasInputPoint {`,
    `  emit(["found": true, "posted": false, "mode": commandMode, "action": requestedAction, "pid": Int(running.processIdentifier), "windowNumber": Int(window.id), "reason": "missing_point"])`,
    `  exit(0)`,
    `}`,
    `if requestedAction == "type_text" && inputText.isEmpty {`,
    `  emit(["found": true, "posted": true, "mode": commandMode, "action": requestedAction, "pid": Int(running.processIdentifier), "windowNumber": Int(window.id), "typedCharacters": 0])`,
    `  exit(0)`,
    `}`,
    `if requestedAction == "press_key" && inputKey.isEmpty {`,
    `  emit(["found": true, "posted": false, "mode": commandMode, "action": requestedAction, "pid": Int(running.processIdentifier), "windowNumber": Int(window.id), "reason": "missing_key"])`,
    `  exit(0)`,
    `}`,
    ``,
    `let wasFrontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier == running.processIdentifier`,
    `let activation: ScopedWindowActivationSession?`,
    `if wasFrontmost {`,
    `  activation = nil`,
    `} else {`,
    `  guard let session = ScopedWindowActivationSession.start(targetPID: running.processIdentifier) else {`,
    `    emit(["found": true, "posted": false, "mode": commandMode, "action": requestedAction, "pid": Int(running.processIdentifier), "windowNumber": Int(window.id), "reason": "focus_suppression_tap_failed"])`,
    `    exit(0)`,
    `  }`,
    `  activation = session`,
    `}`,
    `defer {`,
    `  if !wasFrontmost { activation?.restoreBackgroundActivationIfNeeded(windowNumber: Int(window.id)) }`,
    `  activation?.finish()`,
    `}`,
    ``,
    `if !wasFrontmost {`,
    `  activation?.beginTargetDelivery()`,
    `  ScopedWindowActivationSession.activateWindow(targetPID: running.processIdentifier, windowNumber: Int(window.id), windowFrame: window.frame)`,
    `  activation?.holdFocusSuppressionUntilFinish()`,
    `}`,
    ``,
    `let requestedPoint = hasInputPoint ? requestedScreenPoint(windowFrame: window.frame) : CGPoint(x: window.frame.midX, y: window.frame.midY)`,
    `let dispatcher = ScopedWindowInputDispatcher(targetPID: running.processIdentifier, windowNumber: Int(window.id), windowFrame: window.frame)`,
    `do {`,
    `  switch requestedAction {`,
    `  case "click":`,
    `    try dispatcher.click(atScreenPoint: requestedPoint, buttonIndex: buttonIndex, clickCount: requestedClickCount)`,
    `    emitSuccess(window: window, running: running, wasFrontmost: wasFrontmost, extra: ["screenX": Double(requestedPoint.x), "screenY": Double(requestedPoint.y)])`,
    `  case "type_text":`,
    `    if clickBeforeText && hasInputPoint {`,
    `      try dispatcher.click(atScreenPoint: requestedPoint, buttonIndex: 0, clickCount: 1)`,
    `      usleep(30_000)`,
    `    }`,
    `    try dispatcher.typeText(inputText)`,
    `    emitSuccess(window: window, running: running, wasFrontmost: wasFrontmost, extra: ["typedCharacters": inputText.count])`,
    `  case "press_key":`,
    `    try dispatcher.press(inputKey)`,
    `    emitSuccess(window: window, running: running, wasFrontmost: wasFrontmost, extra: ["key": inputKey])`,
    `  default:`,
    `    emit(["found": true, "posted": false, "mode": commandMode, "action": requestedAction, "pid": Int(running.processIdentifier), "windowNumber": Int(window.id), "reason": "unsupported_action"])`,
    `  }`,
    `} catch {`,
    `  emit(["found": true, "posted": false, "mode": commandMode, "action": requestedAction, "pid": Int(running.processIdentifier), "windowNumber": Int(window.id), "reason": String(describing: error)])`,
    `}`,
  ].join("\n");
}

function buildRunningAppPrelude(target: ResolvedAxTarget): string[] {
  return [
    `let bundleId: String? = ${swiftStringLiteral(target.bundleId ?? "")}.isEmpty ? nil : ${swiftStringLiteral(target.bundleId ?? "")}`,
    `let processName: String? = ${swiftStringLiteral(target.processName)}.isEmpty ? nil : ${swiftStringLiteral(target.processName)}`,
    `let executableNames: [String] = ${swiftStringArray(target.executableNames)}`,
    `func matches(_ app: NSRunningApplication) -> Bool {`,
    `  if let bundleId, app.bundleIdentifier == bundleId { return true }`,
    `  if let processName, app.localizedName == processName { return true }`,
    `  if let executable = app.executableURL?.lastPathComponent, executableNames.contains(executable) { return true }`,
    `  return false`,
    `}`,
    `let running = NSWorkspace.shared.runningApplications.first(where: matches)`,
  ];
}

function swiftEmitHelper(): string {
  return [
    `func emit(_ object: [String: Any?]) {`,
    `  let flat = object.reduce(into: [String: Any]()) { acc, item in`,
    `    if let value = item.value { acc[item.key] = value }`,
    `  }`,
    `  let data = try! JSONSerialization.data(withJSONObject: flat, options: [])`,
    `  FileHandle.standardOutput.write(data)`,
    `}`,
  ].join("\n");
}

function swiftSupportCode(): string {
  return [
    swiftBackgroundWindowSupportCode(),
    swiftBackgroundActivationSupportCode(),
    swiftBackgroundDispatcherSupportCode(),
  ].join("\n");
}

function normalizeNumber(value: number | undefined, fallback: number): string {
  return String(
    typeof value === "number" && Number.isFinite(value) ? value : fallback,
  );
}
