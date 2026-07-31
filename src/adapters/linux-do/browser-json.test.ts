import { beforeAll, describe, expect, it, vi } from "vitest";

import { loadAllAdapters, loadTsAdapters } from "../../discovery/loader.js";
import { getAdapter } from "../../registry.js";
import type { IPage } from "../../types.js";
import { fetchLinuxDoJson } from "./browser-json.js";

function pageReturning(value: unknown): {
  page: IPage;
  goto: ReturnType<typeof vi.fn>;
  evaluate: ReturnType<typeof vi.fn>;
} {
  const goto = vi.fn(async () => undefined);
  const evaluate = vi.fn(async () => value);
  return {
    page: { goto, evaluate } as unknown as IPage,
    goto,
    evaluate,
  };
}

describe("Linux.do browser JSON boundary", () => {
  it("reads JSON only through the first-party browser origin", async () => {
    const { page, goto, evaluate } = pageReturning({
      ok: true,
      status: 200,
      contentType: "application/json; charset=utf-8",
      data: { topics: [{ id: 1 }] },
    });
    const signal = new AbortController().signal;

    await expect(
      fetchLinuxDoJson(page, "/search.json?q=agent", signal),
    ).resolves.toEqual({ topics: [{ id: 1 }] });
    expect(goto).toHaveBeenCalledWith(
      "https://linux.do",
      { settleMs: 2_000 },
      signal,
    );
    expect(evaluate).toHaveBeenCalledWith(
      expect.stringContaining('fetch("/search.json?q=agent"'),
      signal,
    );
  });

  it.each([
    {
      response: {
        ok: false,
        status: 403,
        contentType: "application/json",
        data: { error_type: "not_logged_in" },
      },
    },
    {
      response: {
        ok: true,
        status: 200,
        contentType: "text/html",
        data: {},
      },
    },
    {
      response: {
        ok: true,
        status: 200,
        contentType: "application/json",
        data: { login_required: true },
      },
    },
  ])(
    "maps login and verification responses to auth_required",
    async ({ response }) => {
      const { page } = pageReturning(response);

      await expect(
        fetchLinuxDoJson(page, "/latest.json"),
      ).rejects.toMatchObject({
        code: "auth_required",
        retryable: false,
        suggestion: expect.stringContaining("selected browser profile"),
      });
    },
  );

  it("rejects cross-origin and protocol-relative paths before browser work", async () => {
    const { page, goto } = pageReturning({});

    await expect(
      fetchLinuxDoJson(page, "https://example.com/data.json"),
    ).rejects.toThrow("must be same-origin");
    await expect(fetchLinuxDoJson(page, "//example.com")).rejects.toThrow(
      "must be same-origin",
    );
    expect(goto).not.toHaveBeenCalled();
  });
});

describe("Linux.do command authentication contract", () => {
  beforeAll(async () => {
    loadAllAdapters();
    await loadTsAdapters();
  });

  it("declares every read against one signed-in browser substrate", () => {
    const adapter = getAdapter("linux-do");
    expect(adapter?.authCookies).toEqual(["_t"]);
    expect(Object.keys(adapter?.commands ?? {}).sort()).toEqual(
      [
        "categories",
        "category",
        "feed",
        "hot",
        "latest",
        "search",
        "tags",
        "topic",
        "topic-content",
        "user-posts",
        "user-topics",
      ].sort(),
    );

    for (const command of Object.values(adapter?.commands ?? {})) {
      expect(command).toMatchObject({
        strategy: "cookie",
        browser: true,
        auth_requirement: "required",
        operation_effect: "read",
        execution_operator: "browser-protocol",
        idempotency: "guaranteed",
        minimum_capability: "cdp-browser.evaluate",
      });
      expect(command.capabilities).toEqual(
        expect.arrayContaining([
          "cdp-browser.navigate",
          "cdp-browser.evaluate",
        ]),
      );
    }
  });
});
