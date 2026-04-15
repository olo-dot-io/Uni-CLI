/**
 * Step module barrel tests — assert every handler is importable from
 * `src/engine/steps/` and that the barrel re-exports a stable surface.
 *
 * These tests guard the architectural boundary: future phases may
 * migrate step bodies out of `yaml-runner.ts`, but the import paths
 * under `src/engine/steps/` must stay usable.
 */

import { describe, it, expect } from "vitest";
import * as steps from "../../../src/engine/steps/index.js";
import * as fetchMod from "../../../src/engine/steps/fetch.js";
import * as transformMod from "../../../src/engine/steps/transform.js";
import * as browserMod from "../../../src/engine/steps/browser.js";
import * as desktopMod from "../../../src/engine/steps/desktop.js";
import * as downloadMod from "../../../src/engine/steps/download.js";
import * as controlMod from "../../../src/engine/steps/control.js";
import * as websocketMod from "../../../src/engine/steps/websocket.js";

describe("engine/steps barrel", () => {
  it("exports fetch family handlers", () => {
    expect(typeof fetchMod.handleFetch).toBe("function");
    expect(typeof fetchMod.handleFetchText).toBe("function");
    expect(typeof fetchMod.handleParseRss).toBe("function");
    expect(typeof fetchMod.handleHtmlToMd).toBe("function");
  });

  it("exports transform handlers", () => {
    expect(typeof transformMod.handleSelect).toBe("function");
    expect(typeof transformMod.handleMap).toBe("function");
    expect(typeof transformMod.handleFilter).toBe("function");
    expect(typeof transformMod.handleSort).toBe("function");
    expect(typeof transformMod.handleLimit).toBe("function");
  });

  it("exports browser handlers", () => {
    expect(typeof browserMod.handleNavigate).toBe("function");
    expect(typeof browserMod.handleEvaluate).toBe("function");
    expect(typeof browserMod.handleClick).toBe("function");
    expect(typeof browserMod.handleType).toBe("function");
    expect(typeof browserMod.handleWait).toBe("function");
    expect(typeof browserMod.handleIntercept).toBe("function");
    expect(typeof browserMod.handlePress).toBe("function");
    expect(typeof browserMod.handleScroll).toBe("function");
    expect(typeof browserMod.handleSnapshot).toBe("function");
    expect(typeof browserMod.handleTap).toBe("function");
    expect(typeof browserMod.handleExtract).toBe("function");
  });

  it("exports desktop handlers", () => {
    expect(typeof desktopMod.handleExec).toBe("function");
    expect(typeof desktopMod.handleWriteTemp).toBe("function");
  });

  it("exports download handler", () => {
    expect(typeof downloadMod.handleDownload).toBe("function");
  });

  it("exports control handlers", () => {
    expect(typeof controlMod.handleSet).toBe("function");
    expect(typeof controlMod.handleAppend).toBe("function");
    expect(typeof controlMod.handleIf).toBe("function");
    expect(typeof controlMod.handleEach).toBe("function");
    expect(typeof controlMod.handleParallel).toBe("function");
    expect(typeof controlMod.handleAssert).toBe("function");
  });

  it("exports websocket handler", () => {
    expect(typeof websocketMod.handleWebsocket).toBe("function");
  });

  it("barrel re-exports every handler", () => {
    const expected = [
      "handleFetch",
      "handleFetchText",
      "handleParseRss",
      "handleHtmlToMd",
      "handleSelect",
      "handleMap",
      "handleFilter",
      "handleSort",
      "handleLimit",
      "handleNavigate",
      "handleEvaluate",
      "handleClick",
      "handleType",
      "handleWait",
      "handleIntercept",
      "handlePress",
      "handleScroll",
      "handleSnapshot",
      "handleTap",
      "handleExtract",
      "handleExec",
      "handleWriteTemp",
      "handleDownload",
      "handleSet",
      "handleAppend",
      "handleIf",
      "handleEach",
      "handleParallel",
      "handleAssert",
      "handleWebsocket",
    ];
    for (const name of expected) {
      expect(typeof (steps as unknown as Record<string, unknown>)[name]).toBe(
        "function",
      );
    }
  });
});
