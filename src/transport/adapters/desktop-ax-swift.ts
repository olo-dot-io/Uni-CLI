import { findElectronApp } from "../../electron-apps.js";

export interface ResolvedAxTarget {
  appName: string;
  openArgs: readonly string[];
  activationRef: string;
  uiProcessName: string;
  bundleId?: string;
  processName: string;
  executableNames: readonly string[];
  ensureElectronAx: boolean;
}

export interface AxWarmupResult {
  trusted: boolean;
  found: boolean;
  pid?: number;
  bundleId?: string | null;
  localizedName?: string | null;
  setResults?: Record<string, number>;
  observerCreated?: boolean;
  observerResults?: Record<string, number>;
  pumpMs?: number;
}

export interface AxSnapshotScriptOptions {
  maxDepth: number;
  scope: "focusedWindow" | "focusedElement";
}

export interface AxElementQuery {
  focused: boolean;
  maxDepth: number;
  roles: readonly string[];
  subroles: readonly string[];
  titles: readonly string[];
  descriptions: readonly string[];
  identifiers: readonly string[];
  titlePrefix: boolean;
  descriptionPrefix: boolean;
}

export interface AxSetValueScriptOptions extends AxElementQuery {
  attribute: string;
  value: string;
}

export interface AxPressScriptOptions extends AxElementQuery {
  actionName: string;
}

export function buildElectronAxWarmupScript(
  target: ResolvedAxTarget,
  waitMs: number,
): string {
  return [
    `import AppKit`,
    `import ApplicationServices`,
    `import CoreFoundation`,
    `import Foundation`,
    ``,
    ...buildRunningAppPrelude(target, waitMs),
    `let pumpMs = 500`,
    `let trusted = AXIsProcessTrusted()`,
    ``,
    swiftEmitHelper(),
    ``,
    `guard let running else {`,
    `  emit([`,
    `    "trusted": trusted,`,
    `    "found": false,`,
    `    "bundleId": bundleId,`,
    `    "localizedName": processName,`,
    `  ])`,
    `  exit(0)`,
    `}`,
    ``,
    `guard trusted else {`,
    `  emit([`,
    `    "trusted": false,`,
    `    "found": true,`,
    `    "pid": Int(running.processIdentifier),`,
    `    "bundleId": running.bundleIdentifier ?? bundleId,`,
    `    "localizedName": running.localizedName ?? processName,`,
    `  ])`,
    `  exit(0)`,
    `}`,
    ``,
    `let root = AXUIElementCreateApplication(running.processIdentifier)`,
    `let attributes = ["AXManualAccessibility", "AXEnhancedUserInterface"]`,
    `var setResults: [String: Int] = [:]`,
    `for attr in attributes {`,
    `  let result = AXUIElementSetAttributeValue(root, attr as CFString, kCFBooleanTrue)`,
    `  setResults[attr] = Int(result.rawValue)`,
    `}`,
    ``,
    `var observerCreated = false`,
    `var observerResults: [String: Int] = [:]`,
    `var observer: AXObserver?`,
    `let createResult = AXObserverCreate(running.processIdentifier, { _, _, _, _ in }, &observer)`,
    `observerResults["__create__"] = Int(createResult.rawValue)`,
    `if createResult == .success, let observer {`,
    `  observerCreated = true`,
    `  if let source = AXObserverGetRunLoopSource(observer) as CFRunLoopSource? {`,
    `    CFRunLoopAddSource(CFRunLoopGetCurrent(), source, CFRunLoopMode.defaultMode)`,
    `  }`,
    `  let notifications = ["AXFocusedUIElementChanged", "AXWindowCreated", "AXValueChanged"]`,
    `  for note in notifications {`,
    `    let result = AXObserverAddNotification(observer, root, note as CFString, nil)`,
    `    observerResults[note] = Int(result.rawValue)`,
    `  }`,
    `  let end = CFAbsoluteTimeGetCurrent() + Double(pumpMs) / 1000.0`,
    `  while CFAbsoluteTimeGetCurrent() < end {`,
    `    _ = CFRunLoopRunInMode(CFRunLoopMode.defaultMode, end - CFAbsoluteTimeGetCurrent(), false)`,
    `  }`,
    `}`,
    ``,
    `emit([`,
    `  "trusted": true,`,
    `  "found": true,`,
    `  "pid": Int(running.processIdentifier),`,
    `  "bundleId": running.bundleIdentifier ?? bundleId,`,
    `  "localizedName": running.localizedName ?? processName,`,
    `  "setResults": setResults,`,
    `  "observerCreated": observerCreated,`,
    `  "observerResults": observerResults,`,
    `  "pumpMs": pumpMs,`,
    `])`,
  ].join("\n");
}

