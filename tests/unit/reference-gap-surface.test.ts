import { describe, expect, it } from "vitest";
import { loadAllAdapters, loadTsAdapters } from "../../src/discovery/loader.js";
import { getAdapter } from "../../src/registry.js";

const EXPECTED: Record<string, string[]> = {
  "51job": ["company", "detail", "hot", "search"],
  eastmoney: [
    "announcement",
    "convertible",
    "etf",
    "holders",
    "hot-rank",
    "index-board",
    "kline",
    "kuaixun",
    "longhu",
    "money-flow",
    "northbound",
    "quote",
    "rank",
    "sectors",
  ],
  nowcoder: [
    "companies",
    "creators",
    "detail",
    "experience",
    "hot",
    "jobs",
    "notifications",
    "papers",
    "practice",
    "recommend",
    "referral",
    "salary",
    "search",
    "suggest",
    "topics",
    "trending",
  ],
  uiverse: ["code", "preview"],
};

describe("reference gap adapter surfaces", () => {
  it("registers the high-priority missing command surfaces", async () => {
    loadAllAdapters();
    await loadTsAdapters();

    for (const [site, expectedCommands] of Object.entries(EXPECTED)) {
      const adapter = getAdapter(site);
      expect(adapter, `${site} adapter`).toBeDefined();
      expect(Object.keys(adapter!.commands).sort()).toEqual(
        expect.arrayContaining(expectedCommands),
      );
    }
  });
});
