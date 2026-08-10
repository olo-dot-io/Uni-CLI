import { describe, expect, it } from "vitest";

import { SiteResolver } from "../../src/discovery/site-resolver.js";

describe("SiteResolver", () => {
  it("resolves canonical ids, maintained aliases, and multi-word names", () => {
    const resolver = new SiteResolver(["twitter", "bilibili", "hackernews"]);

    expect(resolver.resolve("推特搜索", ["推特", "搜索"]).exact).toEqual([
      "twitter",
    ]);
    expect(
      resolver.resolve("read Hacker News", ["read", "Hacker", "News"]).phrase,
    ).toContain("hackernews");
  });

  it("uses symmetric-delete candidates for unique bounded typos", () => {
    const resolver = new SiteResolver(["twitter", "bilibili"]);

    expect(
      resolver.resolve("twiter search", ["twiter", "search"]).fuzzy,
    ).toEqual([
      {
        site: "twitter",
        token: "twiter",
        matched: "twitter",
        distance: 1,
      },
    ]);
    expect(resolver.resolve("bilibi hot", ["bilibi", "hot"]).fuzzy).toEqual([
      {
        site: "bilibili",
        token: "bilibi",
        matched: "bilibili",
        distance: 2,
      },
    ]);
  });

  it("rejects an ambiguous nearest provider", () => {
    const resolver = new SiteResolver(["twitter", "twister"]);

    expect(
      resolver.resolve("twiter search", ["twiter", "search"]).fuzzy,
    ).toEqual([]);
  });
});
