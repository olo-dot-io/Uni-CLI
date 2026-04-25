import { describe, expect, it, vi } from "vitest";

const browserMock = vi.hoisted(() => ({
  page: { marker: "browser-page" },
}));

vi.mock("../../src/engine/steps/browser-helpers.js", () => ({
  acquirePage: async () => browserMock.page,
}));

import {
  loadAllAdapters,
  primeKernelCache,
} from "../../src/discovery/loader.js";
import { buildInvocation, execute } from "../../src/engine/kernel/execute.js";
import { cli, Strategy } from "../../src/registry.js";

describe("kernel func execution", () => {
  it("passes an acquired page to browser-backed TypeScript commands", async () => {
    loadAllAdapters();
    let receivedPage: unknown;

    cli({
      site: "unit-browser-func",
      name: "inspect",
      description: "Inspect via browser page",
      strategy: Strategy.COOKIE,
      browser: true,
      func: async (page) => {
        receivedPage = page;
        return [{ ok: true }];
      },
    });
    primeKernelCache();

    const invocation = buildInvocation("cli", "unit-browser-func", "inspect", {
      args: {},
      source: "internal",
    });
    expect(invocation).not.toBeNull();

    const result = await execute(invocation!);

    expect(result.exitCode).toBe(0);
    expect(receivedPage).toBe(browserMock.page);
  });
});
