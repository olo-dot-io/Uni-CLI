import { describe, it, expect } from "vitest";
import {
  generateInterceptorJs,
  generateTapInterceptorJs,
  generateReadInterceptedJs,
} from "../../src/engine/interceptor.js";

describe("interceptor", () => {
  describe("generateInterceptorJs", () => {
    it("returns valid JS string", () => {
      const js = generateInterceptorJs("/api/data");
      expect(typeof js).toBe("string");
      expect(js.length).toBeGreaterThan(100);
    });

    it("patches both fetch and XHR", () => {
      const js = generateInterceptorJs("/api/");
      expect(js).toContain("window.fetch");
      expect(js).toContain("XMLHttpRequest.prototype.open");
      expect(js).toContain("XMLHttpRequest.prototype.send");
    });

    it("includes anti-detection (enumerable false + toString disguise)", () => {
      const js = generateInterceptorJs("/api/");
      expect(js).toContain("enumerable: false");
      expect(js).toContain("toString");
      expect(js).toContain("WeakMap");
    });

    it("includes idempotency guard", () => {
      const js = generateInterceptorJs("/api/");
      expect(js).toContain("__unicli_interceptor_patched");
    });

    it("embeds the capture pattern", () => {
      const js = generateInterceptorJs("/api/v2/users");
      expect(js).toContain("/api/v2/users");
    });
  });

  describe("generateTapInterceptorJs", () => {
    it("returns struct with all required fields", () => {
      const result = generateTapInterceptorJs("/api/user");
      expect(result.setupVar).toBeDefined();
      expect(result.capturedVar).toBe("__captured");
      expect(result.promiseVar).toBe("__capturePromise");
      expect(result.resolveVar).toBe("__captureResolve");
      expect(result.fetchPatch).toContain("fetch");
      expect(result.xhrPatch).toContain("XMLHttpRequest");
      expect(result.restorePatch).toContain("origFetch");
    });

    it("includes promise-based capture resolve", () => {
      const result = generateTapInterceptorJs("/api/");
      expect(result.setupVar).toContain("Promise");
      expect(result.setupVar).toContain("__captureResolve");
    });
  });

  describe("generateReadInterceptedJs", () => {
    it("reads and clears the intercepted array", () => {
      const js = generateReadInterceptedJs();
      expect(js).toContain("__unicli_intercepted");
      expect(js).toContain("JSON.stringify");
      expect(js).toContain("[]"); // reset
    });

    it("accepts custom array name", () => {
      const js = generateReadInterceptedJs("__my_custom_array");
      expect(js).toContain("__my_custom_array");
    });
  });
});
