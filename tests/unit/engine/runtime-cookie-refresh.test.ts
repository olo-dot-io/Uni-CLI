import { afterEach, describe, expect, it, vi } from "vitest";

async function authFailure(statusCode: 401 | 403) {
  const { PipelineError } = await import("../../../src/engine/executor.js");
  return new PipelineError("authentication failed", {
    step: 0,
    action: "fetch",
    config: {},
    errorType: "http_error",
    statusCode,
    suggestion: "refresh authentication",
  });
}

afterEach(() => {
  vi.doUnmock("../../../src/engine/cookie-refresh.js");
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("maybeRefreshCookies", () => {
  it("passes the adapter domain to the browser refresh boundary", async () => {
    const refreshCookies = vi.fn(async () => ({
      status: "refreshed" as const,
      site: "openreview",
      cookieCount: 2,
    }));
    vi.doMock("../../../src/engine/cookie-refresh.js", () => ({
      refreshCookies,
    }));
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const { maybeRefreshCookies } =
      await import("../../../src/engine/runtime.js");

    await maybeRefreshCookies(await authFailure(403), {
      strategy: "cookie",
      site: "openreview",
      domain: "openreview.net",
    });

    expect(refreshCookies).toHaveBeenCalledWith("openreview", "openreview.net");
    expect(stderr).toHaveBeenCalledWith(
      "[cookie-refresh] refreshed 2 cookie(s) for openreview; retry the command.\n",
    );
  });

  it("reports refresh failures without replacing the original error", async () => {
    vi.doMock("../../../src/engine/cookie-refresh.js", () => ({
      refreshCookies: async () => {
        throw new Error("CDP disconnected");
      },
    }));
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const { maybeRefreshCookies } =
      await import("../../../src/engine/runtime.js");

    await expect(
      maybeRefreshCookies(await authFailure(401), {
        strategy: "header",
        site: "example",
        domain: "example.org",
      }),
    ).resolves.toBeUndefined();
    expect(stderr).toHaveBeenCalledWith(
      "[cookie-refresh] recovery failed for example: CDP disconnected; the original pipeline error remains authoritative.\n",
    );
  });
});
