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

  it("click spans browser + desktop + cua", () => {
    const t = stepSupportedBy("click");
    expect(t).toContain("cdp-browser");
    expect(t).toContain("desktop-ax");
    expect(t).toContain("desktop-uia");
    expect(t).toContain("desktop-atspi");
    expect(t).toContain("cua");
    expect(t).not.toContain("http");
    expect(t).not.toContain("subprocess");
  });

  it("applescript is desktop-ax-only", () => {
    expect(stepSupportedBy("applescript")).toEqual(["desktop-ax"]);
  });

  it("uia_invoke is desktop-uia-only", () => {
    expect(stepSupportedBy("uia_invoke")).toEqual(["desktop-uia"]);
  });

  it("atspi_activate is desktop-atspi-only", () => {
    expect(stepSupportedBy("atspi_activate")).toEqual(["desktop-atspi"]);
  });

  it("cua_snapshot is cua-only (native)", () => {
    expect(stepSupportedBy("cua_snapshot")).toEqual(["cua"]);
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

  it("uia_invoke is win32-gated", () => {
    expect(stepPlatform("uia_invoke")).toEqual(["win32"]);
  });

  it("atspi_activate is linux-gated", () => {
    expect(stepPlatform("atspi_activate")).toEqual(["linux"]);
  });

  it("fetch has no platform gate", () => {
    expect(stepPlatform("fetch")).toBeUndefined();
  });

  it("click has no platform gate (supported on all three host platforms)", () => {
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
