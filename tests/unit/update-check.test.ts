import { describe, it, expect } from "vitest";
import { isNewer } from "../../src/engine/update-check.js";

describe("update-check", () => {
  describe("isNewer", () => {
    it("detects major version bump", () => {
      expect(isNewer("1.0.0", "0.205.0")).toBe(true);
    });

    it("detects minor version bump", () => {
      expect(isNewer("0.206.0", "0.205.0")).toBe(true);
    });

    it("detects patch version bump", () => {
      expect(isNewer("0.205.1", "0.205.0")).toBe(true);
    });

    it("returns false for same version", () => {
      expect(isNewer("0.205.0", "0.205.0")).toBe(false);
    });

    it("returns false for older version", () => {
      expect(isNewer("0.204.0", "0.205.0")).toBe(false);
    });

    it("returns false when latest is older major", () => {
      expect(isNewer("0.100.0", "1.0.0")).toBe(false);
    });

    it("handles versions with missing patch", () => {
      expect(isNewer("1.0", "0.205.0")).toBe(true);
    });
  });

  it("checkForUpdates is a function", async () => {
    const mod = await import("../../src/engine/update-check.js");
    expect(typeof mod.checkForUpdates).toBe("function");
  });
});
