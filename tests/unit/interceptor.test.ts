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

    it("defaults to substring matching when no options", () => {
      const js = generateInterceptorJs("/api/data");
      expect(js).toContain("var __isRegex = false;");
      expect(js).toContain("url.includes(__pattern)");
    });

    it("uses regex matching with regex option", () => {
      const js = generateInterceptorJs("api/v\\d+/users", { regex: true });
      expect(js).toContain("var __isRegex = true;");
      expect(js).toContain("new RegExp(");
      expect(js).toContain("__pattern.test(url)");
    });

    it("auto-detects regex from /pattern/ syntax", () => {
      const js = generateInterceptorJs("/api\\/v\\d+/");
      expect(js).toContain("var __isRegex = true;");
      expect(js).toContain("new RegExp(");
      // Slashes are stripped; pattern is JSON-escaped in the generated JS
      expect(js).toContain("api\\\\/v\\\\d+");
    });

    it("does not auto-detect regex for plain paths starting with /", () => {
      // Pattern "/api/data" starts with / but does not end with /
      const js = generateInterceptorJs("/api/data");
      expect(js).toContain("var __isRegex = false;");
    });

    it("includes text fallback when captureText is true", () => {
      const js = generateInterceptorJs("/api/", { captureText: true });
      expect(js).toContain("var __captureText = true;");
      expect(js).toContain("type: 'text'");
      expect(js).toContain("type: 'json'");
      // Fetch path: falls back to .text() on JSON parse failure
      expect(js).toContain("await resp.clone().text()");
      // XHR path: falls back to responseText on JSON parse failure
      expect(js).toContain("data: xhr.responseText");
    });

    it("does not include text fallback by default", () => {
      const js = generateInterceptorJs("/api/");
      expect(js).toContain("var __captureText = false;");
    });

    it("embeds captureAll flag", () => {
      const js = generateInterceptorJs("/api/", { captureAll: true });
      expect(js).toContain("var __captureAll = true;");
    });

    it("defaults captureAll to false", () => {
      const js = generateInterceptorJs("/api/");
      expect(js).toContain("var __captureAll = false;");
    });

    it("includes type field in intercepted entries", () => {
      const js = generateInterceptorJs("/api/");
      expect(js).toContain("type: 'json'");
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

    it("defaults to substring matching when no options", () => {
      const result = generateTapInterceptorJs("/api/data");
      expect(result.setupVar).toContain("var __tapIsRegex = false;");
      expect(result.fetchPatch).toContain("url.includes(__tapPattern)");
    });

    it("uses regex matching with regex option", () => {
      const result = generateTapInterceptorJs("api/v\\d+", { regex: true });
      expect(result.setupVar).toContain("var __tapIsRegex = true;");
      expect(result.setupVar).toContain("new RegExp(");
      expect(result.fetchPatch).toContain("__tapPattern.test(url)");
    });

    it("auto-detects regex from /pattern/ syntax", () => {
      const result = generateTapInterceptorJs("/api\\/v\\d+/");
      expect(result.setupVar).toContain("var __tapIsRegex = true;");
      expect(result.setupVar).toContain("new RegExp(");
    });

    it("includes text fallback when captureText is true", () => {
      const result = generateTapInterceptorJs("/api/", { captureText: true });
      expect(result.setupVar).toContain("var __tapCaptureText = true;");
      expect(result.fetchPatch).toContain("type: 'text'");
      expect(result.fetchPatch).toContain("type: 'json'");
      expect(result.xhrPatch).toContain("type: 'text'");
      expect(result.xhrPatch).toContain("type: 'json'");
    });

    it("does not include text fallback by default", () => {
      const result = generateTapInterceptorJs("/api/");
      expect(result.setupVar).toContain("var __tapCaptureText = false;");
    });

    it("includes type field in intercepted entries", () => {
      const result = generateTapInterceptorJs("/api/");
      expect(result.fetchPatch).toContain("type: 'json'");
      expect(result.xhrPatch).toContain("type: 'json'");
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