export function buildAxSnapshotScript(
  target: ResolvedAxTarget,
  opts: AxSnapshotScriptOptions,
): string {
  return [
    `import AppKit`,
    `import ApplicationServices`,
    `import CoreFoundation`,
    `import Foundation`,
    ``,
    ...buildRunningAppPrelude(target, 0),
    swiftEmitHelper(),
    swiftAxHelpers(),
    `let commandMode = "snapshot"`,
    `let snapshotScope = ${swiftStringLiteral(opts.scope)}`,
    `let snapshotMaxDepth = ${normalizeInt(opts.maxDepth, 3)}`,
    ``,
    `guard let running else {`,
    `  emit([`,
    `    "found": false,`,
    `    "scope": snapshotScope,`,
    `    "bundleId": bundleId,`,
    `    "localizedName": processName,`,
    `  ])`,
    `  exit(0)`,
    `}`,
    ``,
    `let axApp = AXUIElementCreateApplication(running.processIdentifier)`,
    `let root = snapshotScope == "focusedElement"`,
    `  ? focusedElement(in: axApp) ?? focusedWindow(in: axApp) ?? axApp`,
    `  : focusedWindow(in: axApp) ?? focusedElement(in: axApp) ?? axApp`,
    `emit([`,
    `  "found": true,`,
    `  "matched": true,`,
    `  "mode": commandMode,`,
    `  "scope": snapshotScope,`,
    `  "bundleId": running.bundleIdentifier ?? bundleId,`,
    `  "localizedName": running.localizedName ?? processName,`,
    `  "element": describe(root, depth: 0, maxDepth: snapshotMaxDepth),`,
    `])`,
  ].join("\n");
}

export function buildAxFocusedReadScript(
  target: ResolvedAxTarget,
  query: AxElementQuery,
): string {
  return buildAxElementCommandScript(target, "focused_read", query);
}

export function buildAxSetValueScript(
  target: ResolvedAxTarget,
  opts: AxSetValueScriptOptions,
): string {
  return buildAxElementCommandScript(target, "set_value", opts);
}

export function buildAxPressScript(
  target: ResolvedAxTarget,
  opts: AxPressScriptOptions,
): string {
  return buildAxElementCommandScript(target, "press", opts);
}

export function swiftStringLiteral(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replaceAll("\0", "")}"`;
}

export function swiftStringArray(values: readonly string[]): string {
  return `[${values.map(swiftStringLiteral).join(", ")}]`;
}

export function resolveAxTarget(
  params: Record<string, unknown>,
): ResolvedAxTarget | null {
  const appParam = typeof params.app === "string" ? params.app.trim() : "";
  const bundleIdParam =
    typeof params.bundleId === "string" ? params.bundleId.trim() : "";
  const processNameParam =
    typeof params.processName === "string" ? params.processName.trim() : "";
  const ensureElectronAx =
    typeof params.ensureElectronAx === "boolean"
      ? params.ensureElectronAx
      : undefined;

  const electron =
    findElectronApp(bundleIdParam) ??
    findElectronApp(appParam) ??
    findElectronApp(processNameParam);

  const bundleId = bundleIdParam || electron?.bundleId || undefined;
  const processName =
    processNameParam || electron?.processName || appParam || undefined;
  const appName =
    electron?.displayName || processName || appParam || bundleId || undefined;

  if (!appName || !processName) return null;

  return {
    appName,
    openArgs: bundleId ? ["-b", bundleId] : ["-a", appName],
    activationRef: bundleId
      ? `application id "${escapeAs(bundleId)}"`
      : `application "${escapeAs(appName)}"`,
    uiProcessName: processName,
    bundleId,
    processName,
    executableNames: electron?.executableNames ?? [processName],
    ensureElectronAx: ensureElectronAx ?? Boolean(electron),
  };
}

