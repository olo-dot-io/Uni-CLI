import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ChromeContentSearchError,
  searchChromeContent,
} from "../../../extension/src/content-search.js";

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Chrome content search", () => {
  it("merges open-tab content with bounded history metadata without debugger attachment", async () => {
    const executeScript = vi.fn(
      async ({ target }: { target: { tabId: number } }) => [
        {
          frameId: 0,
          result: pageResult(
            target.tabId === 10 ? ["…Apollo browser runtime evidence…"] : [],
          ),
        },
      ],
    );
    const historySearch = vi.fn().mockResolvedValue([
      {
        id: "history-1",
        url: "https://example.test/apollo",
        title: "Apollo reference",
        lastVisitTime: 200,
        visitCount: 4,
      },
    ]);
    const debuggerAttach = vi.fn();
    installChrome({ executeScript, historySearch, debuggerAttach });
    const ui = uiBoundary();

    const result = await searchChromeContent(
      {
        query: "Apollo",
        include_history: true,
        max_results: 5,
        max_tabs: 2,
        max_chars_per_tab: 4_096,
      },
      ui,
    );

    expect(result).toMatchObject({
      query: "Apollo",
      result_count: 1,
      eligible_open_tabs: 2,
      scanned_open_tabs: 2,
      matched_open_tabs: 1,
      failed_open_tabs: 0,
      scanned_history_items: 1,
      matched_history_items: 1,
      ui_state_unchanged: true,
      limits: { tab_concurrency: 4 },
      results: [
        {
          sources: ["open_tab", "history"],
          url: "https://example.test/apollo",
          match_fields: ["title", "url", "content"],
          snippets: ["…Apollo browser runtime evidence…"],
          tab_id: 10,
          last_visit_time: 200,
        },
      ],
    });
    expect(executeScript).toHaveBeenCalledTimes(2);
    expect(historySearch).toHaveBeenCalledWith({
      text: "Apollo",
      startTime: 0,
      maxResults: 25,
    });
    expect(debuggerAttach).not.toHaveBeenCalled();
    expect(ui.assertUnchanged).toHaveBeenCalledOnce();
  });

  it("deduplicates repeated open-tab URLs without multiplying their rank", async () => {
    installChrome({
      tabs: [
        {
          id: 10,
          windowId: 7,
          active: true,
          url: "https://duplicate.test/needle",
          title: "Needle",
          lastAccessed: 100,
        },
        {
          id: 11,
          windowId: 7,
          active: false,
          url: "https://duplicate.test/needle",
          title: "Needle",
          lastAccessed: 90,
        },
        {
          id: 12,
          windowId: 7,
          active: false,
          url: "https://single.test/needle",
          title: "Needle",
          lastAccessed: 80,
        },
      ],
      executeScript: vi
        .fn()
        .mockResolvedValue([{ frameId: 0, result: pageResult([]) }]),
    });

    const result = await searchChromeContent(
      { query: "needle", max_results: 3, max_tabs: 3 },
      uiBoundary(),
    );

    expect(result.results).toHaveLength(2);
    expect(result.results.map(({ score }) => score)).toEqual([240, 240]);
    expect(result.results[0]?.url).toBe("https://duplicate.test/needle");
    expect(result.results[1]?.url).toBe("https://single.test/needle");
  });

  it("searches bounded cross-origin frame worlds under one per-tab character budget", async () => {
    const frames = Array.from({ length: 40 }, (_, frameId) => ({
      frameId,
      parentFrameId: frameId === 0 ? -1 : 0,
      url:
        frameId === 0
          ? "https://example.test/"
          : `https://frame-${String(frameId)}.other/`,
    }));
    const getAllFrames = vi.fn().mockResolvedValue(frames);
    const executeScript = vi.fn(
      async ({
        target,
        args,
      }: {
        target: { tabId: number; frameIds?: number[] };
        args: Array<{ max_chars: number }>;
      }) =>
        (target.frameIds ?? []).map((frameId) => ({
          frameId,
          result: pageResult(
            frameId === 7 ? ["cross-origin needle"] : [],
            args[0]!.max_chars,
          ),
        })),
    );
    installChrome({
      executeScript,
      getAllFrames,
      tabs: [
        {
          id: 10,
          windowId: 7,
          active: true,
          url: "https://example.test/",
          title: "Example",
        },
      ],
    });

    const result = await searchChromeContent(
      {
        query: "needle",
        max_results: 5,
        max_tabs: 1,
        max_chars_per_tab: 4_096,
      },
      uiBoundary(),
    );

    expect(getAllFrames).toHaveBeenCalledWith({ tabId: 10 });
    expect(executeScript).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        target: { tabId: 10, frameIds: [0] },
        args: [expect.objectContaining({ max_chars: 128 })],
      }),
    );
    expect(executeScript).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        target: {
          tabId: 10,
          frameIds: Array.from({ length: 31 }, (_, index) => index + 1),
        },
        args: [expect.objectContaining({ max_chars: 128 })],
      }),
    );
    expect(result).toMatchObject({
      matched_open_tabs: 1,
      truncated: true,
      limits: { max_frames_per_tab: 32 },
      results: [
        {
          tab_id: 10,
          match_fields: ["content"],
          snippets: ["cross-origin needle"],
        },
      ],
    });
  });

  it("keeps a main-frame match when a secondary frame disappears during injection", async () => {
    const executeScript = vi.fn(
      async ({ target }: { target: { frameIds?: number[] } }) => {
        if (target.frameIds?.length === 1 && target.frameIds[0] === 0) {
          return [
            {
              frameId: 0,
              result: pageResult(["main-frame needle remains readable"]),
            },
          ];
        }
        throw new Error("No frame with id 7 in tab");
      },
    );
    installChrome({
      executeScript,
      getAllFrames: vi.fn().mockResolvedValue([
        { frameId: 0, parentFrameId: -1, url: "https://example.test/" },
        { frameId: 7, parentFrameId: 0, url: "https://frame.test/" },
      ]),
      tabs: [
        {
          id: 10,
          windowId: 7,
          active: true,
          url: "https://example.test/",
          title: "Example",
        },
      ],
    });

    const result = await searchChromeContent(
      { query: "needle", max_tabs: 1, max_chars_per_tab: 4_096 },
      uiBoundary(),
    );

    expect(executeScript).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      scanned_open_tabs: 1,
      matched_open_tabs: 1,
      failed_open_tabs: 0,
      truncated: true,
      results: [
        {
          tab_id: 10,
          match_fields: ["content"],
          snippets: ["main-frame needle remains readable"],
        },
      ],
    });
  });

  it("caps simultaneous tab reads at four while preserving input order", async () => {
    let active = 0;
    let peak = 0;
    const executeScript = vi.fn(
      async ({ target }: { target: { tabId: number } }) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return [
          {
            frameId: 0,
            result: pageResult([`needle on tab ${String(target.tabId)}`]),
          },
        ];
      },
    );
    installChrome({
      executeScript,
      tabs: Array.from({ length: 12 }, (_, index) => ({
        id: index + 1,
        windowId: 7,
        active: index === 0,
        url: `https://tab-${String(index + 1)}.test/`,
        title: `Tab ${String(index + 1)}`,
        lastAccessed: 100 - index,
      })),
    });

    const result = await searchChromeContent(
      { query: "needle", max_results: 20, max_tabs: 12 },
      uiBoundary(),
    );

    expect(peak).toBe(4);
    expect(result.scanned_open_tabs).toBe(12);
    expect(result.matched_open_tabs).toBe(12);
    expect(result.results).toHaveLength(12);
  });

  it("returns typed bounded partial failures for unreadable tabs", async () => {
    const executeScript = vi.fn(
      async ({ target }: { target: { tabId: number } }) => {
        if (target.tabId === 11) throw new Error("Cannot access page contents");
        return [
          { frameId: 0, result: pageResult(["needle remains readable"]) },
        ];
      },
    );
    installChrome({ executeScript });

    const result = await searchChromeContent(
      { query: "needle", max_tabs: 2 },
      uiBoundary(),
    );

    expect(result).toMatchObject({
      scanned_open_tabs: 2,
      matched_open_tabs: 1,
      failed_open_tabs: 1,
      failures: [
        {
          source: "open_tab",
          tab_id: 11,
          code: "chrome_tab_content_unavailable",
          message: "Cannot access page contents",
        },
      ],
    });
  });

  it("drops unsupported or unmatched history rows instead of fabricating results", async () => {
    installChrome({
      executeScript: vi
        .fn()
        .mockResolvedValue([{ frameId: 0, result: pageResult([]) }]),
      historySearch: vi.fn().mockResolvedValue([
        { id: "missing-url", title: "needle" },
        { id: "internal", url: "chrome://settings/", title: "needle" },
        {
          id: "unmatched",
          url: "https://example.test/other",
          title: "Other",
        },
      ]),
    });

    const result = await searchChromeContent(
      { query: "needle", include_history: true },
      uiBoundary(),
    );

    expect(result.scanned_history_items).toBe(3);
    expect(result.matched_history_items).toBe(0);
    expect(result.results).toEqual([]);
  });

  it("fails closed when history was requested but its API is unavailable", async () => {
    installChrome({ historyAvailable: false });

    await expect(
      searchChromeContent(
        { query: "needle", include_history: true },
        uiBoundary(),
      ),
    ).rejects.toMatchObject({ code: "chrome_history_unavailable" });
  });

  it("cancels an unsettled isolated-world read without waiting for it", async () => {
    const executeScript = vi.fn(() => new Promise<never>(() => undefined));
    installChrome({ executeScript });
    const controller = new AbortController();
    const cancellation = new Error("cancel federated search");
    const pending = searchChromeContent(
      { query: "needle", max_tabs: 1 },
      uiBoundary(),
      controller.signal,
    );
    await vi.waitFor(() => expect(executeScript).toHaveBeenCalledOnce());
    controller.abort(cancellation);

    await expect(pending).rejects.toBe(cancellation);
  });

  it.each([
    [{ query: "" }, "query must contain"],
    [{ query: "x", max_tabs: 201 }, "max_tabs"],
    [
      { query: "x", history_start_time: 10 },
      "history bounds require include_history",
    ],
    [
      {
        query: "x",
        include_history: true,
        history_start_time: 20,
        history_end_time: 10,
      },
      "must not exceed",
    ],
  ])("rejects invalid search bounds %#", async (query, message) => {
    installChrome({});
    await expect(searchChromeContent(query, uiBoundary())).rejects.toEqual(
      expect.objectContaining<Partial<ChromeContentSearchError>>({
        code: "chrome_content_search_invalid",
        message: expect.stringContaining(message),
      }),
    );
  });
});

