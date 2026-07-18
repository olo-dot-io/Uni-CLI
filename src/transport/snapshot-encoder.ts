/**
 * @owner       src::transport::snapshot-encoder
 * @does        Encode native accessibility trees and allocate deterministic action refs for every public snapshot format.
 * @needs       transport ref allocator
 * @feeds       desktop AX, UIA, and AT-SPI snapshots plus persisted compute refs
 * @breaks      A snapshot that renders fresh state but retains old refs makes the next action target stale geometry or fail as expired.
 * @invariants  Compact, tree, and JSON formats allocate the same traversal refs; output encoding never changes ref identity, exact native window, CDP endpoint, or scope.
 * @side-effects Mutates only the caller-owned ref allocator.
 * @perf        One bounded tree traversal per snapshot.
 * @concurrency Safe when each snapshot owns its allocator.
 * @test        tests/unit/snapshot-encoder.test.ts and desktop adapter snapshot tests
 * @stability   stable
 * @since       2026-05-04
 */

import type { ElementRef, RefAllocator } from "./refs.js";
import type { CdpEndpoint } from "./cdp-endpoint.js";

export type SnapshotEncoding = "compact" | "tree" | "json";

export interface RawAxNode {
  role: string;
  name?: string;
  value?: string;
  bounds?: { x: number; y: number; w: number; h: number };
  screenIndex?: number;
  states?: readonly string[];
  children?: RawAxNode[];
  path: string;
  scope: string;
  app?: string;
  pid?: number;
  windowId?: number | string;
}

export interface EncodeOpts {
  format?: SnapshotEncoding;
  interactiveOnly?: boolean;
  namedOnly?: boolean;
  maxDepth?: number;
  includeBounds?: boolean;
  transport: string;
  alloc: RefAllocator;
  cdpEndpoint?: CdpEndpoint;
}

export function encodeSnapshot(
  root: RawAxNode,
  opts: EncodeOpts,
): { encoded: string; refCount: number } {
  const format = opts.format ?? "compact";
  const lines: string[] = [];
  walk(root, opts, lines, 0, opts.cdpEndpoint);
  return {
    encoded: format === "json" ? JSON.stringify(root) : lines.join("\n"),
    refCount: opts.alloc.size,
  };
}

function walk(
  node: RawAxNode,
  opts: EncodeOpts,
  lines: string[],
  depth: number,
  inheritedCdpEndpoint?: CdpEndpoint,
): void {
  const maxDepth = opts.maxDepth ?? 64;
  if (depth > maxDepth) return;

  const format = opts.format ?? "compact";
  const namedOnly = opts.namedOnly ?? format === "compact";
  const interactive = isInteractive(node);
  const named = Boolean(node.name);
  const include =
    (!opts.interactiveOnly || interactive) &&
    (!namedOnly || named || depth === 0);
  const cdpEndpoint = inheritedCdpEndpoint;

  if (include) {
    const ref = opts.alloc.alloc({
      stable: `${opts.transport}:${node.scope}:${node.path}`,
      role: node.role,
      name: node.name,
      value: node.value,
      bounds: node.bounds,
      screenIndex: node.screenIndex,
      states: node.states,
      app: node.app,
      pid: node.pid,
      windowId: node.windowId,
      cdpEndpoint,
    });
    lines.push(
      formatLine(ref, {
        format,
        depth,
        includeBounds: opts.includeBounds ?? true,
        includeName: opts.interactiveOnly !== true,
      }),
    );
  }

  for (const child of node.children ?? []) {
    walk(child, opts, lines, depth + 1, cdpEndpoint);
  }
}

function formatLine(
  ref: ElementRef,
  opts: {
    format: SnapshotEncoding;
    depth: number;
    includeBounds: boolean;
    includeName: boolean;
  },
): string {
  const { format, depth, includeBounds, includeName } = opts;
  const pad = format === "tree" ? "  ".repeat(depth) : "";
  const role = simplifyRole(ref.role);
  const name = includeName && ref.name ? ` "${escapeQuotes(ref.name)}"` : "";
  const value =
    includeName && ref.value ? ` value="${escapeQuotes(ref.value)}"` : "";
  const bounds =
    includeBounds && ref.bounds
      ? ` ${ref.bounds.w}x${ref.bounds.h}@${ref.bounds.x},${ref.bounds.y}`
      : "";
  const states =
    ref.states && ref.states.length > 0 ? ` {${ref.states.join(",")}}` : "";
  const screen =
    typeof ref.screenIndex === "number" && Number.isFinite(ref.screenIndex)
      ? ` screen=${Math.trunc(ref.screenIndex)}`
      : "";
  const app = ref.app ? ` app=${ref.app}` : "";
  return `${pad}${ref.alias} ${role}${name}${value}${bounds}${screen}${states}${app}`;
}

const ROLE_SIMPLIFY: Record<string, string> = {
  AXButton: "button",
  AXTextField: "input",
  AXTextArea: "textarea",
  AXStaticText: "text",
  AXMenuItem: "menuitem",
  AXCheckBox: "checkbox",
  AXRadioButton: "radio",
  AXLink: "link",
  AXImage: "image",
  AXWindow: "window",
  AXGroup: "group",
  AXList: "list",
  Button: "button",
  Edit: "input",
  Text: "text",
  MenuItem: "menuitem",
  CheckBox: "checkbox",
  RadioButton: "radio",
  Hyperlink: "link",
  Image: "image",
  Window: "window",
  push_button: "button",
  text: "input",
  label: "text",
  menu_item: "menuitem",
  check_box: "checkbox",
  radio_button: "radio",
  link: "link",
  image: "image",
  frame: "window",
};

function simplifyRole(role: string): string {
  return ROLE_SIMPLIFY[role] ?? role.toLowerCase();
}

const INTERACTIVE_ROLES = new Set([
  "AXButton",
  "AXTextField",
  "AXTextArea",
  "AXMenuItem",
  "AXCheckBox",
  "AXRadioButton",
  "AXLink",
  "AXPopUpButton",
  "AXSlider",
  "AXIncrementor",
  "Button",
  "Edit",
  "MenuItem",
  "CheckBox",
  "RadioButton",
  "Hyperlink",
  "ComboBox",
  "Slider",
  "Spinner",
  "Tab",
  "TabItem",
  "TreeItem",
  "ListItem",
  "push_button",
  "text",
  "menu_item",
  "check_box",
  "radio_button",
  "link",
  "combo_box",
  "slider",
  "spin_button",
  "tab",
  "tree_item",
  "list_item",
]);

function isInteractive(node: RawAxNode): boolean {
  if (INTERACTIVE_ROLES.has(node.role)) return true;
  return (node.states ?? []).some(
    (state) =>
      state === "focusable" || state === "editable" || state === "clickable",
  );
}

function escapeQuotes(value: string): string {
  return value.replace(/"/g, '\\"');
}
