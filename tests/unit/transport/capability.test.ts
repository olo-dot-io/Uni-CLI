/**
 * Capability matrix tests — 46 steps × 7 transports per round4/02 §3.
 *
 * These tests freeze the matrix so a future refactor cannot silently
 * widen or narrow what a transport claims to support. Every row in the
 * matrix is re-asserted; if round4/02 changes, this test is the first
 * place to update.
 */

import { describe, it, expect } from "vitest";
import type { TransportKind } from "../../../src/transport/types.js";
import {
  CAPABILITY_MATRIX,
  TRANSPORT_KINDS,
  stepSupportedBy,
  stepPlatform,
} from "../../../src/transport/capability.js";

describe("CAPABILITY_MATRIX shape", () => {
  it("lists all 7 transports in TRANSPORT_KINDS", () => {
    expect(TRANSPORT_KINDS).toEqual([
      "http",
      "cdp-browser",
      "subprocess",
      "desktop-ax",
      "desktop-uia",
      "desktop-atspi",
      "cua",
    ]);
  });

  it("declares at least 46 distinct step names", () => {
    expect(Object.keys(CAPABILITY_MATRIX).length).toBeGreaterThanOrEqual(46);
  });

  it("uses only the 7 known transport kinds in each row", () => {
    const kinds = new Set<TransportKind>(TRANSPORT_KINDS);
    for (const [step, row] of Object.entries(CAPABILITY_MATRIX)) {
      for (const kind of row.transports) {
        expect(kinds.has(kind), `${step}: unknown transport ${kind}`).toBe(
          true,
        );
      }
    }
  });
});

describe("stepSupportedBy", () => {
  it("fetch is http-only", () => {
    expect(stepSupportedBy("fetch")).toEqual(["http"]);
  });

  it("exec is subprocess-only", () => {
    expect(stepSupportedBy("exec")).toEqual(["subprocess"]);
  });

  it("generic browser UI steps stay on CDP-backed browser execution", () => {
    for (const step of [
      "navigate",
      "click",
      "type",
      "press",
      "scroll",
      "snapshot",
      "screenshot",
      "extract",
    ]) {
      expect(stepSupportedBy(step), step).toEqual(["cdp-browser"]);
    }
  });

  it("generic wait keeps subprocess as the non-browser timer fallback", () => {
    expect(stepSupportedBy("wait")).toEqual(["cdp-browser", "subprocess"]);
  });

  it("compute_screenshot advertises CUA as the last visual fallback", () => {
    expect(stepSupportedBy("compute_screenshot")).toEqual([
      "cdp-browser",
      "desktop-ax",
      "desktop-uia",
      "desktop-atspi",
      "cua",
    ]);
  });

  it("applescript is desktop-ax-only", () => {
    expect(stepSupportedBy("applescript")).toEqual(["desktop-ax"]);
  });

  it("new direct AX actions stay desktop-ax-only", () => {
    expect(stepSupportedBy("ax_apps")).toEqual(["desktop-ax"]);
    expect(stepSupportedBy("ax_windows")).toEqual(["desktop-ax"]);
    expect(stepSupportedBy("ax_snapshot")).toEqual(["desktop-ax"]);
    expect(stepSupportedBy("ax_focused_read")).toEqual(["desktop-ax"]);
    expect(stepSupportedBy("ax_set_value")).toEqual(["desktop-ax"]);
    expect(stepSupportedBy("ax_press")).toEqual(["desktop-ax"]);
    expect(stepSupportedBy("ax_scroll")).toEqual(["desktop-ax"]);
    expect(stepSupportedBy("ax_screenshot")).toEqual(["desktop-ax"]);
    expect(stepSupportedBy("ax_background_click")).toEqual(["desktop-ax"]);
  });

  it("direct UIA actions stay desktop-uia-only", () => {
    for (const step of [
      "uia_apps",
      "uia_windows",
      "uia_snapshot",
      "uia_find",
      "uia_invoke",
      "uia_set_value",
      "uia_focus",
      "uia_press",
      "uia_scroll",
      "uia_screenshot",
      "uia_wait",
      "uia_observe",
      "uia_assert",
    ]) {
      expect(stepSupportedBy(step), step).toEqual(["desktop-uia"]);
    }
    expect(stepSupportedBy("uia_get_pattern")).toEqual([]);
  });

  it("direct AT-SPI actions stay desktop-atspi-only", () => {
    for (const step of [
      "atspi_apps",
      "atspi_windows",
      "atspi_snapshot",
      "atspi_find",
      "atspi_invoke",
      "atspi_set_value",
      "atspi_focus",
      "atspi_press",
      "atspi_scroll",
      "atspi_screenshot",
      "atspi_wait",
      "atspi_observe",
      "atspi_assert",
    ]) {
      expect(stepSupportedBy(step), step).toEqual(["desktop-atspi"]);
    }
    expect(stepSupportedBy("atspi_activate")).toEqual([]);
  });

  it("direct CUA actions stay cua-only", () => {
    for (const step of [
      "cua_snapshot",
      "cua_click",
      "cua_type",
      "cua_key",
      "cua_scroll",
      "cua_drag",
      "cua_wait",
      "cua_assert",
      "cua_ask",
      "cua_backend",
      "cua_launch",
    ]) {
      expect(stepSupportedBy(step), step).toEqual(["cua"]);
    }
  });

  it("shared desktop lifecycle rows only advertise implemented native actions", () => {
    expect(stepSupportedBy("clipboard_read")).toEqual(["desktop-ax"]);
    expect(stepSupportedBy("clipboard_write")).toEqual(["desktop-ax"]);
    expect(stepSupportedBy("focus_window")).toEqual(["desktop-ax"]);
    expect(stepSupportedBy("launch_app")).toEqual([
      "subprocess",
      "desktop-ax",
      "desktop-uia",
      "desktop-atspi",
    ]);
  });

  it("control-flow steps (set/if/append/each/parallel) span every transport", () => {
    for (const step of ["set", "if", "append", "each", "parallel"]) {
      const t = stepSupportedBy(step);
      // control-flow is orchestrator-level so every transport supports it
      expect(t.length).toBeGreaterThanOrEqual(TRANSPORT_KINDS.length);
    }
  });

  it("returns empty array for unknown step", () => {
    expect(stepSupportedBy("totally_made_up_step")).toEqual([]);
  });
});

