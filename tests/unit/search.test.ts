/**
 * Unit tests for the BM25 bilingual search engine.
 *
 * Tests cover:
 *   - Tokenizer (Chinese, English, mixed-script)
 *   - Alias expansion (site aliases, action verbs, domain terms)
 *   - BM25 search accuracy (bilingual queries, category routing)
 *   - Edge cases (empty query, no results, single char)
 */

import { describe, it, expect } from "vitest";
import {
  tokenizeQuery,
  expandToken,
  isCJKChar,
} from "../../src/discovery/aliases.js";
import { search, buildIndex } from "../../src/discovery/search.js";

// ── Tokenizer Tests ─────────────────────────────────────────────────────────

describe("tokenizeQuery", () => {
  it("tokenizes English correctly", () => {
    const tokens = tokenizeQuery("download video");
    expect(tokens).toContain("download");
    expect(tokens).toContain("video");
  });

  it("tokenizes Chinese correctly", () => {
    const tokens = tokenizeQuery("推特热门");
    expect(tokens).toContain("推特");
    expect(tokens).toContain("热门");
    expect(tokens).toContain("推特热门"); // full phrase
  });

  it("handles mixed Chinese/English", () => {
    const tokens = tokenizeQuery("下载B站视频");
    expect(tokens).toContain("下载");
    expect(tokens).toContain("B站");
    expect(tokens).toContain("视频");
  });

  it("keeps Japanese kana tokens for ACG search", () => {
    const tokens = tokenizeQuery("ゆずソフト 花火 スパークル");
    expect(tokens).toContain("ゆずソフト");
    expect(tokens).toContain("花火");
    expect(tokens).toContain("スパークル");
  });

  it("handles delimiters", () => {
    const tokens = tokenizeQuery("search, trending");
    expect(tokens).toContain("search");
    expect(tokens).toContain("trending");
  });

  it("returns empty for empty input", () => {
    expect(tokenizeQuery("")).toEqual([]);
    expect(tokenizeQuery("   ")).toEqual([]);
  });

  it("normalizes full-width characters to half-width (NFKC)", () => {
    const tokens = tokenizeQuery("Ｔｗｉｔｔｅｒ");
    expect(tokens).toContain("Twitter");
  });

  it("filters English stopwords", () => {
    const tokens = tokenizeQuery("the search for a video");
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("for");
    expect(tokens).not.toContain("a");
    expect(tokens).toContain("search");
    expect(tokens).toContain("video");
  });
});

// ── CJK Detection Tests ───────────────────────────────────────────────────

describe("isCJKChar", () => {
  it("detects basic CJK characters", () => {
    expect(isCJKChar("中")).toBe(true);
    expect(isCJKChar("国")).toBe(true);
  });

  it("detects CJK Extension A characters", () => {
    // U+3400 is CJK Extension A
    expect(isCJKChar("\u3400")).toBe(true);
  });

  it("detects CJK Extension B characters (supplementary plane)", () => {
    // U+2000B — 𠀋 — a CJK Extension B character
    expect(isCJKChar("\u{2000B}")).toBe(true);
    expect(isCJKChar("𠀋")).toBe(true);
  });

  it("detects CJK Compatibility Ideographs", () => {
    // U+F900 is CJK Compatibility Ideographs
    expect(isCJKChar("\uF900")).toBe(true);
  });

  it("detects Japanese kana for ACG query grouping", () => {
    expect(isCJKChar("あ")).toBe(true);
    expect(isCJKChar("ア")).toBe(true);
  });

  it("rejects non-CJK/Japanese characters", () => {
    expect(isCJKChar("A")).toBe(false);
    expect(isCJKChar("1")).toBe(false);
    expect(isCJKChar(" ")).toBe(false);
  });
});

// ── Alias Expansion Tests ───────────────────────────────────────────────────

describe("expandToken", () => {
  it("expands Chinese site aliases", () => {
    const expanded = expandToken("推特");
    expect(expanded).toContain("twitter");
  });

  it("expands action verbs", () => {
    const expanded = expandToken("搜索");
    expect(expanded).toContain("search");
    expect(expanded).toContain("find");
  });

  it("expands domain terms", () => {
    const expanded = expandToken("股票");
    expect(expanded).toContain("stock");
    expect(expanded).toContain("finance");
  });

  it("expands Japanese ACG aliases", () => {
    expect(expandToken("ゆずソフト")).toContain("yuzusoft");
    expect(expandToken("スパークル")).toContain("hanabi");
  });

  it("returns original for unknown tokens", () => {
    const expanded = expandToken("foobar123");
    expect(expanded).toContain("foobar123");
    expect(expanded).toHaveLength(1);
  });
});

// ── Build Index Tests ───────────────────────────────────────────────────────

