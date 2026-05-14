import { describe, expect, it, vi } from "vitest";

const browserMock = vi.hoisted(() => ({
  page: { marker: "browser-page" },
  calls: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../src/engine/steps/browser-helpers.js", () => ({
  acquirePage: async (ctx: Record<string, unknown>) => {
    browserMock.calls.push(ctx);
    return browserMock.page;
  },
}));

import {
  loadAllAdapters,
  primeKernelCache,
} from "../../src/discovery/loader.js";
import { buildInvocation, execute } from "../../src/engine/kernel/execute.js";
import { cli, getAdapter, Strategy } from "../../src/registry.js";

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

  it("passes browser session preference to browser-backed TypeScript commands", async () => {
    loadAllAdapters();
    browserMock.calls.length = 0;

    cli({
      site: "unit-user-browser-func",
      name: "inspect",
      description: "Inspect via user browser page",
      strategy: Strategy.COOKIE,
      browser: true,
      browserSession: "user",
      func: async () => [{ ok: true }],
    });
    primeKernelCache();

    const invocation = buildInvocation(
      "cli",
      "unit-user-browser-func",
      "inspect",
      {
        args: {},
        source: "internal",
      },
    );
    expect(invocation).not.toBeNull();

    const result = await execute(invocation!);

    expect(result.exitCode).toBe(0);
    expect(browserMock.calls.at(-1)?.browserSession).toBe("user");
  });

  it("keeps TypeScript adapter host metadata on each command", () => {
    cli({
      site: "unit-multi-domain-cli",
      name: "drive",
      description: "Drive command",
      domain: "drive.unit-cli.example",
      strategy: Strategy.COOKIE,
      browser: true,
      func: async () => [{ ok: true }],
    });
    cli({
      site: "unit-multi-domain-cli",
      name: "share",
      description: "Share command",
      domain: "share.unit-cli.example",
      strategy: Strategy.COOKIE,
      browser: true,
      func: async () => [{ ok: true }],
    });

    const adapter = getAdapter("unit-multi-domain-cli");
    expect(adapter?.commands.drive.domain).toBe("drive.unit-cli.example");
    expect(adapter?.commands.share.domain).toBe("share.unit-cli.example");
  });
});
