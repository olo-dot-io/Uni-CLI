import { describe, expect, it } from "vitest";

import {
  BrowserRefTargetError,
  buildBrowserRefTargetExpression,
  extractBrowserSnapshotRef,
  readBrowserRefTargetResult,
  requireBrowserRefTarget,
  requireBrowserViewportPoint,
} from "../../../src/browser/ref-target.js";

describe("browser snapshot ref target contract", () => {
  it("extracts only ref-bearing selectors and embeds the full selector safely", () => {
    expect(extractBrowserSnapshotRef('button[data-unicli-ref="p:7"].ok')).toBe(
      "p:7",
    );
    expect(extractBrowserSnapshotRef("button.ok")).toBeNull();
    expect(
      buildBrowserRefTargetExpression('[data-unicli-ref="7"]);throw 1;//"]'),
    ).toContain("element.matches");
  });

  it("accepts exact finite geometry and rejects semantic corruption", () => {
    expect(
      readBrowserRefTargetResult({
        status: "found",
        ref: "7",
        x: 12,
        y: 14,
        width: 20,
        height: 10,
        frame_depth: 2,
      }),
    ).toEqual({
      status: "found",
      ref: "7",
      x: 12,
      y: 14,
      width: 20,
      height: 10,
      frame_depth: 2,
    });
    expect(() =>
      readBrowserRefTargetResult({
        status: "found",
        ref: "7",
        x: Number.NaN,
        y: 14,
        width: 20,
        height: 10,
        frame_depth: 0,
      }),
    ).toThrow("invalid geometry");
  });

  it("turns every non-found state into a typed refusal without fallback", () => {
    expect(() =>
      requireBrowserRefTarget({ status: "unsupported_frame", ref: "9" }),
    ).toThrow(BrowserRefTargetError);
    try {
      requireBrowserRefTarget({ status: "stale", ref: "9" });
      expect.unreachable("stale ref must refuse");
    } catch (error) {
      expect(error).toMatchObject({
        code: "stale_ref",
        retryable: false,
        suggestion: expect.stringContaining("fresh browser state"),
      });
    }
    expect(() =>
      requireBrowserRefTarget({ status: "occluded", ref: "11" }),
    ).toThrow(
      expect.objectContaining({
        code: "browser_selector_occluded",
        suggestion: expect.stringContaining("untrusted DOM click"),
      }),
    );
  });

  it("accepts only points inside a valid live CSS viewport", () => {
    expect(
      requireBrowserViewportPoint({ width: 800, height: 600 }, 799.5, 599.5),
    ).toEqual({ width: 800, height: 600 });
    expect(() =>
      requireBrowserViewportPoint({ width: 800, height: 600 }, 800, 0),
    ).toThrow(
      expect.objectContaining({ code: "browser_coordinate_out_of_bounds" }),
    );
    expect(() =>
      requireBrowserViewportPoint({ width: 0, height: 600 }, 0, 0),
    ).toThrow(expect.objectContaining({ code: "browser_viewport_invalid" }));
  });
});
