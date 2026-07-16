import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PipelineContext } from "../../src/engine/executor.js";
import type { IPage } from "../../src/types.js";
import { InMemoryBrowserRuntimeHarness } from "../helpers/in-memory-browser-runtime.js";

const cookieBoundary = vi.hoisted(() => ({
  readCookies: vi.fn(),
}));

// REASON: Local browser profile discovery and encrypted cookie storage are operating-system boundaries; broker/auth-sync behavior stays real.
vi.mock("../../src/browser/local-profiles.js", () => ({
  resolvePreferredLocalBrowserProfile: () => ({
    id: "google-chrome:Default",
    browser_name: "Google Chrome",
    browser_path: "/Applications/Chrome",
    browser_path_exists: true,
    user_data_dir: "/Users/example/Library/Application Support/Google/Chrome",
    profile_dir: "Default",
    profile_name: "Personal",
    profile_path:
      "/Users/example/Library/Application Support/Google/Chrome/Default",
    display_name: "Google Chrome - Personal",
    debug_port: { state: "not-recorded" },
  }),
  browserCookieIdForLocalProfile: () => "chrome",
}));
vi.mock("../../src/engine/chromium-cookies.js", () => ({
  readCookies: cookieBoundary.readCookies,
}));

import {
  acquirePage,
  waitForNetworkIdle,
} from "../../src/engine/steps/browser-helpers.js";

let runtime: InMemoryBrowserRuntimeHarness;
let previousRuntimeRoot: string | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  previousRuntimeRoot = process.env.UNICLI_BROWSER_RUNTIME_DIR;
  runtime = new InMemoryBrowserRuntimeHarness();
  process.env.UNICLI_BROWSER_RUNTIME_DIR = runtime.runtimeRoot;
  cookieBoundary.readCookies.mockReturnValue([
    {
      host: ".x.com",
      name: "auth_token",
      value: "secret",
      path: "/",
      expires: 13_433_616_000_000_000,
      secure: true,
      httpOnly: true,
      persistent: true,
      hasExpires: true,
    },
  ]);
  await runtime.start();
});

afterEach(async () => {
  await runtime.cleanup();
  if (previousRuntimeRoot === undefined) {
    delete process.env.UNICLI_BROWSER_RUNTIME_DIR;
  } else {
    process.env.UNICLI_BROWSER_RUNTIME_DIR = previousRuntimeRoot;
  }
});

describe("browser pipeline page acquisition", () => {
  it("acquires through the broker, installs hardening, and syncs declared user cookies", async () => {
    const page = await acquirePage(userPipelineContext());

    expect(page).toBeDefined();
    expect(runtime.provider.acquireCount).toBe(1);
    expect(cookieBoundary.readCookies).toHaveBeenCalledWith({
      browser: "chrome",
      domain: "x.com",
      profile: "Default",
      userDataDir: "/Users/example/Library/Application Support/Google/Chrome",
    });
    expect(runtime.provider.pages[0]?.cdpCalls).toEqual([
      expect.objectContaining({
        method: "Page.addScriptToEvaluateOnNewDocument",
      }),
      { method: "Network.enable" },
      {
        method: "Network.setCookies",
        params: {
          cookies: [
            expect.objectContaining({
              domain: ".x.com",
              name: "auth_token",
              value: "secret",
            }),
          ],
        },
      },
    ]);
  });

  it("fails with the exact cookie bootstrap reason instead of opening an unauthenticated fallback", async () => {
    cookieBoundary.readCookies.mockReturnValue([]);

    await expect(acquirePage(userPipelineContext())).rejects.toThrow(
      "Failed to bootstrap browser cookies for x.com: no-cookies for x.com",
    );
    expect(runtime.provider.acquireCount).toBe(1);
    expect(runtime.provider.pages[0]?.cdpCalls).toEqual([
      expect.objectContaining({
        method: "Page.addScriptToEvaluateOnNewDocument",
      }),
    ]);
    expect(runtime.provider.releaseCount).toBe(1);
    expect(runtime.provider.pages[0]?.closed).toBe(true);
    await expect(runtime.status()).resolves.toMatchObject({
      sessions: { sessions: [], target_leases: [] },
      providers: { managed: [{ target_count: 0 }] },
    });
  });

  it("skips local cookie access for non-user browser sessions", async () => {
    await acquirePage({
      data: null,
      args: {},
      vars: {},
      browserSession: "fresh",
      site: "twitter",
      domain: "x.com",
    });

    expect(cookieBoundary.readCookies).not.toHaveBeenCalled();
    expect(runtime.provider.pages[0]?.cdpCalls).toEqual([
      expect.objectContaining({
        method: "Page.addScriptToEvaluateOnNewDocument",
      }),
    ]);
  });

  it("reuses an already acquired pipeline page without touching runtime ownership", async () => {
    const existing = { title: vi.fn() } as unknown as IPage;

    await expect(
      acquirePage({ data: null, args: {}, vars: {}, page: existing }),
    ).resolves.toBe(existing);
    expect(runtime.provider.acquireCount).toBe(0);
    expect(cookieBoundary.readCookies).not.toHaveBeenCalled();
  });
});

describe("browser pipeline network quiescence", () => {
  it("waits until the observed request count stays unchanged for the quiet window", async () => {
    let count = 0;
    const page = {
      networkRequests: vi.fn(async () => {
        count = Math.min(count + 1, 2);
        return Array.from({ length: count }, () => ({}));
      }),
      waitFor: vi.fn(async () => undefined),
    } as unknown as IPage;

    await waitForNetworkIdle(page, 1_000, 0);

    expect(page.networkRequests).toHaveBeenCalledTimes(3);
  });
});

function userPipelineContext(): PipelineContext {
  return {
    data: null,
    args: {},
    vars: {},
    browserSession: "user",
    site: "twitter",
    domain: "x.com",
  };
}
