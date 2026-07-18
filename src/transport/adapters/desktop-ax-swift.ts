/**
 * @owner       src::transport::adapters::desktop-ax-swift
 * @does        Resolve macOS AX targets and generate bounded Swift programs for exact-window observation and exact-path mutation.
 * @needs       Electron app registry, CoreGraphics window metadata, and shared background-input script builders.
 * @feeds       desktop AX transport actions and generated-script typecheck tests.
 * @breaks      Missing live AX state, exact CoreGraphics window identity, or AX traversal provenance can observe or mutate an unrelated surface.
 * @invariants  Generated programs select one explicit process and exact window, emit one JSON result, preserve native element state, and revalidate the exact AX traversal path before mutation without activating the app unless requested.
 * @side-effects Generated programs may inspect or mutate the selected macOS application when executed.
 * @perf        Snapshot recursion and child fanout are bounded by caller depth and 50 children per node.
 * @concurrency Generated scripts retain only request-local process, window, and traversal-path state.
 * @test        tests/unit/transport/adapters/desktop-ax.test.ts
 * @stability   stable
 * @since       2026-07-15
 */

import { findElectronApp } from "../../electron-apps.js";
export {
  buildAxBackgroundClickScript,
  type AxBackgroundClickScriptOptions,
} from "./desktop-ax-background-click-swift.js";
export {
  buildAxBackgroundInputScript,
  type AxBackgroundInputAction,
  type AxBackgroundInputScriptOptions,
} from "./desktop-ax-background-input-swift.js";

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
  windowId?: number;
}

export interface AxElementQuery {
  focused: boolean;
  maxDepth: number;
  windowId?: number;
  path?: readonly AxPathSegment[];
  roles: readonly string[];
  subroles: readonly string[];
  names: readonly string[];
  titles: readonly string[];
  descriptions: readonly string[];
  identifiers: readonly string[];
  namePrefix: boolean;
  titlePrefix: boolean;
  descriptionPrefix: boolean;
}

export interface AxPathSegment {
  role: string;
  index: number;
}

export interface AxSetValueScriptOptions extends AxElementQuery {
  attribute: string;
  value: string;
}

export interface AxPressScriptOptions extends AxElementQuery {
  actionName: string;
}

export interface AxScrollScriptOptions extends AxElementQuery {
  actionName: string;
}

export interface AxWindowsScriptOptions {
  appName?: string;
  bundleId?: string;
  processName?: string;
}

export function buildAxAppsScript(): string {
  return [
    `import AppKit`,
    `import Foundation`,
    ``,
    swiftEmitHelper(),
    `let commandMode = "apps"`,
    ``,
    `func appInfo(_ app: NSRunningApplication) -> [String: Any] {`,
    `  var out: [String: Any] = [:]`,
    `  out["name"] = app.localizedName ?? app.bundleIdentifier ?? String(app.processIdentifier)`,
    `  out["pid"] = Int(app.processIdentifier)`,
    `  out["active"] = app.isActive`,
    `  out["hidden"] = app.isHidden`,
    `  out["activationPolicy"] = app.activationPolicy.rawValue`,
    `  if let bundleId = app.bundleIdentifier { out["bundleId"] = bundleId }`,
    `  if let processName = app.executableURL?.deletingPathExtension().lastPathComponent { out["processName"] = processName }`,
    `  if let path = app.bundleURL?.path { out["bundlePath"] = path }`,
    `  if let path = app.executableURL?.path { out["executablePath"] = path }`,
    `  return out`,
    `}`,
    ``,
    `let apps = NSWorkspace.shared.runningApplications`,
    `  .filter { $0.activationPolicy == .regular }`,
    `  .map(appInfo)`,
    `  .sorted { String(describing: $0["name"] ?? "") < String(describing: $1["name"] ?? "") }`,
    `emit([`,
    `  "mode": commandMode,`,
    `  "count": apps.count,`,
    `  "apps": apps,`,
    `])`,
  ].join("\n");
}

