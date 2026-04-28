import { describe, expect, it, vi } from "vitest";

import {
  assertBrowserSessionLeaseTargetCurrent,
  browserSessionTargetKey,
  captureBrowserSessionTarget,
  enrichBrowserSessionLease,
} from "../../src/engine/browser/session-runtime.js";
import {
  BrowserSessionLeaseGuardError,
  createBrowserSessionLease,
  type BrowserSessionLeaseTarget,
} from "../../src/engine/browser/session-lease.js";
import type { IPage } from "../../src/types.js";

function mockPage(
  target: BrowserSessionLeaseTarget | null,
  cookies: Record<string, string> = {},
): IPage {
  return {
    goto: vi.fn(),
    evaluate: vi.fn(),
    wait: vi.fn(),
    waitForSelector: vi.fn(),
    waitFor: vi.fn(),
    click: vi.fn(),
    type: vi.fn(),
    press: vi.fn(),
    insertText: vi.fn(),
    scroll: vi.fn(),
    autoScroll: vi.fn(),
    nativeClick: vi.fn(),
    nativeKeyPress: vi.fn(),
    setFileInput: vi.fn(),
    cookies: vi.fn(async () => cookies),
    title: vi.fn(async () => target?.title ?? ""),
    url: vi.fn(async () => target?.url ?? ""),
    snapshot: vi.fn(),
    screenshot: vi.fn(),
    networkRequests: vi.fn(),
    addInitScript: vi.fn(),
    sendCDP: vi.fn(async () => ({
      targetInfo: {
        targetId: "cdp-fallback",
        type: "page",
        url: "https://fallback.example",
        title: "Fallback",
      },
    })),
    close: vi.fn(),
    closeWindow: vi.fn(),
    browserTargetInfo: vi.fn(async () => target),
  } as IPage & {
    browserTargetInfo: () => Promise<BrowserSessionLeaseTarget | null>;
  };
}

describe("browser session runtime", () => {
  it("uses window and tab identity when both are available", () => {
    expect(
      browserSessionTargetKey({
        kind: "daemon-tab",
        captured_at: "2026-04-29T02:10:00.000Z",
        window_id: 7,
        tab_id: 42,
      }),
    ).toBe("window:7:tab:42");
    expect(
      browserSessionTargetKey({
        kind: "daemon-tab",
        captured_at: "2026-04-29T02:10:00.000Z",
        tab_id: 42,
      }),
    ).toBe("tab:42");
  });

  it("enriches a lease with target identity and auth posture", async () => {
    const lease = createBrowserSessionLease({
      namespace: "browser",
      workspace: "browser:default",
    });

    const enriched = await enrichBrowserSessionLease(
      lease,
      mockPage(
        {
          kind: "daemon-tab",
          captured_at: "2026-04-29T02:10:00.000Z",
          tab_id: 42,
          window_id: 7,
          url: "https://example.com/feed",
          title: "Feed",
          owned: false,
        },
        { sid: "cookie" },
      ),
    );

    expect(enriched).toMatchObject({
      ...lease,
      target: {
        kind: "daemon-tab",
        tab_id: 42,
        window_id: 7,
        url: "https://example.com/feed",
      },
      auth: {
        state: "cookies_present",
        cookie_count: 1,
      },
    });
  });

  it("rejects a lease when the current target id changes", async () => {
    const lease = {
      ...createBrowserSessionLease({
        namespace: "browser",
        workspace: "browser:default",
      }),
      target: {
        kind: "daemon-tab" as const,
        captured_at: "2026-04-29T02:10:00.000Z",
        tab_id: 42,
      },
    };

    await expect(
      assertBrowserSessionLeaseTargetCurrent(
        lease,
        mockPage({
          kind: "daemon-tab",
          captured_at: "2026-04-29T02:11:00.000Z",
          tab_id: 43,
        }),
      ),
    ).rejects.toMatchObject({
      code: "browser_target_mismatch",
      expected: "tab:42",
      actual: "tab:43",
    });
    await expect(
      assertBrowserSessionLeaseTargetCurrent(
        lease,
        mockPage({
          kind: "daemon-tab",
          captured_at: "2026-04-29T02:11:00.000Z",
          tab_id: 43,
        }),
      ),
    ).rejects.toBeInstanceOf(BrowserSessionLeaseGuardError);
  });

  it("falls back to CDP target info when the page target provider fails", async () => {
    const page = mockPage(null);
    (
      page as IPage & {
        browserTargetInfo: () => Promise<BrowserSessionLeaseTarget | null>;
      }
    ).browserTargetInfo = vi.fn(async () => {
      throw new Error("target provider unavailable");
    });

    await expect(captureBrowserSessionTarget(page)).resolves.toMatchObject({
      kind: "cdp-target",
      target_id: "cdp-fallback",
      target_type: "page",
      url: "https://fallback.example",
    });
  });
});
