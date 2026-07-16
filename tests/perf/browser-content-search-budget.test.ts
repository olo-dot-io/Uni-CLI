import { afterEach, describe, expect, it, vi } from "vitest";

import { searchChromeContent } from "../../extension/src/content-search.js";

const TAB_BUDGET_P95_MS = 100;
const RESULT_WIRE_BUDGET_BYTES = 96_000;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Chrome content-search performance budget", () => {
  it("keeps the maximum 200-tab orchestration and output inside fixed budgets", async () => {
    installChrome(200);
    await runSearch(20);

    const samples: number[] = [];
    let lastResult: Awaited<ReturnType<typeof runSearch>> | undefined;
    for (let index = 0; index < 10; index += 1) {
      const started = performance.now();
      lastResult = await runSearch(20);
      samples.push(performance.now() - started);
    }

    expect(percentile(samples, 0.95)).toBeLessThan(TAB_BUDGET_P95_MS);
    expect(lastResult?.scanned_open_tabs).toBe(200);
    expect(lastResult?.results).toHaveLength(20);
    expect(Buffer.byteLength(JSON.stringify(lastResult))).toBeLessThan(
      RESULT_WIRE_BUDGET_BYTES,
    );
  });

  it("scales with bounded selected tabs rather than total browser history", async () => {
    installChrome(200);
    const small = await medianRuntime(10, 8);
    const large = await medianRuntime(200, 8);

    expect(large).toBeLessThan(Math.max(25, small * 25));
  });
});

async function medianRuntime(
  maxTabs: number,
  samples: number,
): Promise<number> {
  await runSearch(10, maxTabs);
  const values: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    await runSearch(10, maxTabs);
    values.push(performance.now() - started);
  }
  return percentile(values, 0.5);
}

function runSearch(maxResults: number, maxTabs = 200) {
  return searchChromeContent(
    {
      query: "runtime",
      max_results: maxResults,
      max_tabs: maxTabs,
      max_chars_per_tab: 4_096,
    },
    {
      capture: async () => ({ focused: 7, active: 1 }),
      assertUnchanged: async () => undefined,
    },
  );
}

function installChrome(tabCount: number): void {
  const tabs = Array.from({ length: tabCount }, (_, index) => ({
    id: index + 1,
    windowId: 7,
    active: index === 0,
    url: `https://tab-${String(index + 1)}.example/runtime`,
    title: `Runtime ${String(index + 1)}`,
    lastAccessed: tabCount - index,
  }));
  vi.stubGlobal("chrome", {
    windows: { getAll: async () => [{ id: 7, type: "normal" }] },
    tabs: { query: async () => tabs },
    webNavigation: {
      getAllFrames: async ({ tabId }: { tabId: number }) => [
        {
          frameId: 0,
          parentFrameId: -1,
          url: `https://tab-${String(tabId)}.example/runtime`,
        },
      ],
    },
    scripting: {
      executeScript: async ({ target }: { target: { tabId: number } }) => [
        {
          frameId: 0,
          result: {
            scanned_chars: 4_096,
            scanned_nodes: 80,
            truncated: false,
            exact_query_match: true,
            matched_terms: 1,
            matched_term_indexes: [0],
            match_count: 2,
            snippets: [`runtime evidence ${String(target.tabId)}`],
          },
        },
      ],
    },
  });
}

function percentile(samples: readonly number[], ratio: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * ratio) - 1,
  );
  return sorted[index] ?? 0;
}
