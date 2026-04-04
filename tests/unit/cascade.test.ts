import { describe, it, expect, afterEach } from "vitest";
import { clearCascadeCache, getStrategy } from "../../src/engine/cascade.js";

describe("cascade", () => {
  afterEach(() => {
    clearCascadeCache();
  });

  it("getStrategy returns declared strategy when no cache", () => {
    expect(getStrategy("testsite", "cookie")).toBe("cookie");
  });

  it("getStrategy defaults to public when no declaration", () => {
    expect(getStrategy("testsite")).toBe("public");
  });

  it("clearCascadeCache resets cache", () => {
    // Just verify it doesn't throw
    clearCascadeCache();
    expect(getStrategy("anything")).toBe("public");
  });
});