describe("buildIndex", () => {
  it("builds a valid index from manifest", () => {
    const manifest = {
      sites: {
        twitter: {
          commands: [
            { name: "search", description: "Search tweets" },
            { name: "trending", description: "Get trending topics" },
          ],
        },
        bilibili: {
          commands: [{ name: "download", description: "Download video" }],
        },
      },
    };

    const index = buildIndex(manifest);
    expect(index.N).toBe(3);
    expect(index.documents).toHaveLength(3);
    expect(Object.keys(index.postings).length).toBeGreaterThan(0);
    expect(Object.keys(index.idf).length).toBeGreaterThan(0);
    expect(index.avgDl).toBeGreaterThan(0);
  });

  it("handles empty manifest", () => {
    const index = buildIndex({ sites: {} });
    expect(index.N).toBe(0);
    expect(index.documents).toHaveLength(0);
  });
});

// ── Search Tests (Integration — uses real manifest) ─────────────────────────

describe("search", () => {
  it("finds twitter trending for 推特热门", () => {
    const results = search("推特热门", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].site).toBe("twitter");
    expect(results[0].command).toBe("trending");
  });

  it("finds download commands for 下载视频", () => {
    const results = search("下载视频", 5);
    expect(results.length).toBeGreaterThan(0);
    const commands = results.map((r) => `${r.site}/${r.command}`);
    expect(
      commands.some((c) => c.includes("download") || c.includes("save")),
    ).toBe(true);
  });

  it("finds finance commands for 股票行情", () => {
    const results = search("股票行情", 5);
    expect(results.length).toBeGreaterThan(0);
    const categories = results.map((r) => r.category);
    expect(categories).toContain("finance");
  });

  it("finds bilibili for B站弹幕", () => {
    const results = search("B站弹幕", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].site).toBe("bilibili");
  });

  it("finds commands for English queries", () => {
    const results = search("twitter", 3);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].site).toBe("twitter");
  });

  it("returns empty for nonsensical queries", () => {
    const results = search("xyzzy_nonexistent_term_12345", 5);
    expect(results).toHaveLength(0);
  });

  it("respects limit parameter", () => {
    const results = search("search", 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("returns usage examples", () => {
    const results = search("hackernews", 1);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].usage).toMatch(/^unicli hackernews/);
  });

  it("returns categories", () => {
    const results = search("twitter search", 1);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].category).toBe("social");
  });

  it("returns scores as numbers", () => {
    const results = search("youtube", 3);
    for (const r of results) {
      expect(typeof r.score).toBe("number");
      expect(r.score).toBeGreaterThan(0);
    }
  });

  it("routes browser automation architecture queries to browser operator commands", () => {
    const results = search(
      "browser automation agent mcp cli website control",
      10,
    );
    const commands = results.map((r) => `${r.site}/${r.command}`);

    expect(commands[0]).toBe("browser/evidence");
    expect(commands).toContain("browser/extract");
    expect(commands).toContain("operate/state");
  });

  it("routes run trace evidence queries to recorded run inspection commands", () => {
    const results = search(
      "inspect recorded run trace browser lease evidence",
      5,
    );
    const commands = results.map((r) => `${r.site}/${r.command}`);

    expect(commands).toContain("runs/list");
    expect(commands).toContain("runs/show");
  });

  it("keeps multi-word site names ahead of broader sibling sites", () => {
    const scholar = search("Fetch a Google Scholar citation for a paper", 5);
    const pubDev = search(
      "Use pub dev to Get Dart and Flutter package metadata from pub.dev",
      5,
    );

    expect(scholar.map((r) => `${r.site}/${r.command}`)).toContain(
      "google-scholar/cite",
    );
    expect(pubDev.map((r) => `${r.site}/${r.command}`)).toContain(
      "pub-dev/info",
    );
  });

  it("routes generic academic-paper discovery to scholarly sources", () => {
    const english = search("academic papers", 8);
    const chinese = search("论文搜索", 8);
    const subjectQuery = search("find papers about LLM agents", 8);

    expect(english.slice(0, 5).map((r) => r.category)).toContain("scholarly");
    expect(chinese.slice(0, 5).map((r) => r.category)).toContain("scholarly");
    expect(subjectQuery[0].category).toBe("scholarly");
    expect(english[0].site).not.toBe("nowcoder");
    expect(chinese[0].site).not.toBe("ip-info");
    expect(subjectQuery[0].site).not.toBe("agents");
  });

  it("hard-filters natural-language results when a category is requested", () => {
    const scholarly = search("open access pdf doi citations", 12, {
      category: "scholarly",
    });
    const finance = search("stock price quote market", 12, {
      category: "finance",
    });

    expect(scholarly.length).toBeGreaterThan(0);
    expect(finance.length).toBeGreaterThan(0);
    expect(scholarly.every((result) => result.category === "scholarly")).toBe(
      true,
    );
    expect(finance.every((result) => result.category === "finance")).toBe(true);
    expect(scholarly.map((result) => result.site)).toContain("unpaywall");
    expect(finance.map((result) => result.site)).not.toContain("unpaywall");
  });

  it("keeps paper PDF workflows on scholarly download and PDF readers", () => {
    const results = search("download academic paper pdf", 8);
    const commands = results.slice(0, 5).map((r) => `${r.site}/${r.command}`);

    expect(commands).toEqual(
      expect.arrayContaining(["arxiv/download", "pdf/read"]),
    );
    expect(results.slice(0, 5).map((r) => r.site)).not.toContain("yt-dlp");
    expect(results.slice(0, 5).map((r) => r.site)).not.toContain("nowcoder");
  });

  it("routes top-conference proceedings queries to scholarly sources", () => {
    const pmlr = search("PMLR ICML proceedings", 8);
    const cvpr = search("CVPR 2024 papers", 8);
    const acl = search("ACL anthology paper", 8);

    expect(pmlr.length).toBeGreaterThan(0);
    expect(pmlr[0].category).toBe("scholarly");
    expect(cvpr[0].category).toBe("scholarly");
    expect(acl[0].category).toBe("scholarly");
    expect(pmlr[0].site).toBe("pmlr");
    expect(cvpr[0].site).toBe("cvf");
    expect(acl[0].site).toBe("acl-anthology");
  });

  it("routes DOI and open-access PDF queries to DOI-aware scholarly sources", () => {
    const doi = search("doi metadata for 10.1038/nature12373", 8);
    const pdf = search("open access pdf for doi", 8);

    expect(doi[0].site).toBe("crossref");
    expect(pdf.slice(0, 3).map((r) => r.site)).toContain("unpaywall");
  });

  it("routes romaji and Japanese ACG entity queries to ACG sources", () => {
    const hanabi = search("hanabi sparkle star rail", 8);
    expect(hanabi.map((r) => r.site)).toEqual(
      expect.arrayContaining(["moegirl", "anilist"]),
    );

    const yuzusoft = search("ゆずソフト visual novel", 8);
    expect(yuzusoft.map((r) => r.site)).toContain("vndb");
  });

  it("does not treat ACG entity names as hard site aliases", () => {
    const results = search("weather sparkle forecast", 5);
    expect(`${results[0].site}/${results[0].command}`).toBe("wttr/forecast");
  });

  it("keeps anime freshness queries on ACG media sources", () => {
    const results = search("2026 anime trending", 8);
    const commands = results.map((r) => `${r.site}/${r.command}`);

    expect(commands.slice(0, 4)).toEqual(
      expect.arrayContaining(["anilist/anime", "jikan/anime"]),
    );
    expect(commands.slice(0, 4)).not.toEqual(
      expect.arrayContaining(["sinablog/hot", "coupang/hot"]),
    );
  });

  it("does not route generic game trend queries to ACG media sources", () => {
    const results = search("hot game", 5);
    const commands = results.map((r) => `${r.site}/${r.command}`);

    expect(results[0].site).toBe("steam");
    expect(commands.slice(0, 3)).not.toEqual(
      expect.arrayContaining(["dlsite/game", "bangumi/game"]),
    );
  });

  it("routes Japanese booru illustration tag queries to booru sources", () => {
    const results = search("ブルーアーカイブ tag イラスト booru", 8);
    const commands = results.map((r) => `${r.site}/${r.command}`);

    expect(commands.slice(0, 5)).toEqual(
      expect.arrayContaining(["danbooru/tags"]),
    );
    expect(commands).toEqual(
      expect.arrayContaining(["safebooru/search", "konachan/tags"]),
    );
  });

  it("routes recent Japanese idol game queries to ACG game sources", () => {
    const results = search("学園アイドルマスター 2024 character", 8);
    const commands = results.map((r) => `${r.site}/${r.command}`);

    expect(commands).toContain("bangumi/game");
    expect(commands).not.toContain("indeed/job");
  });

  it("routes Japanese ACG creator queries to manga and anime creator sources", () => {
    const results = search("藤本タツキ author manga", 8);
    const commands = results.map((r) => `${r.site}/${r.command}`);

    expect(commands.slice(0, 5)).toEqual(
      expect.arrayContaining(["mangadex/authors"]),
    );
    expect(commands).toEqual(
      expect.arrayContaining(["anilist/staff", "jikan/people"]),
    );
    expect(commands.slice(0, 5)).not.toEqual(
      expect.arrayContaining(["pubmed/author", "arxiv/author"]),
    );
  });
});
