/**
 * Step → transport capability matrix.
 *
 * Single source of truth for which transports can execute each pipeline
 * step, per `.claude/plans/sessions/2026-04-14-v212-rethink/round4/02-operate-anything-arch.md`
 * §3 (46 steps × 7 transports).
 *
 * Legend from round4/02:
 *   ●  native
 *   ○  emulated via delegate (still legal — appears in `transports`)
 *   –  unsupported (absent from `transports`)
 *   ◐  OS-gated (appears in `transports` AND `platforms`)
 *
 * The YAML runner uses {@link stepSupportedBy} at parse time to route a
 * step to the right transport; {@link stepPlatform} is consulted when the
 * step is platform-exclusive.
 */

import type { TransportKind } from "./types.js";

/** Canonical ordering for the 7 transports; stable across releases. */
export const TRANSPORT_KINDS: readonly TransportKind[] = [
  "http",
  "cdp-browser",
  "subprocess",
  "desktop-ax",
  "desktop-uia",
  "desktop-atspi",
  "cua",
] as const;

/** One row in the matrix. */
export interface CapabilityRow {
  readonly transports: readonly TransportKind[];
  /** Platform gate, if any. Undefined = any host OS. */
  readonly platforms?: readonly ("darwin" | "win32" | "linux")[];
}

/**
 * The step matrix. Keep row ordering loose; tests assert membership
 * semantically.
 */