export function readAxElementQuery(
  params: Record<string, unknown>,
  defaultFocused: boolean,
): AxElementQuery {
  return {
    focused:
      typeof params.focused === "boolean" ? params.focused : defaultFocused,
    maxDepth: readPositiveInt(params.maxDepth, 8),
    roles: readStringList(params.role),
    subroles: readStringList(params.subrole),
    titles: readStringList(params.title),
    descriptions: readStringList(params.description),
    identifiers: readStringList(params.identifier),
    titlePrefix:
      typeof params.titlePrefix === "boolean" ? params.titlePrefix : false,
    descriptionPrefix:
      typeof params.descriptionPrefix === "boolean"
        ? params.descriptionPrefix
        : false,
  };
}

export function hasAxElementMatcher(params: Record<string, unknown>): boolean {
  return (
    readStringList(params.role).length > 0 ||
    readStringList(params.subrole).length > 0 ||
    readStringList(params.title).length > 0 ||
    readStringList(params.description).length > 0 ||
    readStringList(params.identifier).length > 0
  );
}

export function readPositiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : fallback;
}

function buildRunningAppPrelude(
  target: ResolvedAxTarget,
  waitMs: number,
): string[] {
  return [
    `let bundleId: String? = ${swiftStringLiteral(target.bundleId ?? "")}.isEmpty ? nil : ${swiftStringLiteral(target.bundleId ?? "")}`,
    `let processName: String? = ${swiftStringLiteral(target.processName)}.isEmpty ? nil : ${swiftStringLiteral(target.processName)}`,
    `let executableNames: [String] = ${swiftStringArray(target.executableNames)}`,
    `let waitMs = ${normalizeInt(waitMs, 0)}`,
    ``,
    `func matches(_ app: NSRunningApplication) -> Bool {`,
    `  if let bundleId, app.bundleIdentifier == bundleId { return true }`,
    `  if let processName, app.localizedName == processName { return true }`,
    `  if let executable = app.executableURL?.lastPathComponent, executableNames.contains(executable) { return true }`,
    `  return false`,
    `}`,
    ``,
    `let deadline = Date().addingTimeInterval(Double(waitMs) / 1000.0)`,
    `var running = NSWorkspace.shared.runningApplications.first(where: matches)`,
    `while running == nil && waitMs > 0 && Date() < deadline {`,
    `  Thread.sleep(forTimeInterval: 0.1)`,
    `  running = NSWorkspace.shared.runningApplications.first(where: matches)`,
    `}`,
    ``,
  ];
}