function installChrome(input: {
  executeScript?: (...args: never[]) => unknown;
  historySearch?: (...args: never[]) => unknown;
  debuggerAttach?: (...args: never[]) => unknown;
  getAllFrames?: (...args: never[]) => unknown;
  tabs?: Array<Record<string, unknown>>;
  historyAvailable?: boolean;
}): void {
  const tabs = input.tabs ?? [
    {
      id: 10,
      windowId: 7,
      active: true,
      url: "https://example.test/apollo",
      title: "Apollo open tab",
      lastAccessed: 100,
    },
    {
      id: 11,
      windowId: 7,
      active: false,
      url: "https://other.test/",
      title: "Other",
      lastAccessed: 90,
    },
    {
      id: 12,
      windowId: 8,
      active: true,
      url: "chrome://settings/",
      title: "Settings",
      lastAccessed: 80,
    },
  ];
  const chrome = {
    windows: {
      getAll: vi.fn().mockResolvedValue([
        { id: 7, type: "normal", focused: true },
        { id: 8, type: "normal", focused: false },
      ]),
    },
    tabs: { query: vi.fn().mockResolvedValue(tabs) },
    scripting: {
      executeScript:
        input.executeScript ??
        vi.fn().mockResolvedValue([{ frameId: 0, result: pageResult([]) }]),
    },
    webNavigation: {
      getAllFrames:
        input.getAllFrames ??
        vi.fn(async ({ tabId }: { tabId: number }) => [
          {
            frameId: 0,
            parentFrameId: -1,
            url: String(
              (
                tabs.find((tab) => tab.id === tabId) as
                  | { url?: unknown }
                  | undefined
              )?.url ?? "",
            ),
          },
        ]),
    },
    ...(input.historyAvailable === false
      ? {}
      : {
          history: {
            search: input.historySearch ?? vi.fn().mockResolvedValue([]),
          },
        }),
    debugger: { attach: input.debuggerAttach ?? vi.fn() },
  };
  vi.stubGlobal("chrome", chrome);
}

function uiBoundary() {
  return {
    capture: vi.fn().mockResolvedValue({ active: 10 }),
    assertUnchanged: vi.fn().mockResolvedValue(undefined),
  };
}

function pageResult(snippets: string[], scannedChars = 100) {
  return {
    scanned_chars: scannedChars,
    scanned_nodes: 20,
    truncated: false,
    exact_query_match: snippets.length > 0,
    matched_terms: snippets.length > 0 ? 1 : 0,
    matched_term_indexes: snippets.length > 0 ? [0] : [],
    match_count: snippets.length,
    snippets,
  };
}
