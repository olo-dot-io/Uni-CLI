import { describe, it, expect, vi } from "vitest";
import { STEALTH_SCRIPT, injectStealth } from "../../src/browser/stealth.js";

describe("stealth", () => {
  it("script patches navigator.webdriver", () => {
    expect(STEALTH_SCRIPT).toContain("webdriver");
  });

  it("script patches chrome.runtime", () => {
    expect(STEALTH_SCRIPT).toContain("chrome.runtime");
  });

  it("script patches navigator.plugins", () => {
    expect(STEALTH_SCRIPT).toContain("plugins");
  });

  it("injectStealth calls addScriptToEvaluateOnNewDocument", async () => {
    const send = vi.fn().mockResolvedValue({});
    await injectStealth(send);
    expect(send).toHaveBeenCalledWith("Page.addScriptToEvaluateOnNewDocument", {
      source: STEALTH_SCRIPT,
    });
  });
});