function buildAxElementCommandScript(
  target: ResolvedAxTarget,
  mode: "focused_read" | "set_value" | "press",
  opts: AxElementQuery | AxSetValueScriptOptions | AxPressScriptOptions,
): string {
  const setValue = "value" in opts ? opts.value : "";
  const attribute = "attribute" in opts ? opts.attribute : "AXValue";
  const actionName = "actionName" in opts ? opts.actionName : "AXPress";

  return [
    `import AppKit`,
    `import ApplicationServices`,
    `import CoreFoundation`,
    `import Foundation`,
    ``,
    ...buildRunningAppPrelude(target, 0),
    swiftEmitHelper(),
    swiftAxHelpers(),
    `let commandMode = ${swiftStringLiteral(mode)}`,
    `let queryFocused = ${opts.focused ? "true" : "false"}`,
    `let queryMaxDepth = ${normalizeInt(opts.maxDepth, 8)}`,
    `let queryRoles = Set(${swiftStringArray(opts.roles)})`,
    `let querySubroles = Set(${swiftStringArray(opts.subroles)})`,
    `let queryTitles = Set(${swiftStringArray(opts.titles)})`,
    `let queryDescriptions = Set(${swiftStringArray(opts.descriptions)})`,
    `let queryIdentifiers = Set(${swiftStringArray(opts.identifiers)})`,
    `let queryTitlePrefix = ${opts.titlePrefix ? "true" : "false"}`,
    `let queryDescriptionPrefix = ${opts.descriptionPrefix ? "true" : "false"}`,
    `let writeAttribute = ${swiftStringLiteral(attribute)}`,
    `let writeValue = ${swiftStringLiteral(setValue)}`,
    `let performActionName = ${swiftStringLiteral(actionName)}`,
    ``,
    `func matchesValue(_ value: String?, _ candidates: Set<String>, prefix: Bool = false) -> Bool {`,
    `  if candidates.isEmpty { return true }`,
    `  guard let value else { return false }`,
    `  if prefix { return candidates.contains(where: { value.hasPrefix($0) }) }`,
    `  return candidates.contains(value)`,
    `}`,
    ``,
    `func matchesQuery(_ element: AXUIElement) -> Bool {`,
    `  let role = stringAttr(element, kAXRoleAttribute as String)`,
    `  let subrole = stringAttr(element, kAXSubroleAttribute as String)`,
    `  let title = stringAttr(element, kAXTitleAttribute as String)`,
    `  let description = stringAttr(element, kAXDescriptionAttribute as String)`,
    `  let identifier = stringAttr(element, "AXIdentifier")`,
    `  return matchesValue(role, queryRoles)`,
    `    && matchesValue(subrole, querySubroles)`,
    `    && matchesValue(title, queryTitles, prefix: queryTitlePrefix)`,
    `    && matchesValue(description, queryDescriptions, prefix: queryDescriptionPrefix)`,
    `    && matchesValue(identifier, queryIdentifiers)`,
    `}`,
    ``,
    `func findMatching(_ root: AXUIElement, depth: Int = 0) -> AXUIElement? {`,
    `  guard depth <= queryMaxDepth else { return nil }`,
    `  if matchesQuery(root) { return root }`,
    `  for child in children(root) {`,
    `    if let found = findMatching(child, depth: depth + 1) { return found }`,
    `  }`,
    `  return nil`,
    `}`,
    ``,
    `func selectElement(in app: AXUIElement) -> AXUIElement? {`,
    `  let focused = focusedElement(in: app)`,
    `  let hasQuery = !queryRoles.isEmpty || !querySubroles.isEmpty || !queryTitles.isEmpty || !queryDescriptions.isEmpty || !queryIdentifiers.isEmpty`,
    `  if !hasQuery {`,
    `    return focused ?? focusedWindow(in: app)`,
    `  }`,
    `  if queryFocused, let focused, matchesQuery(focused) {`,
    `    return focused`,
    `  }`,
    `  if queryFocused { return nil }`,
    `  if let window = focusedWindow(in: app), let found = findMatching(window) {`,
    `    return found`,
    `  }`,
    `  return findMatching(app)`,
    `}`,
    ``,
    `guard let running else {`,
    `  emit([`,
    `    "found": false,`,
    `    "mode": commandMode,`,
    `    "bundleId": bundleId,`,
    `    "localizedName": processName,`,
    `  ])`,
    `  exit(0)`,
    `}`,
    ``,
    `let axApp = AXUIElementCreateApplication(running.processIdentifier)`,
    `guard let element = selectElement(in: axApp) else {`,
    `  emit([`,
    `    "found": true,`,
    `    "matched": false,`,
    `    "mode": commandMode,`,
    `    "bundleId": running.bundleIdentifier ?? bundleId,`,
    `    "localizedName": running.localizedName ?? processName,`,
    `  ])`,
    `  exit(0)`,
    `}`,
    ``,
    `switch commandMode {`,
    `case "set_value":`,
    `  let result = AXUIElementSetAttributeValue(element, writeAttribute as CFString, writeValue as CFTypeRef)`,
    `  Thread.sleep(forTimeInterval: 0.15)`,
    `  emit([`,
    `    "found": true,`,
    `    "matched": true,`,
    `    "mode": commandMode,`,
    `    "bundleId": running.bundleIdentifier ?? bundleId,`,
    `    "localizedName": running.localizedName ?? processName,`,
    `    "attribute": writeAttribute,`,
    `    "result": Int(result.rawValue),`,
    `    "element": describe(element, depth: 0, maxDepth: 1),`,
    `  ])`,
    `case "press":`,
    `  let result = AXUIElementPerformAction(element, performActionName as CFString)`,
    `  emit([`,
    `    "found": true,`,
    `    "matched": true,`,
    `    "mode": commandMode,`,
    `    "bundleId": running.bundleIdentifier ?? bundleId,`,
    `    "localizedName": running.localizedName ?? processName,`,
    `    "action": performActionName,`,
    `    "result": Int(result.rawValue),`,
    `    "element": describe(element, depth: 0, maxDepth: 1),`,
    `  ])`,
    `default:`,
    `  emit([`,
    `    "found": true,`,
    `    "matched": true,`,
    `    "mode": commandMode,`,
    `    "bundleId": running.bundleIdentifier ?? bundleId,`,
    `    "localizedName": running.localizedName ?? processName,`,
    `    "element": describe(element, depth: 0, maxDepth: 1),`,
    `  ])`,
    `}`,
  ].join("\n");
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

function swiftAxHelpers(): string {
  return [
    ``,
    `func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {`,
    `  var value: CFTypeRef?`,
    `  guard AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success else { return nil }`,
    `  return value as AnyObject?`,
    `}`,
    ``,
    `func stringAttr(_ el: AXUIElement, _ name: String) -> String? {`,
    `  if let value = attr(el, name) as? String, !value.isEmpty { return value }`,
    `  return nil`,
    `}`,
    ``,
    `func boolAttr(_ el: AXUIElement, _ name: String) -> Bool? {`,
    `  if let value = attr(el, name) as? NSNumber { return value.boolValue }`,
    `  return nil`,
    `}`,
    ``,
    `func valueAttr(_ el: AXUIElement) -> Any? {`,
    `  guard let raw = attr(el, kAXValueAttribute as String) else { return nil }`,
    `  if let value = raw as? String { return value }`,
    `  if let value = raw as? NSNumber { return value }`,
    `  return String(describing: raw)`,
    `}`,
    ``,
    `func children(_ el: AXUIElement) -> [AXUIElement] {`,
    `  (attr(el, kAXChildrenAttribute as String) as? [AnyObject] ?? []).compactMap { $0 as? AXUIElement }`,
    `}`,
    ``,
    `func actionNames(_ el: AXUIElement) -> [String] {`,
    `  var raw: CFArray?`,
    `  guard AXUIElementCopyActionNames(el, &raw) == .success else { return [] }`,
    `  return raw as? [String] ?? []`,
    `}`,
    ``,
    `func focusedWindow(in app: AXUIElement) -> AXUIElement? {`,
    `  if let window = attr(app, kAXFocusedWindowAttribute as String) as? AXUIElement { return window }`,
    `  return nil`,
    `}`,
    ``,
    `func focusedElement(in app: AXUIElement) -> AXUIElement? {`,
    `  if let focused = attr(app, kAXFocusedUIElementAttribute as String) as? AXUIElement { return focused }`,
    `  if let window = focusedWindow(in: app), let focused = attr(window, kAXFocusedUIElementAttribute as String) as? AXUIElement {`,
    `    return focused`,
    `  }`,
    `  return nil`,
    `}`,
    ``,
    `func describe(_ el: AXUIElement, depth: Int, maxDepth: Int) -> [String: Any] {`,
    `  var out: [String: Any] = [:]`,
    `  if let role = stringAttr(el, kAXRoleAttribute as String) { out["role"] = role }`,
    `  if let subrole = stringAttr(el, kAXSubroleAttribute as String) { out["subrole"] = subrole }`,
    `  if let title = stringAttr(el, kAXTitleAttribute as String) { out["title"] = title }`,
    `  if let description = stringAttr(el, kAXDescriptionAttribute as String) { out["description"] = description }`,
    `  if let identifier = stringAttr(el, "AXIdentifier") { out["identifier"] = identifier }`,
    `  if let value = valueAttr(el) { out["value"] = value }`,
    `  if let enabled = boolAttr(el, kAXEnabledAttribute as String) { out["enabled"] = enabled }`,
    `  let actions = actionNames(el)`,
    `  if !actions.isEmpty { out["actions"] = actions }`,
    `  let kids = children(el)`,
    `  out["childCount"] = kids.count`,
    `  if depth < maxDepth {`,
    `    out["children"] = Array(kids.prefix(50)).map { describe($0, depth: depth + 1, maxDepth: maxDepth) }`,
    `  }`,
    `  return out`,
    `}`,
  ].join("\n");
}

function normalizeInt(value: number, fallback: number): string {
  return String(readPositiveInt(value, fallback));
}

function readStringList(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

function escapeAs(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]/g, " ")
    .replaceAll("\0", "");
}