export function buildAxWindowsScript(
  opts: AxWindowsScriptOptions = {},
): string {
  return [
    `import AppKit`,
    `import ApplicationServices`,
    `import CoreGraphics`,
    `import Foundation`,
    ``,
    swiftEmitHelper(),
    swiftAxHelpers(),
    swiftWindowIdentityHelpers(),
    `let commandMode = "windows"`,
    `let requestedAppName = ${swiftStringLiteral(opts.appName ?? "")}`,
    `let requestedBundleId = ${swiftStringLiteral(opts.bundleId ?? "")}`,
    `let requestedProcessName = ${swiftStringLiteral(opts.processName ?? "")}`,
    ``,
    `func appMatches(_ app: NSRunningApplication) -> Bool {`,
    `  if app.activationPolicy != .regular { return false }`,
    `  if requestedBundleId.isEmpty && requestedProcessName.isEmpty && requestedAppName.isEmpty { return true }`,
    `  if !requestedBundleId.isEmpty && app.bundleIdentifier == requestedBundleId { return true }`,
    `  if !requestedAppName.isEmpty && app.localizedName == requestedAppName { return true }`,
    `  if let executable = app.executableURL?.deletingPathExtension().lastPathComponent, !requestedProcessName.isEmpty && executable == requestedProcessName { return true }`,
    `  if let localized = app.localizedName, !requestedProcessName.isEmpty && localized == requestedProcessName { return true }`,
    `  return false`,
    `}`,
    ``,
    `func windowInfo(_ window: AXUIElement, app: NSRunningApplication, index: Int) -> [String: Any] {`,
    `  var out: [String: Any] = [:]`,
    `  out["app"] = app.localizedName ?? app.bundleIdentifier ?? String(app.processIdentifier)`,
    `  out["pid"] = Int(app.processIdentifier)`,
    `  out["index"] = index`,
    `  if let bundleId = app.bundleIdentifier { out["bundleId"] = bundleId }`,
    `  if let processName = app.executableURL?.deletingPathExtension().lastPathComponent { out["processName"] = processName }`,
    `  if let role = stringAttr(window, kAXRoleAttribute as String) { out["role"] = role }`,
    `  if let subrole = stringAttr(window, kAXSubroleAttribute as String) { out["subrole"] = subrole }`,
    `  if let title = stringAttr(window, kAXTitleAttribute as String) { out["title"] = title }`,
    `  if let focused = boolAttr(window, "AXFocused") ?? boolAttr(window, kAXMainAttribute as String) { out["focused"] = focused }`,
    `  if let minimized = boolAttr(window, kAXMinimizedAttribute as String) { out["minimized"] = minimized }`,
    `  if let bounds = elementBounds(window) {`,
    `    out["bounds"] = ["x": Double(bounds.origin.x), "y": Double(bounds.origin.y), "w": Double(bounds.size.width), "h": Double(bounds.size.height)]`,
    `  }`,
    `  if let windowId = exactWindowId(window, pid: app.processIdentifier) { out["windowId"] = windowId }`,
    `  return out`,
    `}`,
    ``,
    `var windows: [[String: Any]] = []`,
    `for app in NSWorkspace.shared.runningApplications.filter(appMatches) {`,
    `  let axApp = AXUIElementCreateApplication(app.processIdentifier)`,
    `  let appWindows = targetWindows(in: axApp)`,
    `  for (index, window) in appWindows.enumerated() {`,
    `    windows.append(windowInfo(window, app: app, index: index))`,
    `  }`,
    `}`,
    `emit([`,
    `  "mode": commandMode,`,
    `  "trusted": AXIsProcessTrusted(),`,
    `  "count": windows.count,`,
    `  "windows": windows,`,
    `])`,
  ].join("\n");
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
    `import CoreGraphics`,
    `import CoreFoundation`,
    `import Foundation`,
    ``,
    ...buildRunningAppPrelude(target, 0),
    swiftEmitHelper(),
    swiftAxHelpers(),
    swiftWindowIdentityHelpers(),
    `let commandMode = "snapshot"`,
    `let snapshotScope = ${swiftStringLiteral(opts.scope)}`,
    `let snapshotMaxDepth = ${normalizeInt(opts.maxDepth, 3)}`,
    `let snapshotWindowId = ${String(opts.windowId ?? 0)}`,
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
    `let selectedWindow: AXUIElement?`,
    `if snapshotWindowId > 0 {`,
    `  let appWindows = targetWindows(in: axApp)`,
    `  let matches = appWindows.filter { exactWindowId($0, pid: running.processIdentifier) == snapshotWindowId }`,
    `  guard matches.count == 1 else {`,
    `    emit([`,
    `      "found": true,`,
    `      "matched": false,`,
    `      "mode": commandMode,`,
    `      "scope": snapshotScope,`,
    `      "windowId": snapshotWindowId,`,
    `      "failure": matches.isEmpty ? "window_not_found" : "window_ambiguous",`,
    `    ])`,
    `    exit(0)`,
    `  }`,
    `  selectedWindow = matches[0]`,
    `} else {`,
    `  selectedWindow = focusedWindow(in: axApp)`,
    `}`,
    `let root = snapshotScope == "focusedElement"`,
    `  ? selectedWindow.flatMap { axElement(attr($0, kAXFocusedUIElementAttribute as String)) } ?? focusedElement(in: axApp) ?? selectedWindow ?? axApp`,
    `  : selectedWindow ?? focusedElement(in: axApp) ?? axApp`,
    `var describedRoot = describe(root, depth: 0, maxDepth: snapshotMaxDepth)`,
    `describedRoot["pid"] = Int(running.processIdentifier)`,
    `if let selectedWindow, let windowId = exactWindowId(selectedWindow, pid: running.processIdentifier) {`,
    `  describedRoot["windowId"] = windowId`,
    `  describedRoot["scope"] = "window-\\(windowId)"`,
    `} else {`,
    `  describedRoot["scope"] = snapshotScope`,
    `}`,
    `emit([`,
    `  "found": true,`,
    `  "matched": true,`,
    `  "mode": commandMode,`,
    `  "scope": snapshotScope,`,
    `  "bundleId": running.bundleIdentifier ?? bundleId,`,
    `  "localizedName": running.localizedName ?? processName,`,
    `  "element": describedRoot,`,
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

export function buildAxScrollScript(
  target: ResolvedAxTarget,
  opts: AxScrollScriptOptions,
): string {
  return buildAxElementCommandScript(target, "scroll", opts);
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

function swiftIntArray(values: readonly number[]): string {
  return `[${values.map((value) => String(value)).join(", ")}]`;
}

function swiftStringSet(values: readonly string[]): string {
  return `Set<String>(${swiftStringArray(values)})`;
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
    windowId: readAxWindowId(params.windowId),
    path: readAxStablePath(params.stable),
    roles: readStringList(params.role),
    subroles: readStringList(params.subrole),
    names: readStringList(params.name),
    titles:
      readStringList(params.name).length > 0
        ? []
        : readStringList(params.title),
    descriptions: readStringList(params.description),
    identifiers: readStringList(params.identifier),
    namePrefix:
      typeof params.namePrefix === "boolean" ? params.namePrefix : false,
    titlePrefix:
      typeof params.titlePrefix === "boolean" ? params.titlePrefix : false,
    descriptionPrefix:
      typeof params.descriptionPrefix === "boolean"
        ? params.descriptionPrefix
        : false,
  };
}

export function readAxStablePath(value: unknown): readonly AxPathSegment[] {
  if (typeof value !== "string" || !value.startsWith("desktop-ax:")) {
    return [];
  }
  const scopeEnd = value.indexOf(":", "desktop-ax:".length);
  if (scopeEnd < 0 || scopeEnd === value.length - 1) return [];
  const segments: AxPathSegment[] = [];
  for (const raw of value.slice(scopeEnd + 1).split("/")) {
    const match = /^(.+)\[(\d+)\]$/.exec(raw);
    if (!match?.[1] || match[2] === undefined) return [];
    const index = Number(match[2]);
    if (!Number.isSafeInteger(index) || index < 0) return [];
    segments.push({ role: match[1], index });
    if (segments.length > 128) return [];
  }
  return segments;
}

export function hasAxElementMatcher(params: Record<string, unknown>): boolean {
  return (
    readStringList(params.role).length > 0 ||
    readStringList(params.subrole).length > 0 ||
    readStringList(params.name).length > 0 ||
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

export function readAxWindowId(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : undefined;
  return typeof parsed === "number" &&
    Number.isSafeInteger(parsed) &&
    parsed >= 1 &&
    parsed <= 0xffff_ffff
    ? parsed
    : undefined;
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
  mode: "focused_read" | "set_value" | "press" | "scroll",
  opts:
    | AxElementQuery
    | AxSetValueScriptOptions
    | AxPressScriptOptions
    | AxScrollScriptOptions,
): string {
  const path = opts.path ?? [];
  const setValue = "value" in opts ? opts.value : "";
  const attribute = "attribute" in opts ? opts.attribute : "AXValue";
  const actionName = "actionName" in opts ? opts.actionName : "AXPress";

  return [
    `import AppKit`,
    `import ApplicationServices`,
    `import CoreGraphics`,
    `import CoreFoundation`,
    `import Foundation`,
    ``,
    ...buildRunningAppPrelude(target, 0),
    swiftEmitHelper(),
    swiftAxHelpers(),
    swiftWindowIdentityHelpers(),
    `let commandMode = ${swiftStringLiteral(mode)}`,
    `let queryFocused = ${opts.focused ? "true" : "false"}`,
    `let queryMaxDepth = ${normalizeInt(opts.maxDepth, 8)}`,
    `let queryWindowId = ${String(opts.windowId ?? 0)}`,
    `let queryPathRoles: [String] = ${swiftStringArray(path.map((segment) => segment.role))}`,
    `let queryPathIndices: [Int] = ${swiftIntArray(path.map((segment) => segment.index))}`,
    `let queryRoles = ${swiftStringSet(opts.roles)}`,
    `let querySubroles = ${swiftStringSet(opts.subroles)}`,
    `let queryNames = ${swiftStringSet(opts.names)}`,
    `let queryTitles = ${swiftStringSet(opts.titles)}`,
    `let queryDescriptions = ${swiftStringSet(opts.descriptions)}`,
    `let queryIdentifiers = ${swiftStringSet(opts.identifiers)}`,
    `let queryNamePrefix = ${opts.namePrefix ? "true" : "false"}`,
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
    `func matchesAnyValue(_ values: [String?], _ candidates: Set<String>, prefix: Bool = false) -> Bool {`,
    `  if candidates.isEmpty { return true }`,
    `  return values.contains { matchesValue($0, candidates, prefix: prefix) }`,
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
    `    && matchesAnyValue([title, description, identifier], queryNames, prefix: queryNamePrefix)`,
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
    `func selectedWindow(in app: AXUIElement) -> AXUIElement? {`,
    `  if queryWindowId <= 0 { return focusedWindow(in: app) }`,
    `  let appWindows = targetWindows(in: app)`,
    `  let matches = appWindows.filter { exactWindowId($0, pid: running!.processIdentifier) == queryWindowId }`,
    `  return matches.count == 1 ? matches[0] : nil`,
    `}`,
    ``,
    `func elementAtQueryPath(_ root: AXUIElement) -> AXUIElement? {`,
    `  guard queryPathRoles.count == queryPathIndices.count, !queryPathRoles.isEmpty else { return nil }`,
    `  var current = root`,
    `  var offset = 0`,
    `  if stringAttr(current, kAXRoleAttribute as String) == queryPathRoles[0] && queryPathIndices[0] == 0 { offset = 1 }`,
    `  for position in offset..<queryPathRoles.count {`,
    `    let role = queryPathRoles[position]`,
    `    let index = queryPathIndices[position]`,
    `    let matches = children(current).filter { stringAttr($0, kAXRoleAttribute as String) == role }`,
    `    guard index >= 0 && index < matches.count else { return nil }`,
    `    current = matches[index]`,
    `  }`,
    `  return current`,
    `}`,
    ``,
    `func selectElement(in app: AXUIElement) -> AXUIElement? {`,
    `  let focused = focusedElement(in: app)`,
    `  let window = selectedWindow(in: app)`,
    `  if queryWindowId > 0 && window == nil { return nil }`,
    `  if !queryPathRoles.isEmpty {`,
    `    guard let window, let exact = elementAtQueryPath(window), matchesQuery(exact) else { return nil }`,
    `    return exact`,
    `  }`,
    `  let hasQuery = !queryRoles.isEmpty || !querySubroles.isEmpty || !queryNames.isEmpty || !queryTitles.isEmpty || !queryDescriptions.isEmpty || !queryIdentifiers.isEmpty`,
    `  if !hasQuery {`,
    `    return focused ?? window`,
    `  }`,
    `  if queryFocused, let focused, matchesQuery(focused) {`,
    `    return focused`,
    `  }`,
    `  if queryFocused { return nil }`,
    `  if let window, let found = findMatching(window) {`,
    `    return found`,
    `  }`,
    `  if queryWindowId > 0 { return nil }`,
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
    `let exactWindowMatches = queryWindowId > 0`,
    `  ? targetWindows(in: axApp).filter { exactWindowId($0, pid: running.processIdentifier) == queryWindowId }`,
    `  : []`,
    `guard let element = selectElement(in: axApp) else {`,
    `  let failure = queryWindowId > 0 && exactWindowMatches.count != 1`,
    `    ? (exactWindowMatches.isEmpty ? "window_not_found" : "window_ambiguous")`,
    `    : (!queryPathRoles.isEmpty ? "stale_path" : "element_not_found")`,
    `  emit([`,
    `    "found": true,`,
    `    "matched": false,`,
    `    "mode": commandMode,`,
    `    "bundleId": running.bundleIdentifier ?? bundleId,`,
    `    "localizedName": running.localizedName ?? processName,`,
    `    "failure": failure,`,
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
    `case "scroll":`,
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
    `func checkedAttr(_ el: AXUIElement) -> Bool? {`,
    `  let role = stringAttr(el, kAXRoleAttribute as String) ?? ""`,
    `  if role == kAXCheckBoxRole as String || role == kAXRadioButtonRole as String || role == "AXSwitch" {`,
    `    if let value = attr(el, kAXValueAttribute as String) as? NSNumber { return value.intValue != 0 }`,
    `    if let selected = boolAttr(el, kAXSelectedAttribute as String) { return selected }`,
    `  }`,
    `  if role == kAXMenuItemRole as String {`,
    `    if let mark = stringAttr(el, "AXMenuItemMarkChar") { return !mark.isEmpty }`,
    `    if let selected = boolAttr(el, kAXSelectedAttribute as String) { return selected }`,
    `  }`,
    `  return nil`,
    `}`,
    ``,
    `func pointAttr(_ el: AXUIElement, _ name: String) -> CGPoint? {`,
    `  guard let raw = attr(el, name) else { return nil }`,
    `  let value = raw as CFTypeRef`,
    `  guard CFGetTypeID(value) == AXValueGetTypeID() else { return nil }`,
    `  let axValue = raw as! AXValue`,
    `  guard AXValueGetType(axValue) == .cgPoint else { return nil }`,
    `  var point = CGPoint.zero`,
    `  guard AXValueGetValue(axValue, .cgPoint, &point) else { return nil }`,
    `  return point`,
    `}`,
    ``,
    `func sizeAttr(_ el: AXUIElement, _ name: String) -> CGSize? {`,
    `  guard let raw = attr(el, name) else { return nil }`,
    `  let value = raw as CFTypeRef`,
    `  guard CFGetTypeID(value) == AXValueGetTypeID() else { return nil }`,
    `  let axValue = raw as! AXValue`,
    `  guard AXValueGetType(axValue) == .cgSize else { return nil }`,
    `  var size = CGSize.zero`,
    `  guard AXValueGetValue(axValue, .cgSize, &size) else { return nil }`,
    `  return size`,
    `}`,
    ``,
    `func elementBounds(_ el: AXUIElement) -> CGRect? {`,
    `  guard let position = pointAttr(el, kAXPositionAttribute as String),`,
    `        let size = sizeAttr(el, kAXSizeAttribute as String) else { return nil }`,
    `  return CGRect(origin: position, size: size)`,
    `}`,
    ``,
    `func screenIndex(for rect: CGRect) -> Int? {`,
    `  let screens = NSScreen.screens`,
    `  guard !screens.isEmpty else { return nil }`,
    `  let center = CGPoint(x: rect.midX, y: rect.midY)`,
    `  for (index, screen) in screens.enumerated() {`,
    `    if screen.frame.contains(center) { return index }`,
    `  }`,
    `  var bestIndex = 0`,
    `  var bestDistance = Double.greatestFiniteMagnitude`,
    `  for (index, screen) in screens.enumerated() {`,
    `    let frame = screen.frame`,
    `    let dx = max(frame.minX - center.x, 0, center.x - frame.maxX)`,
    `    let dy = max(frame.minY - center.y, 0, center.y - frame.maxY)`,
    `    let distance = Double(dx * dx + dy * dy)`,
    `    if distance < bestDistance {`,
    `      bestDistance = distance`,
    `      bestIndex = index`,
    `    }`,
    `  }`,
    `  return bestIndex`,
    `}`,
    ``,
    `func children(_ el: AXUIElement) -> [AXUIElement] {`,
    `  (attr(el, kAXChildrenAttribute as String) as? [AnyObject] ?? []).compactMap { axElement($0) }`,
    `}`,
    ``,
    `func axElement(_ raw: AnyObject?) -> AXUIElement? {`,
    `  guard let raw else { return nil }`,
    `  let value = raw as CFTypeRef`,
    `  guard CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }`,
    `  return (raw as! AXUIElement)`,
    `}`,
    ``,
    `func actionNames(_ el: AXUIElement) -> [String] {`,
    `  var raw: CFArray?`,
    `  guard AXUIElementCopyActionNames(el, &raw) == .success else { return [] }`,
    `  return raw as? [String] ?? []`,
    `}`,
    ``,
    `func focusedWindow(in app: AXUIElement) -> AXUIElement? {`,
    `  return axElement(attr(app, kAXFocusedWindowAttribute as String))`,
    `}`,
    ``,
    `func targetWindows(in app: AXUIElement) -> [AXUIElement] {`,
    `  var windows = (attr(app, kAXWindowsAttribute as String) as? [AnyObject] ?? []).compactMap { axElement($0) }`,
    `  if let focused = focusedWindow(in: app), !windows.contains(where: { CFEqual($0, focused) }) {`,
    `    windows.append(focused)`,
    `  }`,
    `  return windows`,
    `}`,
    ``,
    `func focusedElement(in app: AXUIElement) -> AXUIElement? {`,
    `  if let focused = axElement(attr(app, kAXFocusedUIElementAttribute as String)) { return focused }`,
    `  if let window = focusedWindow(in: app), let focused = axElement(attr(window, kAXFocusedUIElementAttribute as String)) {`,
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
    `  if let focused = boolAttr(el, kAXFocusedAttribute as String) { out["focused"] = focused }`,
    `  if let checked = checkedAttr(el) { out["checked"] = checked }`,
    `  if let minimized = boolAttr(el, kAXMinimizedAttribute as String) { out["minimized"] = minimized }`,
    `  if let rect = elementBounds(el) {`,
    `    out["bounds"] = [`,
    `      "x": Double(rect.origin.x),`,
    `      "y": Double(rect.origin.y),`,
    `      "w": Double(rect.size.width),`,
    `      "h": Double(rect.size.height),`,
    `    ]`,
    `    if let index = screenIndex(for: rect) { out["screenIndex"] = index }`,
    `  }`,
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

function swiftWindowIdentityHelpers(): string {
  return [
    `func boundsMatch(_ lhs: CGRect, _ rhs: CGRect) -> Bool {`,
    `  let tolerance: CGFloat = 2`,
    `  return abs(lhs.origin.x - rhs.origin.x) <= tolerance`,
    `    && abs(lhs.origin.y - rhs.origin.y) <= tolerance`,
    `    && abs(lhs.size.width - rhs.size.width) <= tolerance`,
    `    && abs(lhs.size.height - rhs.size.height) <= tolerance`,
    `}`,
    ``,
    `func windowNumber(_ info: [String: Any]) -> Int? {`,
    `  return (info[kCGWindowNumber as String] as? NSNumber)?.intValue`,
    `}`,
    ``,
    `func windowBounds(_ info: [String: Any]) -> CGRect? {`,
    `  guard let rawBounds = info[kCGWindowBounds as String] as? NSDictionary else { return nil }`,
    `  var bounds = CGRect.zero`,
    `  return CGRectMakeWithDictionaryRepresentation(rawBounds, &bounds) ? bounds : nil`,
    `}`,
    ``,
    `func windowIsOnscreen(_ info: [String: Any]) -> Bool? {`,
    `  return (info[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue`,
    `}`,
    ``,
    `func exactWindowId(_ window: AXUIElement, pid: pid_t) -> Int? {`,
    `  guard let targetBounds = elementBounds(window) else { return nil }`,
    `  let targetTitle = stringAttr(window, kAXTitleAttribute as String) ?? ""`,
    `  guard let infos = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }`,
    `  let owned = infos.filter { info in`,
    `    guard let ownerPid = info[kCGWindowOwnerPID as String] as? NSNumber, ownerPid.int32Value == pid else { return false }`,
    `    guard let layer = info[kCGWindowLayer as String] as? NSNumber, layer.intValue == 0 else { return false }`,
    `    return windowNumber(info) != nil`,
    `  }`,
    `  let minimized = boolAttr(window, kAXMinimizedAttribute as String) ?? false`,
    `  if !targetTitle.isEmpty {`,
    `    let titled = owned.filter { ($0[kCGWindowName as String] as? String) == targetTitle }`,
    `    let titledBounds = titled.filter { info in`,
    `      guard let candidateBounds = windowBounds(info) else { return false }`,
    `      guard boundsMatch(targetBounds, candidateBounds) else { return false }`,
    `      guard let isOnscreen = windowIsOnscreen(info) else { return false }`,
    `      return minimized ? !isOnscreen : isOnscreen`,
    `    }`,
    `    if titledBounds.count == 1 { return windowNumber(titledBounds[0]) }`,
    `  }`,
    `  let exactVisibleBounds = owned.filter { info in`,
    `    guard let candidateBounds = windowBounds(info), boundsMatch(targetBounds, candidateBounds) else { return false }`,
    `    guard let isOnscreen = windowIsOnscreen(info) else { return false }`,
    `    return minimized ? !isOnscreen : isOnscreen`,
    `  }`,
    `  return exactVisibleBounds.count == 1 ? windowNumber(exactVisibleBounds[0]) : nil`,
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