export const CAPABILITY_MATRIX: Readonly<Record<string, CapabilityRow>> = {
  // --- API / content steps ---
  fetch: { transports: ["http"] },
  fetch_text: { transports: ["http"] },
  parse_rss: { transports: ["http"] },
  html_to_md: { transports: ["http", "cdp-browser"] },

  // --- Transform steps (cross-transport, orchestrator-level) ---
  select: { transports: [...TRANSPORT_KINDS] },
  map: { transports: [...TRANSPORT_KINDS] },
  filter: { transports: [...TRANSPORT_KINDS] },
  sort: { transports: [...TRANSPORT_KINDS] },
  limit: { transports: [...TRANSPORT_KINDS] },

  // --- Subprocess ---
  exec: { transports: ["subprocess"] },
  write_temp: { transports: ["subprocess"] },

  // --- Browser / GUI action steps ---
  navigate: {
    transports: ["cdp-browser"],
  },
  evaluate: { transports: ["cdp-browser"] },
  click: {
    transports: ["cdp-browser"],
  },
  type: {
    transports: ["cdp-browser"],
  },
  press: {
    transports: ["cdp-browser"],
  },
  scroll: {
    transports: ["cdp-browser"],
  },
  wait: {
    transports: ["cdp-browser", "subprocess"],
  },
  intercept: { transports: ["cdp-browser"] },
  snapshot: {
    transports: ["cdp-browser"],
  },
  screenshot: {
    transports: ["cdp-browser"],
  },
  tap: { transports: ["cdp-browser"] },
  download: { transports: ["http", "cdp-browser", "subprocess"] },
  websocket: { transports: ["http"] },

  // --- Control flow (cross-transport) ---
  set: { transports: [...TRANSPORT_KINDS] },
  if: { transports: [...TRANSPORT_KINDS] },
  append: { transports: [...TRANSPORT_KINDS] },
  each: { transports: [...TRANSPORT_KINDS] },
  parallel: { transports: [...TRANSPORT_KINDS] },
  rate_limit: { transports: [...TRANSPORT_KINDS] },
  assert: { transports: [...TRANSPORT_KINDS] },
  extract: {
    transports: ["cdp-browser"],
  },
  retry: { transports: [...TRANSPORT_KINDS] },

  // --- CUA family (screenshot + VLM coord action) ---
  cua_snapshot: { transports: ["cua"] },
  cua_click: {
    transports: ["cua"],
  },
  cua_type: {
    transports: ["cua"],
  },
  cua_key: {
    transports: ["cua"],
  },
  cua_scroll: {
    transports: ["cua"],
  },
  cua_drag: {
    transports: ["cua"],
  },
  cua_wait: {
    transports: ["cua"],
  },
  cua_assert: {
    transports: ["cua"],
  },
  cua_ask: { transports: ["cua"] },
  cua_backend: { transports: ["cua"] },
  cua_launch: { transports: ["cua"] },

  // --- Unified compute family (AX/UIA/AT-SPI/CDP/CUA cascade) ---
  compute_apps: {
    transports: ["desktop-ax", "desktop-uia", "desktop-atspi", "subprocess"],
  },
  compute_windows: {
    transports: ["desktop-ax", "desktop-uia", "desktop-atspi", "cdp-browser"],
  },
  compute_snapshot: {
    transports: [
      "desktop-ax",
      "desktop-uia",
      "desktop-atspi",
      "cdp-browser",
      "cua",
    ],
  },
  compute_find: {
    transports: [
      "desktop-ax",
      "desktop-uia",
      "desktop-atspi",
      "cdp-browser",
      "cua",
    ],
  },
  compute_click: {
    transports: [
      "desktop-ax",
      "cdp-browser",
      "desktop-uia",
      "desktop-atspi",
      "cua",
    ],
  },
  compute_type: {
    transports: [
      "desktop-ax",
      "cdp-browser",
      "desktop-uia",
      "desktop-atspi",
      "cua",
    ],
  },
  compute_press: {
    transports: [
      "desktop-ax",
      "cdp-browser",
      "desktop-uia",
      "desktop-atspi",
      "cua",
    ],
  },
  compute_scroll: {
    transports: [
      "desktop-ax",
      "cdp-browser",
      "desktop-uia",
      "desktop-atspi",
      "cua",
    ],
  },
  compute_launch: {
    transports: ["subprocess", "desktop-ax", "desktop-uia", "desktop-atspi"],
  },
  compute_screenshot: {
    transports: [
      "cdp-browser",
      "desktop-ax",
      "desktop-uia",
      "desktop-atspi",
      "cua",
    ],
  },
  compute_cdp_attach: { transports: ["cdp-browser"] },
  compute_evaluate: { transports: ["cdp-browser"] },
  compute_wait: {
    transports: [
      "desktop-ax",
      "cdp-browser",
      "desktop-uia",
      "desktop-atspi",
      "cua",
      "subprocess",
    ],
  },
  compute_observe: {
    transports: ["desktop-ax", "desktop-uia", "desktop-atspi", "cdp-browser"],
  },
  compute_assert: {
    transports: [
      "desktop-ax",
      "cdp-browser",
      "desktop-uia",
      "desktop-atspi",
      "cua",
      "subprocess",
    ],
  },

  // --- Platform-exclusive OS steps ---
  ax_focus: { transports: ["desktop-ax"], platforms: ["darwin"] },
  ax_menu_select: { transports: ["desktop-ax"], platforms: ["darwin"] },
  applescript: { transports: ["desktop-ax"], platforms: ["darwin"] },
  ax_apps: { transports: ["desktop-ax"], platforms: ["darwin"] },
  ax_windows: { transports: ["desktop-ax"], platforms: ["darwin"] },
  ax_snapshot: { transports: ["desktop-ax"], platforms: ["darwin"] },
  ax_focused_read: { transports: ["desktop-ax"], platforms: ["darwin"] },
  ax_set_value: { transports: ["desktop-ax"], platforms: ["darwin"] },
  ax_press: { transports: ["desktop-ax"], platforms: ["darwin"] },
  ax_scroll: { transports: ["desktop-ax"], platforms: ["darwin"] },
  ax_screenshot: { transports: ["desktop-ax"], platforms: ["darwin"] },
  ax_background_click: { transports: ["desktop-ax"], platforms: ["darwin"] },
  uia_apps: { transports: ["desktop-uia"], platforms: ["win32"] },
  uia_windows: { transports: ["desktop-uia"], platforms: ["win32"] },
  uia_snapshot: { transports: ["desktop-uia"], platforms: ["win32"] },
  uia_find: { transports: ["desktop-uia"], platforms: ["win32"] },
  uia_invoke: { transports: ["desktop-uia"], platforms: ["win32"] },
  uia_set_value: { transports: ["desktop-uia"], platforms: ["win32"] },
  uia_focus: { transports: ["desktop-uia"], platforms: ["win32"] },
  uia_press: { transports: ["desktop-uia"], platforms: ["win32"] },
  uia_scroll: { transports: ["desktop-uia"], platforms: ["win32"] },
  uia_screenshot: { transports: ["desktop-uia"], platforms: ["win32"] },
  uia_wait: { transports: ["desktop-uia"], platforms: ["win32"] },
  uia_observe: { transports: ["desktop-uia"], platforms: ["win32"] },
  uia_assert: { transports: ["desktop-uia"], platforms: ["win32"] },
  atspi_apps: { transports: ["desktop-atspi"], platforms: ["linux"] },
  atspi_windows: { transports: ["desktop-atspi"], platforms: ["linux"] },
  atspi_snapshot: { transports: ["desktop-atspi"], platforms: ["linux"] },
  atspi_find: { transports: ["desktop-atspi"], platforms: ["linux"] },
  atspi_invoke: { transports: ["desktop-atspi"], platforms: ["linux"] },
  atspi_set_value: { transports: ["desktop-atspi"], platforms: ["linux"] },
  atspi_focus: { transports: ["desktop-atspi"], platforms: ["linux"] },
  atspi_press: { transports: ["desktop-atspi"], platforms: ["linux"] },
  atspi_scroll: { transports: ["desktop-atspi"], platforms: ["linux"] },
  atspi_screenshot: { transports: ["desktop-atspi"], platforms: ["linux"] },
  atspi_wait: { transports: ["desktop-atspi"], platforms: ["linux"] },
  atspi_observe: { transports: ["desktop-atspi"], platforms: ["linux"] },
  atspi_assert: { transports: ["desktop-atspi"], platforms: ["linux"] },

  // --- Clipboard / app lifecycle (cross-transport where possible) ---
  // Naming note: handlers and adapters use `clipboard_read` / `clipboard_write`
  // throughout. The matrix keys must match the handler keys verbatim —
  // `bus.require("clipboard_read")` looks up by name, so a `clipboard_get`
  // alias here would 404 at runtime.
  clipboard_read: {
    transports: ["desktop-ax"],
  },
  clipboard_write: {
    transports: ["desktop-ax"],
  },
  launch_app: {
    transports: ["subprocess", "desktop-ax", "desktop-uia", "desktop-atspi"],
  },
  focus_window: {
    transports: ["desktop-ax"],
  },
};

/** Step names this transport can execute on the given host platform. */
export function stepSupportedBy(step: string): readonly TransportKind[] {
  const row = CAPABILITY_MATRIX[step];
  return row ? row.transports : [];
}

/** Platform gate for a step; undefined means any OS. */
export function stepPlatform(
  step: string,
): readonly ("darwin" | "win32" | "linux")[] | undefined {
  const row = CAPABILITY_MATRIX[step];
  return row?.platforms;
}

/** Count of distinct steps in the matrix. */
export function stepCount(): number {
  return Object.keys(CAPABILITY_MATRIX).length;
}
