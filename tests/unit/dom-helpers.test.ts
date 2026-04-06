/**
 * Unit tests for DOM helper functions.
 */

import { describe, it, expect } from "vitest";
import { waitForDomStableJs } from "../../src/browser/dom-helpers.js";

describe("waitForDomStableJs()", () => {
  it("returns a string containing an IIFE with a Promise", () => {
    const js = waitForDomStableJs();
    expect(typeof js).toBe("string");
    expect(js).toContain("Promise");
    expect(js).toContain("MutationObserver");
  });

  it("embeds default values (1000ms max, 500ms quiet)", () => {
    const js = waitForDomStableJs();
    expect(js).toContain("MAX=1000");
    expect(js).toContain("QUIET=500");
  });

  it("embeds custom maxMs and quietMs values", () => {
    const js = waitForDomStableJs(3000, 200);
    expect(js).toContain("MAX=3000");
    expect(js).toContain("QUIET=200");
  });

  it("observes childList, subtree, and attributes", () => {
    const js = waitForDomStableJs();
    expect(js).toContain("childList:true");
    expect(js).toContain("subtree:true");
    expect(js).toContain("attributes:true");
  });

  it("handles edge case of zero/negative values gracefully", () => {
    const js = waitForDomStableJs(0, -1);
    // Should fall back to defaults
    expect(js).toContain("MAX=1000");
    expect(js).toContain("QUIET=500");
  });

  it("handles NaN/undefined gracefully", () => {
    const js = waitForDomStableJs(undefined, undefined);
    expect(js).toContain("MAX=1000");
    expect(js).toContain("QUIET=500");
  });

  it("truncates floating point values to integers", () => {
    const js = waitForDomStableJs(1500.7, 300.3);
    expect(js).toContain("MAX=1500");
    expect(js).toContain("QUIET=300");
  });

  it("starts with IIFE and returns a promise (evaluable format)", () => {
    const js = waitForDomStableJs();
    // Should be a self-invoking function
    expect(js).toMatch(/^\(\(\)=>/);
    // Should end with invocation
    expect(js).toMatch(/\)\(\)$/);
  });

  it("handles document.body being null", () => {
    const js = waitForDomStableJs();
    // Should have a guard for missing body
    expect(js).toContain("!document.body");
    expect(js).toContain("resolve()");
  });
});
