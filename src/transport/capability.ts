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
    transports: ["cdp-browser", "desktop-ax", "desktop-uia", "desktop-atspi"],
  },
  evaluate: { transports: ["cdp-browser"] },
  click: {
    transports: [
      "cdp-browser",
      "desktop-ax",
      "desktop-uia",
      "desktop-atspi",
      "cua",
    ],
  },
  type: {
    transports: [
      "cdp-browser",
      "desktop-ax",
      "desktop-uia",
      "desktop-atspi",
      "cua",
    ],
  },
  press: {
    transports: [
      "cdp-browser",
      "desktop-ax",
      "desktop-uia",
      "desktop-atspi",
      "cua",
    ],
  },
  scroll: {
    transports: [
      "cdp-browser",
      "desktop-ax",
      "desktop-uia",
      "desktop-atspi",
      "cua",
    ],
  },
  wait: {
    transports: [
      "cdp-browser",
      "subprocess",
      "desktop-ax",
      "desktop-uia",
      "desktop-atspi",
      "cua",
    ],
  },
  intercept: { transports: ["cdp-browser"] },
  snapshot: {
    transports: [
      "cdp-browser",
      "desktop-ax",
      "desktop-uia",
      "desktop-atspi",
      "cua",
    ],
  },
  screenshot: {
    transports: [
      "cdp-browser",
      "desktop-ax",
      "desktop-uia",
      "desktop-atspi",
      "cua",
    ],
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
    transports: [
      "http",
      "cdp-browser",
      "desktop-ax",
      "desktop-uia",
      "desktop-atspi",
    ],
  },
  retry: { transports: [...TRANSPORT_KINDS] },

  // --- CUA family (screenshot + VLM coord action) ---
  cua_snapshot: { transports: ["cua"] },
  cua_click: {
    transports: [
      "cua",
      "cdp-browser",
      "desktop-ax",
      "desktop-uia",
      "desktop-atspi",
    ],
  },
  cua_type: {
    transports: [
      "cua",
      "cdp-browser",
      "desktop-ax",
      "desktop-uia",
      "desktop-atspi",
    ],
  },
  cua_key: {
    transports: [
      "cua",
      "cdp-browser",
      "desktop-ax",
      "desktop-uia",
      "desktop-atspi",
    ],
  },
  cua_scroll: {
    transports: [
      "cua",
      "cdp-browser",
      "desktop-ax",
      "desktop-uia",
      "desktop-atspi",
    ],
  },
  cua_drag: {
    transports: ["cua", "cdp-browser"],
  },
  cua_wait: {
    transports: [
      "cua",
      "cdp-browser",
      "subprocess",
      "desktop-ax",
      "desktop-uia",
      "desktop-atspi",
    ],
  },
  cua_assert: {
    transports: [
      "cua",
      "cdp-browser",
      "subprocess",
      "desktop-ax",
      "desktop-uia",
      "desktop-atspi",
    ],
  },
  cua_ask: { transports: ["cua"] },
  cua_backend: { transports: ["cua"] },
  cua_launch: { transports: ["cua", "subprocess", "desktop-ax"] },

  // --- Platform-exclusive OS steps ---
  ax_focus: { transports: ["desktop-ax"], platforms: ["darwin"] },
  ax_menu_select: { transports: ["desktop-ax"], platforms: ["darwin"] },
  applescript: { transports: ["desktop-ax"], platforms: ["darwin"] },
  ax_snapshot: { transports: ["desktop-ax"], platforms: ["darwin"] },
  ax_focused_read: { transports: ["desktop-ax"], platforms: ["darwin"] },
  ax_set_value: { transports: ["desktop-ax"], platforms: ["darwin"] },
  ax_press: { transports: ["desktop-ax"], platforms: ["darwin"] },
  uia_invoke: { transports: ["desktop-uia"], platforms: ["win32"] },
  uia_get_pattern: { transports: ["desktop-uia"], platforms: ["win32"] },
  atspi_activate: { transports: ["desktop-atspi"], platforms: ["linux"] },

  // --- Clipboard / app lifecycle (cross-transport where possible) ---
  // Naming note: handlers and adapters use `clipboard_read` / `clipboard_write`
  // throughout (see src/engine/steps/desktop-ax.ts, AX/UIA/AT-SPI adapters,
  // src/commands/migrate-schema.ts, src/commands/lint.ts). The matrix keys
  // must match the handler keys verbatim — `bus.require("clipboard_read")`
  // looks up by name, so a `clipboard_get` alias here would 404 at runtime.
  clipboard_read: {
    transports: [
      "cdp-browser",
      "subprocess",
      "desktop-ax",
      "desktop-uia",
      "desktop-atspi",
    ],
  },
  clipboard_write: {
    transports: [
      "cdp-browser",
      "subprocess",
      "desktop-ax",
      "desktop-uia",
      "desktop-atspi",
    ],
  },
  launch_app: {
    transports: ["subprocess", "desktop-ax", "desktop-uia", "desktop-atspi"],
  },
  focus_window: {
    transports: ["desktop-ax", "desktop-uia", "desktop-atspi", "cua"],
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