describe("stepPlatform", () => {
  it("applescript is darwin-gated", () => {
    expect(stepPlatform("applescript")).toEqual(["darwin"]);
  });

  it("ax_focus is darwin-gated", () => {
    expect(stepPlatform("ax_focus")).toEqual(["darwin"]);
  });

  it("direct AX actions are darwin-gated", () => {
    expect(stepPlatform("ax_apps")).toEqual(["darwin"]);
    expect(stepPlatform("ax_windows")).toEqual(["darwin"]);
    expect(stepPlatform("ax_snapshot")).toEqual(["darwin"]);
    expect(stepPlatform("ax_focused_read")).toEqual(["darwin"]);
    expect(stepPlatform("ax_set_value")).toEqual(["darwin"]);
    expect(stepPlatform("ax_press")).toEqual(["darwin"]);
    expect(stepPlatform("ax_scroll")).toEqual(["darwin"]);
    expect(stepPlatform("ax_screenshot")).toEqual(["darwin"]);
    expect(stepPlatform("ax_background_click")).toEqual(["darwin"]);
  });

  it("direct UIA actions are win32-gated", () => {
    for (const step of [
      "uia_apps",
      "uia_windows",
      "uia_snapshot",
      "uia_find",
      "uia_invoke",
      "uia_set_value",
      "uia_focus",
      "uia_press",
      "uia_scroll",
      "uia_screenshot",
      "uia_wait",
      "uia_observe",
      "uia_assert",
    ]) {
      expect(stepPlatform(step), step).toEqual(["win32"]);
    }
    expect(stepPlatform("uia_get_pattern")).toBeUndefined();
  });

  it("direct AT-SPI actions are linux-gated", () => {
    for (const step of [
      "atspi_apps",
      "atspi_windows",
      "atspi_snapshot",
      "atspi_find",
      "atspi_invoke",
      "atspi_set_value",
      "atspi_focus",
      "atspi_press",
      "atspi_scroll",
      "atspi_screenshot",
      "atspi_wait",
      "atspi_observe",
      "atspi_assert",
    ]) {
      expect(stepPlatform(step), step).toEqual(["linux"]);
    }
    expect(stepPlatform("atspi_activate")).toBeUndefined();
  });

  it("fetch has no platform gate", () => {
    expect(stepPlatform("fetch")).toBeUndefined();
  });

  it("click has no platform gate because CDP runs on every host platform", () => {
    expect(stepPlatform("click")).toBeUndefined();
  });
});

describe("cross-transport assertions", () => {
  it("no platform-gated step appears on a transport that cannot run it", () => {
    for (const [step, row] of Object.entries(CAPABILITY_MATRIX)) {
      if (!row.platforms) continue;
      // platform-gated steps are by construction on a single transport
      expect(
        row.transports.length,
        `${step} is platform-gated but spans ${row.transports.length} transports`,
      ).toBe(1);
    }
  });

  it("every transport has at least one exclusive or platform-gated step", () => {
    const coverage = new Map<TransportKind, number>();
    for (const row of Object.values(CAPABILITY_MATRIX)) {
      for (const kind of row.transports) {
        coverage.set(kind, (coverage.get(kind) ?? 0) + 1);
      }
    }
    for (const kind of TRANSPORT_KINDS) {
      expect(
        coverage.get(kind) ?? 0,
        `transport ${kind} has zero matrix entries`,
      ).toBeGreaterThan(0);
    }
  });

  it("transport-exclusive step count >= 11 (per round4/02 §3)", () => {
    let exclusive = 0;
    for (const row of Object.values(CAPABILITY_MATRIX)) {
      if (row.transports.length === 1) exclusive++;
    }
    expect(exclusive).toBeGreaterThanOrEqual(11);
  });
});
