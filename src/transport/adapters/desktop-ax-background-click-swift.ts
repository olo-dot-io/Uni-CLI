import type { ResolvedAxTarget } from "./desktop-ax-swift.js";

export interface AxBackgroundClickScriptOptions {
  x: number;
  y: number;
  coordinateSpace: "screen" | "window";
  button: number;
  clickCount: number;
  windowNumber?: number;
}

export function buildAxBackgroundClickScript(
  target: ResolvedAxTarget,
  opts: AxBackgroundClickScriptOptions,
): string {
  const x = normalizeNumber(opts.x, 0);
  const y = normalizeNumber(opts.y, 0);
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
    `import CoreGraphics`,
    `import CoreFoundation`,
    `import Darwin`,
    `import Foundation`,
    ``,
    ...buildRunningAppPrelude(target),
    swiftEmitHelper(),
    `let commandMode = "background_click"`,
    `let inputX = CGFloat(${x})`,
    `let inputY = CGFloat(${y})`,
    `let coordinateSpace = ${swiftStringLiteral(coordinateSpace)}`,
    `let buttonIndex = ${button}`,
    `let requestedClickCount = ${clickCount}`,
    `let requestedWindowNumber = ${windowNumber}`,
    ``,
    `typealias CGEventSetWindowLocationFn = @convention(c) (CGEvent, CGPoint) -> Void`,
    `func loadSetWindowLocation() -> CGEventSetWindowLocationFn? {`,
    `  guard let symbol = dlsym(dlopen(nil, RTLD_NOW), "CGEventSetWindowLocation") else { return nil }`,
    `  return unsafeBitCast(symbol, to: CGEventSetWindowLocationFn.self)`,
    `}`,
    ``,
    `func number(_ dict: NSDictionary, _ key: CFString) -> NSNumber? { dict[key as String] as? NSNumber }`,
    ``,
    `func rect(_ dict: NSDictionary) -> CGRect? {`,
    `  guard let raw = dict[kCGWindowBounds as String] as? NSDictionary else { return nil }`,
    `  var rect = CGRect.zero`,
    `  return CGRectMakeWithDictionaryRepresentation(raw, &rect) ? rect : nil`,
    `}`,
    ``,
    `func targetWindow(pid: pid_t) -> (id: CGWindowID, frame: CGRect)? {`,
    `  guard let list = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [NSDictionary] else { return nil }`,
    `  for item in list {`,
    `    guard number(item, kCGWindowOwnerPID)?.int32Value == pid else { continue }`,
    `    guard let idNumber = number(item, kCGWindowNumber), let frame = rect(item), !frame.isEmpty else { continue }`,
    `    let windowId = CGWindowID(idNumber.uint32Value)`,
    `    if requestedWindowNumber == 0 || requestedWindowNumber == Int(windowId) { return (windowId, frame) }`,
    `  }`,
    `  return nil`,
    `}`,
    ``,
    `func eventType(down: Bool) -> NSEvent.EventType {`,
    `  if buttonIndex == 1 { return down ? .rightMouseDown : .rightMouseUp }`,
    `  if buttonIndex == 2 { return down ? .otherMouseDown : .otherMouseUp }`,
    `  return down ? .leftMouseDown : .leftMouseUp`,
    `}`,
    ``,
    `func makeEvent(down: Bool, screenPoint: CGPoint, windowPoint: CGPoint, windowNumber: CGWindowID, eventNumber: Int, isBackground: Bool, setWindowLocation: CGEventSetWindowLocationFn?) -> CGEvent? {`,
    `  guard let event = NSEvent.mouseEvent(with: eventType(down: down), location: screenPoint, modifierFlags: isBackground ? [.command] : [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: Int(windowNumber), context: nil, eventNumber: eventNumber, clickCount: requestedClickCount, pressure: down ? 1.0 : 0.0) else { return nil }`,
    `  guard let cg = event.cgEvent else { return nil }`,
    `  cg.location = screenPoint`,
    `  if isBackground { cg.flags = CGEventFlags.maskCommand }`,
    `  cg.setIntegerValueField(CGEventField(rawValue: 3)!, value: Int64(buttonIndex))`,
    `  cg.setIntegerValueField(CGEventField(rawValue: 7)!, value: 3)`,
    `  cg.setIntegerValueField(CGEventField(rawValue: 91)!, value: Int64(windowNumber))`,
    `  cg.setIntegerValueField(CGEventField(rawValue: 92)!, value: Int64(windowNumber))`,
    `  setWindowLocation?(cg, windowPoint)`,
    `  return cg`,
    `}`,
    ``,
    `guard let running else {`,
    `  emit(["found": false, "mode": commandMode, "bundleId": bundleId, "localizedName": processName])`,
    `  exit(0)`,
    `}`,
    ``,
    `guard let window = targetWindow(pid: running.processIdentifier) else {`,
    `  emit(["found": true, "posted": false, "mode": commandMode, "pid": Int(running.processIdentifier), "reason": "window_not_found"])`,
    `  exit(0)`,
    `}`,
    ``,
    `let screenPoint = coordinateSpace == "screen" ? CGPoint(x: inputX, y: inputY) : CGPoint(x: window.frame.origin.x + inputX, y: window.frame.origin.y + inputY)`,
    `let windowPoint = screenPoint.applying(CGAffineTransform(translationX: -window.frame.origin.x, y: -window.frame.origin.y))`,
    `let setWindowLocation = loadSetWindowLocation()`,
    `let isBackground = !running.isActive`,
    `let eventNumber = Int((ProcessInfo.processInfo.systemUptime * 1_000_000).truncatingRemainder(dividingBy: 2_147_483_647))`,
    `guard let down = makeEvent(down: true, screenPoint: screenPoint, windowPoint: windowPoint, windowNumber: window.id, eventNumber: eventNumber, isBackground: isBackground, setWindowLocation: setWindowLocation), let up = makeEvent(down: false, screenPoint: screenPoint, windowPoint: windowPoint, windowNumber: window.id, eventNumber: eventNumber + 1, isBackground: isBackground, setWindowLocation: setWindowLocation) else {`,
    `  emit(["found": true, "posted": false, "mode": commandMode, "pid": Int(running.processIdentifier), "windowNumber": Int(window.id), "reason": "event_create_failed"])`,
    `  exit(0)`,
    `}`,
    `down.postToPid(running.processIdentifier)`,
    `up.postToPid(running.processIdentifier)`,
    `emit(["found": true, "posted": true, "mode": commandMode, "pid": Int(running.processIdentifier), "windowNumber": Int(window.id), "screenX": Double(screenPoint.x), "screenY": Double(screenPoint.y), "windowX": Double(windowPoint.x), "windowY": Double(windowPoint.y), "commandFlagApplied": isBackground, "setWindowLocationAvailable": setWindowLocation != nil])`,
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
    ``,
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

function swiftStringLiteral(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replaceAll("\0", "")}"`;
}

function swiftStringArray(values: readonly string[]): string {
  return `[${values.map(swiftStringLiteral).join(", ")}]`;
}

function normalizeNumber(value: number, fallback: number): string {
  return String(Number.isFinite(value) ? value : fallback);
}
