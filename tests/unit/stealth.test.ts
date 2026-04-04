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

  it("contains all 13 patches", () => {
    const markers = STEALTH_SCRIPT.match(/\/\/ \d+\./g);
    expect(markers?.length).toBeGreaterThanOrEqual(13);
  });

  it("cleans __playwright and cdc_ globals (patch 7)", () => {
    expect(STEALTH_SCRIPT).toContain("__playwright");
    expect(STEALTH_SCRIPT).toContain("cdc_");
  });

  it("filters CDP frames from Error.stack (patch 8)", () => {
    expect(STEALTH_SCRIPT).toContain("__puppeteer_evaluation_script__");
  });

  it("normalizes outerWidth/outerHeight (patch 10)", () => {
    expect(STEALTH_SCRIPT).toContain("outerWidth");
    expect(STEALTH_SCRIPT).toContain("outerHeight");
  });

  it("filters Performance API entries (patch 11)", () => {
    expect(STEALTH_SCRIPT).toContain("Performance.prototype.getEntries");
  });

  it("ensures iframe chrome consistency (patch 13)", () => {
    expect(STEALTH_SCRIPT).toContain("HTMLIFrameElement.prototype");
    expect(STEALTH_SCRIPT).toContain("contentWindow");
  });
});
