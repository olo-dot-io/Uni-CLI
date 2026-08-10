/**
 * Unit tests for the BM25 bilingual search engine.
 *
 * Tests cover:
 *   - Tokenizer (Chinese, English, mixed-script)
 *   - Alias expansion (site aliases, action verbs, domain terms)
 *   - BM25 search accuracy (bilingual queries, category routing)
 *   - Edge cases (empty query, no results, single char)
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  tokenizeQuery,
  expandToken,
  isCJKChar,
  strictMap,
} from "../../src/discovery/aliases.js";
import {
  search,
  searchDocuments,
  buildIndexFromDocuments,
  invalidateCache,
} from "../../src/discovery/search.js";
import { registerAdapter } from "../../src/registry.js";
import { AdapterType } from "../../src/types.js";
import { loadAllAdapters, loadTsAdapters } from "../../src/discovery/loader.js";

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

describe("strictMap", () => {
  it("throws at construction on a duplicate key", () => {
    // Regression lock for the 行情 incident: a duplicated Map-literal key
    // silently dropped a synonym list; alias tables must fail loudly.
    expect(() =>
      strictMap([
        ["行情", ["quote"]],
        ["行情", ["ticker"]],
      ]),
    ).toThrow(/Duplicate alias key: 行情/);
  });
});

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

describe("buildIndexFromDocuments", () => {
  it("builds a valid index from command documents", () => {
    const index = buildIndexFromDocuments([
      { site: "twitter", command: "search", description: "Search tweets" },
      {
        site: "twitter",
        command: "trending",
        description: "Get trending topics",
      },
      {
        site: "bilibili",
        command: "download",
        description: "Download video",
      },
    ]);

    expect(index.N).toBe(3);
    expect(index.documents).toHaveLength(3);
    expect(index.postings.size).toBeGreaterThan(0);
    expect(index.idf.size).toBeGreaterThan(0);
    expect(index.avgDl).toBeGreaterThan(0);
  });

  it("aligns posting frequencies without retaining candidate-local TF maps", () => {
    const index = buildIndexFromDocuments([
      {
        site: "frequency-probe",
        command: "search-search",
        description: "Search the searchable search catalog",
      },
      {
        site: "frequency-probe",
        command: "read",
        description: "Read the catalog",
      },
    ]);
    const postings = index.postings.get("search")!;
    const frequencies = index.frequencies.get("search")!;

    expect(frequencies).toHaveLength(postings.length);
    expect(frequencies[postings.indexOf(0)]).toBe(4);
    expect(frequencies[postings.indexOf(1)]).toBeUndefined();
    expect(index.documents[0].tfidfNorm).toBeGreaterThan(0);
    expect(index.documents[0].bm25LengthNorm).toBeGreaterThan(0);
  });

  it("handles empty command documents", () => {
    const index = buildIndexFromDocuments([]);
    expect(index.N).toBe(0);
    expect(index.documents).toHaveLength(0);
  });

  it("invalidates prepared tokens when document content changes", () => {
    const document = {
      site: "cache-probe",
      command: "inspect",
      description: "Original zephyr marker",
    };
    expect(buildIndexFromDocuments([document]).postings.has("zephyr")).toBe(
      true,
    );

    document.description = "Updated quasar marker";
    const rebuilt = buildIndexFromDocuments([document]);

    expect(rebuilt.postings.has("quasar")).toBe(true);
    expect(rebuilt.postings.has("zephyr")).toBe(false);
  });

  it("indexes hostile user-controlled identity tokens without prototype collisions", () => {
    const documents = [
      {
        site: "__proto__",
        command: "constructor",
        description: "Hostile identity regression sentinel",
      },
      {
        site: "constructor",
        command: "__proto__",
        description: "Second hostile identity regression sentinel",
      },
    ];
    const index = buildIndexFromDocuments(documents);

    expect(index.postings.get("__proto__")).toEqual(expect.any(Array));
    expect(index.postings.get("constructor")).toEqual(expect.any(Array));
    expect(
      searchDocuments(documents, "hostile identity sentinel", 2),
    ).toHaveLength(2);
  });
});

// ── Search Tests (Integration — uses real registry) ─────────────────────────

describe("search", () => {
  beforeAll(async () => {
    loadAllAdapters();
    await loadTsAdapters();
    invalidateCache();
  });

  it("discovers commands registered after build time through the live registry", () => {
    registerAdapter({
      name: "runtime-only-discovery",
      type: AdapterType.WEB_API,
      category: "dev",
      commands: {
        probe: {
          name: "probe",
          description: "Runtime-only zetaquartz command discovery probe",
          adapter_path: "src/adapters/runtime-only-discovery/probe.yaml",
        },
      },
    });
    invalidateCache();

    const results = search("zetaquartz command discovery", 3);

    expect(results[0]).toMatchObject({
      site: "runtime-only-discovery",
      command: "probe",
      category: "dev",
    });
  });

  it("finds twitter trending for 推特热门", () => {
    const results = search("推特热门", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].site).toBe("twitter");
    expect(results[0].command).toBe("trending");
  });

  it("down-weights Shortcuts app-action inventory for generic system intents", () => {
    const corpus = [
      {
        site: "macos",
        command: "battery",
        description: "Get battery status and charge level",
        category: "desktop",
      },
      {
        site: "macos",
        command: "app-action-shortcuts-get-battery-status",
        description:
          "Shortcuts app action Shortcuts / Get Battery Status. Gets the battery status.",
        category: "desktop",
      },
      {
        site: "macos",
        command: "app-action-system-settings-open-battery-settings",
        description:
          "Shortcuts app action System Settings / Open Battery Settings.",
        category: "desktop",
      },
    ];

    const generic = searchDocuments(corpus, "battery status", 3);
    expect(generic[0].command).toBe("battery");

    const explicit = searchDocuments(corpus, "shortcuts battery status", 3);
    const shortcutsAction = explicit.find((result) =>
      result.command.startsWith("app-action-"),
    );
    expect(shortcutsAction).toBeDefined();
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

  it.each([
    "NVLink bandwidth and NVSwitch topology",
    "平头哥 含光 昆仑芯 寒武纪 加速卡算子",
    "PagedAttention RoPE YaRN world model",
  ])("discovers the unified AI intelligence entry for %s", (query) => {
    const commands = search(query, 5).map(
      (result) => `${result.site}/${result.command}`,
    );

    expect(commands).toContain("ai/search");
  });

  it("finds bilibili for B站弹幕", () => {
    const results = search("B站弹幕", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].site).toBe("bilibili");
  });

  it("routes listen-to-song intents to executable audio playback commands", () => {
    const results = search("我想听 I really wanna stay at your house", 5);
    const commands = results.map((r) => `${r.site}/${r.command}`);

    expect(results[0]).toMatchObject({
      site: "spotify",
      command: "play-track",
      category: "audio",
    });
    expect(commands).not.toContain("ctrip/hotel-search");
  });

  it("prefers track playback over generic desktop play when a Spotify song query is explicit", () => {
    const results = search("play I really wanna stay at your house spotify", 5);

    expect(results[0]).toMatchObject({
      site: "spotify",
      command: "play-track",
    });
  });

  it("keeps hotel stay queries in the travel domain", () => {
    const results = search(
      "search Ctrip hotels for a weekend stay in Shanghai",
      5,
    );

    expect(results[0]).toMatchObject({
      site: "ctrip",
      command: "hotel-search",
      category: "travel",
    });
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

  it("routes Twitter/X user timeline intent to the user timeline command", () => {
    const results = search("X user timeline", 3);

    expect(results[0]).toMatchObject({
      site: "twitter",
      command: "user-timeline",
    });
  });

  it("routes Marxism philosophy archive queries to marxists-cn", () => {
    const results = search("马克思主义 哲学 文库 检索", 5);
    const commands = results.map((r) => `${r.site}/${r.command}`);

    expect(commands.slice(0, 3)).toEqual(
      expect.arrayContaining(["marxists-cn/search"]),
    );
    expect(results.find((r) => r.site === "marxists-cn")?.category).toBe(
      "reference",
    );
  });

  it("routes Western Marxism reading-list intent to marxists-cn", () => {
    const results = search("读 西马 著名人物 著名著作", 5);

    expect(results[0]).toMatchObject({
      site: "marxists-cn",
      command: "western-marxism",
    });
    expect(results.map((r) => `${r.site}/${r.command}`)).toContain(
      "marxists-cn/reading-list",
    );
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

  it("routes self-repair delivery loop queries to delivery operator commands", () => {
    const results = search(
      "closed loop delivery trajectory self repair next experiment",
      8,
    );
    const commands = results.map((r) => `${r.site}/${r.command}`);

    expect(commands[0]).toBe("delivery/trajectory");
    expect(commands).toContain("delivery/assess");
    expect(commands).toContain("delivery/repair-candidate");
  });

  it("routes executable next-experiment queries to delivery run", () => {
    const results = search("execute the next delivery experiment", 5);
    const commands = results.map((r) => `${r.site}/${r.command}`);

    expect(commands[0]).toBe("delivery/run");
  });

  it("routes local computer-use context capture queries to compute capture", () => {
    const results = search(
      "local computer use capture accessibility screenshot app shots reference",
      8,
    );
    const commands = results.map((r) => `${r.site}/${r.command}`);

    expect(commands[0]).toBe("compute/capture");
    expect(commands).toContain("compute/snapshot");
    expect(commands).toContain("compute/screenshot");
    expect(results[0].category).toBe("desktop");
  });

  it("routes app-shot handoff queries to compute capture", () => {
    const results = search("app shots", 5);
    const commands = results.map((r) => `${r.site}/${r.command}`);

    expect(commands[0]).toBe("compute/capture");
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
      expect.arrayContaining([
        "scholar/download",
        "arxiv/download",
        "pdf/read",
      ]),
    );
    expect(results.slice(0, 5).map((r) => r.site)).not.toContain("yt-dlp");
    expect(results.slice(0, 5).map((r) => r.site)).not.toContain("nowcoder");
  });

  it.each([
    "federated cross-domain retrieval providers current records",
    "通用跨行业实时检索来源",
  ])("discovers the generic retrieval surface for %s", (query) => {
    expect(search(query, 5)[0]).toMatchObject({
      site: "retrieval",
      command: "search",
    });
  });

  it("routes academic full-text reading to the scholar meta-command", () => {
    const results = search("read academic paper pdf full text", 8);
    const commands = results.slice(0, 5).map((r) => `${r.site}/${r.command}`);

    expect(commands).toContain("scholar/read");
    expect(results.slice(0, 5).map((r) => r.category)).toContain("scholarly");
  });

  it("routes paper code and dataset resource queries to scholar resources", () => {
    const code = search("find code for academic paper", 8);
    const datasets = search("datasets and models for a paper", 8);

    expect(code.slice(0, 5).map((r) => `${r.site}/${r.command}`)).toContain(
      "scholar/code",
    );
    expect(datasets.slice(0, 5).map((r) => `${r.site}/${r.command}`)).toContain(
      "scholar/datasets",
    );
  });

  it("keeps compound conference-paper discovery on the venue workflow", () => {
    const results = search(
      "find PPoPP 2025 papers exact title DOI PDF code dataset",
      8,
    );

    expect(results[0]).toMatchObject({ site: "scholar", command: "venue" });
    expect(results.slice(0, 5)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ site: "scholar", command: "code" }),
        expect.objectContaining({ site: "scholar", command: "datasets" }),
      ]),
    );
  });

  it("routes paper reproducibility and install planning to scholar reproduce", () => {
    const english = search(
      "install and reproduce academic paper code environment",
      8,
    );
    const chinese = search("论文复现和代码安装运行环境", 8);

    expect(english[0]).toMatchObject({
      site: "scholar",
      command: "reproduce",
    });
    expect(chinese[0]).toMatchObject({
      site: "scholar",
      command: "reproduce",
    });
  });

  it("routes paper availability queries to scholar availability", () => {
    const english = search(
      "audit paper availability pdf code datasets reviews citations",
      8,
    );
    const chinese = search("审计论文资源是否可读", 8);

    expect(english[0]).toMatchObject({
      site: "scholar",
      command: "availability",
    });
    expect(chinese[0]).toMatchObject({
      site: "scholar",
      command: "availability",
    });
  });

  it("routes anti-hallucination evidence classification to scholar evidence", () => {
    const english = search(
      "classify paper evidence citation safety before quoting claims",
      8,
    );
    const chinese = search("文献证据分级和引用安全，避免幻觉文献", 8);

    expect(english[0]).toMatchObject({
      site: "scholar",
      command: "evidence",
    });
    expect(chinese[0]).toMatchObject({
      site: "scholar",
      command: "evidence",
    });
  });

  it("routes scholarly closed-loop workflow queries to scholar workflow", () => {
    const english = search(
      "academic paper closed-loop workflow runbook for agent reading",
      8,
    );
    const chinese = search("学术资源完整闭环工作流", 8);

    expect(english[0]).toMatchObject({
      site: "scholar",
      command: "workflow",
    });
    expect(chinese[0]).toMatchObject({
      site: "scholar",
      command: "workflow",
    });
  });

  it("routes per-source scholarly comparison queries to scholar sources", () => {
    const english = search(
      "which academic sources have pdf code reviews for this paper",
      8,
    );
    const chinese = search("论文来源逐站点对比", 8);

    expect(english[0]).toMatchObject({
      site: "scholar",
      command: "sources",
    });
    expect(chinese[0]).toMatchObject({
      site: "scholar",
      command: "sources",
    });
  });

  it("routes scholarly source coverage and gap queries to scholar coverage", () => {
    const english = search(
      "compare academic source coverage gaps for papers",
      8,
    );
    const chinese = search("学术网站覆盖矩阵和来源对比", 8);

    expect(english[0]).toMatchObject({
      site: "scholar",
      command: "coverage",
    });
    expect(chinese[0]).toMatchObject({
      site: "scholar",
      command: "coverage",
    });
  });

  it("routes peer-review and decision queries to scholar reviews", () => {
    const english = search(
      "read peer reviews and decision for openreview paper",
      8,
    );
    const chinese = search("读取论文审稿意见和接收决定", 8);

    expect(english[0]).toMatchObject({
      site: "scholar",
      command: "reviews",
    });
    expect(chinese[0]).toMatchObject({
      site: "scholar",
      command: "reviews",
    });
  });

  it("routes cross-site award and review linking to scholar trace", () => {
    const english = search(
      "link official best paper announcement to OpenReview reviews and PDF",
      8,
    );
    const chinese = search("跨站追踪最佳论文奖项、评审和 PDF", 8);

    expect(english[0]).toMatchObject({ site: "scholar", command: "trace" });
    expect(chinese[0]).toMatchObject({ site: "scholar", command: "trace" });
  });

  it("routes official conference award lookup to scholar awards", () => {
    const english = search("ACM CHI 2026 official best paper awards", 8);
    const chinese = search("查询 CHI 2026 官方最佳论文奖项", 8);

    expect(english[0]).toMatchObject({ site: "sigchi", command: "awards" });
    expect(["sigchi", "scholar"]).toContain(chinese[0].site);
    expect(chinese[0].command).toBe("awards");
    expect(english.slice(0, 5).map((result) => result.site)).toContain(
      "sigchi",
    );
  });

  it("routes ICLR award and rebuttal lookup to the official announcement adapter", () => {
    const results = search(
      "ICLR 2025 official outstanding paper OpenReview rebuttal",
      8,
    );

    expect(results[0]).toMatchObject({ site: "scholar", command: "trace" });
    expect(results.slice(0, 3)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ site: "iclr", command: "awards" }),
      ]),
    );
    expect(results.slice(0, 5)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ site: "scholar", command: "trace" }),
      ]),
    );
  });

  it("routes CCF A classification and directory lookup to the official catalog", () => {
    const classification = search("Is ICLR a 2026 CCF A conference", 8);
    const directory = search("CCF 推荐 A 类会议目录", 8);
    const renamed = search("USENIX ATC CCF A new name", 8);

    expect(classification[0]).toMatchObject({
      site: "ccf",
      command: "conference",
    });
    expect(directory[0]).toMatchObject({
      site: "ccf",
      command: "conferences",
    });
    expect(renamed.slice(0, 3)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ site: "ccf", command: "conference" }),
      ]),
    );
  });

  it("routes IEEE conference metadata to IEEE academic adapters", () => {
    const results = search("IEEE Xplore conference papers", 8);
    expect(results.slice(0, 5).map((result) => result.site)).toEqual(
      expect.arrayContaining(["ieee-xplore", "ieee"]),
    );
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

  it("routes compact CCF A venue aliases to a proceedings-capable command", () => {
    const expected = new Map<string, [string, string]>([
      ["AAAI 2025 official conference papers", ["aaai", "papers"]],
      ["ACMMM 2024 conference papers", ["acm", "venue"]],
      ["SIGGRAPH 2024 conference papers", ["acm", "venue"]],
      ["IEEEVIS conference papers", ["ieee", "venue"]],
      ["UbiComp conference journal papers", ["sigchi", "papers"]],
      ["PACM IMWUT ubiquitous computing papers", ["sigchi", "papers"]],
      ["RTSS real-time systems conference papers", ["ieee", "venue"]],
    ]);

    for (const [query, [site, command]] of expected) {
      expect(search(query, 5)[0]).toMatchObject({ site, command });
    }
  });

  it("routes USENIX proceedings and award queries to the first-party adapter", () => {
    expect(search("FAST 2025 USENIX papers", 8)[0]).toMatchObject({
      site: "usenix",
      command: "venue",
    });
    expect(
      search("USENIX Security 2025 best paper official", 8).slice(0, 3),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ site: "usenix", command: "awards" }),
      ]),
    );
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
