import { beforeAll, describe, expect, it } from "vitest";

import {
  canonicalizeAiUrl,
  coerceAiContentRecords,
  inferAiVendor,
  inferAiVendors,
  reciprocalRankFuse,
  structureAiDocument,
  type AiContentRecord,
} from "../../../src/commands/ai-content.js";
import {
  listAiSourceCommands,
  listAiLandscapeRows,
  listAiProfileRows,
  searchAiContent,
} from "../../../src/commands/ai.js";
import {
  AI_PRIMARY_SOURCES,
  AI_ROLE_PROFILES,
  AUTHENTICATED_AI_SOURCE_REFS,
  identifyAiPrimarySource,
  selectAiOfficialDomains,
} from "../../../src/commands/ai-landscape.js";
import {
  loadAllAdapters,
  loadTsAdapters,
} from "../../../src/discovery/loader.js";

beforeAll(async () => {
  loadAllAdapters();
  await loadTsAdapters();
});

describe("AI source discovery", () => {
  it("discovers GitHub, Hugging Face, official-doc search, and community commands from capabilities", () => {
    const refs = listAiSourceCommands().map((source) => source.ref);

    expect(refs).toEqual(
      expect.arrayContaining([
        "duckduckgo.search",
        "gh.search-issues",
        "gh.search-prs",
        "gh.discussions",
        "hf.models",
        "hf.datasets",
        "hf.spaces",
        "hf.community",
        "huggingface-papers.search",
        "arxiv.search",
        "semantic-scholar.search",
        "hackernews.search",
        "stackoverflow.search",
        "lobsters.search",
        "openreview.search",
        "openalex.search",
        "crossref.search",
        "acl-anthology.search",
        "modelscope.models",
        "modelscope.datasets",
        "opencsg.models",
        "opencsg.datasets",
        "bluesky.search-posts",
        "youtube.search",
        "twitter.search",
        "reddit.search",
        "linux-do.search",
        "zhihu.search",
        "bilibili.search",
      ]),
    );
  });

  it("exposes the broad primary-source landscape and role-specific daily concerns", () => {
    const profiles = listAiProfileRows();
    const worldModelTargets = listAiLandscapeRows("world-models");

    expect(listAiLandscapeRows().length).toBeGreaterThanOrEqual(100);
    expect(profiles).toHaveLength(10);
    expect(profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          profile: "world-models",
          daily_concerns: expect.stringContaining("spatial intelligence"),
        }),
        expect.objectContaining({
          profile: "inference",
          daily_concerns: expect.stringContaining("kv cache"),
        }),
      ]),
    );
    expect(worldModelTargets.map((row) => row.id)).toEqual(
      expect.arrayContaining([
        "google-deepmind",
        "meta-ai",
        "world-labs",
        "physical-intelligence",
        "modelscope",
      ]),
    );
  });

  it("keeps catalog identities, domains, repositories, and profile source refs unambiguous", () => {
    const ids = AI_PRIMARY_SOURCES.map((source) => source.id);
    const repositories = AI_PRIMARY_SOURCES.flatMap((source) =>
      source.repositories.map((repository) => repository.toLowerCase()),
    );
    const roles = new Set(AI_ROLE_PROFILES.map((profile) => profile.id));
    const liveRefs = new Set(
      listAiSourceCommands().map((source) => source.ref),
    );
    const profileRefs = new Set([
      ...AI_ROLE_PROFILES.flatMap((profile) => profile.sourceRefs),
      ...AUTHENTICATED_AI_SOURCE_REFS,
    ]);

    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(repositories).size).toBe(repositories.length);
    expect(
      AI_PRIMARY_SOURCES.flatMap((source) => source.domains).every(
        (domain) =>
          !domain.includes("/") &&
          new URL(`https://${domain}`).hostname === domain,
      ),
    ).toBe(true);
    expect(
      AI_PRIMARY_SOURCES.every((source) =>
        source.repositories.every((repository) =>
          /^[^/]+\/[^/]+$/.test(repository),
        ),
      ),
    ).toBe(true);
    expect(
      AI_PRIMARY_SOURCES.every((source) =>
        source.roles.every((role) => role === "all" || roles.has(role)),
      ),
    ).toBe(true);
    expect([...profileRefs].filter((ref) => !liveRefs.has(ref))).toEqual([]);
  });

  it("selects exact primary targets without treating generic community posts as official", () => {
    expect(
      identifyAiPrimarySource(
        "https://github.com/vllm-project/vllm/releases/tag/v1.0.0",
      )?.id,
    ).toBe("vllm");
    expect(identifyAiPrimarySource("https://x.com/user/status/1")?.type).toBe(
      "community",
    );
    expect(
      selectAiOfficialDomains("site:docs.nvidia.com CUDA", "hardware"),
    ).toEqual(["docs.nvidia.com"]);
    expect(selectAiOfficialDomains("world model", "world-models")).toEqual(
      expect.arrayContaining(["deepmind.google", "worldlabs.ai"]),
    );
  });

  it("rejects an impossible freshness date before source I/O", async () => {
    await expect(
      searchAiContent("accelerator", { since: "2026-02-30" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("AI content normalization", () => {
  it("unwraps DuckDuckGo redirects, removes tracking, and retains official provenance", () => {
    const target =
      "https://docs.nvidia.com/cuda/release-notes.html?utm_source=index#changes";
    const redirect = `//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&rut=opaque`;
    const canonical = canonicalizeAiUrl(redirect);
    const records = coerceAiContentRecords(
      [
        {
          title: "CUDA release notes",
          url: redirect,
          snippet: "Current NVIDIA CUDA changes",
        },
      ],
      {
        ref: "duckduckgo.search",
        site: "duckduckgo",
        name: "search",
        kind: "docs",
        sourceClass: "search-index",
      },
      "CUDA release notes",
      "2026-07-17T00:00:00.000Z",
    );

    expect(canonical).toBe("https://docs.nvidia.com/cuda/release-notes.html");
    expect(records[0]).toEqual(
      expect.objectContaining({
        url: canonical,
        domain: "docs.nvidia.com",
        vendor: "nvidia",
        source_class: "official",
        source_adapter: "duckduckgo",
        source_command: "search",
      }),
    );
  });

  it("unwraps Yahoo result redirects into canonical source URLs", () => {
    const redirect =
      "https://r.search.yahoo.com/_ylt=x/RV=2/RE=1/RO=10/RU=https%3a%2f%2frocm.docs.amd.com%2fen%2flatest%2fabout%2frelease-notes.html/RK=2/RS=x";

    expect(canonicalizeAiUrl(redirect)).toBe(
      "https://rocm.docs.amd.com/en/latest/about/release-notes.html",
    );
  });

  it("normalizes Hugging Face artifacts with current timestamps and metrics", () => {
    const records = coerceAiContentRecords(
      [
        {
          id: "amd/rocm-model",
          title: "amd/rocm-model",
          author: "amd",
          downloads: 42,
          likes: 7,
          lastModified: "2026-07-17T01:00:00Z",
          tags: "text-generation, rocm",
          url: "https://huggingface.co/amd/rocm-model",
        },
      ],
      {
        ref: "hf.models",
        site: "hf",
        name: "models",
        kind: "model",
        sourceClass: "community",
      },
      "ROCm",
      "2026-07-17T02:00:00Z",
    );

    expect(records[0]).toEqual(
      expect.objectContaining({
        kind: "model",
        vendor: "amd",
        updated_at: "2026-07-17T01:00:00Z",
        tags: ["text-generation", "rocm"],
        metrics: { downloads: 42, likes: 7 },
      }),
    );
  });

  it("attributes first-party model hubs while keeping social-platform posts community evidence", () => {
    const model = coerceAiContentRecords(
      [
        {
          id: "org/model",
          title: "World model",
          url: "https://modelscope.cn/models/org/model",
        },
      ],
      {
        ref: "modelscope.models",
        site: "modelscope",
        name: "models",
        kind: "model",
        sourceClass: "community",
      },
      "world model",
      "2026-07-17T00:00:00Z",
    )[0];
    const post = coerceAiContentRecords(
      [
        {
          title: "World model update",
          url: "https://x.com/researcher/status/1",
        },
      ],
      {
        ref: "twitter.search",
        site: "twitter",
        name: "search",
        kind: "post",
        sourceClass: "community",
      },
      "world model",
      "2026-07-17T00:00:00Z",
    )[0];

    expect(model).toMatchObject({
      source_class: "official",
      primary_source_id: "modelscope",
      organization: "ModelScope",
      organization_type: "model-hub",
    });
    expect(post).toMatchObject({
      source_class: "community",
      primary_source_id: "x",
      organization_type: "community",
    });
  });

  it.each([
    {
      label: "comma-separated authors",
      authors: "Ada Lovelace, Grace Hopper",
      expected: "Ada Lovelace, Grace Hopper",
    },
    {
      label: "author string arrays",
      authors: ["Ada Lovelace", "Grace Hopper"],
      expected: "Ada Lovelace, Grace Hopper",
    },
    {
      label: "author object arrays",
      authors: [{ name: "Ada Lovelace" }, { name: "Grace Hopper" }],
      expected: "Ada Lovelace, Grace Hopper",
    },
  ])("normalizes paper $label", ({ authors, expected }) => {
    const records = coerceAiContentRecords(
      [
        {
          id: "paper-1",
          title: "Inference infrastructure",
          authors,
          year: 2026,
          cited_by_count: 12,
          references_count: 34,
          source_url: "https://www.semanticscholar.org/paper/paper-1",
        },
      ],
      {
        ref: "semantic-scholar.search",
        site: "semantic-scholar",
        name: "search",
        kind: "paper",
        sourceClass: "community",
      },
      "inference",
      "2026-07-17T02:00:00Z",
    );

    expect(records[0]).toMatchObject({
      author: expected,
      published_at: "2026",
      metrics: { cited_by_count: 12, references_count: 34 },
    });
  });

  it("recognizes Huawei Ascend vocabulary without relying on one domain", () => {
    expect(inferAiVendor("https://example.org/post", "CANN 9 and 昇腾")).toBe(
      "huawei-ascend",
    );
  });

  it.each([
    "Cann (2026a) studied stellar storms",
    "Bird populations ascend after the storm",
    "Continuous attractor neural networks (CANNs) motivate CANN research",
  ])("does not classify ordinary prose as Huawei Ascend: %s", (text) => {
    expect(inferAiVendor("https://example.org/paper", text)).toBe("unknown");
  });

  it.each(["CANN 8.5 runtime", "Ascend 910 NPU deployment", "MindIE toolkit"])(
    "recognizes exact Huawei accelerator vocabulary: %s",
    (text) => {
      expect(inferAiVendor("https://example.org/post", text)).toBe(
        "huawei-ascend",
      );
    },
  );

  it("prefers the owning vendor domain over comparison text", () => {
    expect(
      inferAiVendor(
        "https://rocm.blogs.amd.com/release.html",
        "Comparison with NVIDIA CUDA",
      ),
    ).toBe("amd");
  });

  it("does not confuse the unrelated all-caps ROCM acronym with AMD ROCm", () => {
    expect(
      inferAiVendor(
        "https://huggingface.co/papers/2607.00001",
        "ROCM: RLHF on consistency models",
      ),
    ).toBe("hugging-face");
  });

  it("requires AMD hardware context before classifying Instinct", () => {
    expect(
      inferAiVendor(
        "https://example.org/paper",
        "Human instinct guides exploration under uncertainty",
      ),
    ).toBe("unknown");
    expect(
      inferAiVendor(
        "https://example.org/hardware",
        "Instinct MI300X accelerator deployment",
      ),
    ).toBe("amd");
  });

  it("retains an explicitly marked search-index date for official docs", () => {
    const [record] = coerceAiContentRecords(
      [
        {
          title: "ROCm release notes",
          url: "https://rocm.docs.amd.com/en/latest/release-notes.html",
          snippet: "Jun 29, 2026 · Current AMD ROCm changes.",
        },
      ],
      {
        ref: "yahoo.search",
        site: "yahoo",
        name: "search",
        kind: "docs",
        sourceClass: "search-index",
      },
      "release notes",
      "2026-07-17T00:00:00Z",
    );

    expect(record).toMatchObject({
      published_at: "2026-06-29T00:00:00.000Z",
      timestamp_origin: "search-index-snippet",
      source_class: "official",
    });
  });

  it("retains every hardware vendor on cross-vendor community content", () => {
    const text = "AMD funded a drop-in CUDA implementation built on ROCm";

    expect(inferAiVendor("https://news.ycombinator.com/item?id=1", text)).toBe(
      "unknown",
    );
    expect(
      inferAiVendors("https://news.ycombinator.com/item?id=1", text),
    ).toEqual(["nvidia", "amd"]);
  });
});

function record(url: string, source: string, rank: number): AiContentRecord {
  return {
    id: `${source}-${String(rank)}`,
    title: "Shared document",
    url,
    domain: "docs.nvidia.com",
    kind: "docs",
    doi: "",
    arxiv_id: "",
    semantic_scholar_id: "",
    vendor: "nvidia",
    vendors: ["nvidia"],
    publisher: "nvidia",
    organization: "NVIDIA AI",
    organization_type: "hardware",
    primary_source_id: "nvidia",
    source_class: "official",
    source_adapter: source,
    source_command: "search",
    source_rank: rank,
    summary: "",
    author: "",
    published_at: "",
    updated_at: "",
    timestamp_origin: "unavailable",
    tags: [],
    metrics: {},
    matched_query: "CUDA",
    retrieved_at: "2026-07-17T00:00:00Z",
  };
}

describe("AI reciprocal-rank fusion", () => {
  it("deduplicates canonical URLs and records every contributing source", () => {
    const shared = "https://docs.nvidia.com/cuda/release-notes.html";
    const rows = reciprocalRankFuse(
      [[record(shared, "duckduckgo", 1)], [record(shared, "yahoo", 1)]],
      10,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].source_refs).toEqual(["duckduckgo.search", "yahoo.search"]);
    expect(rows[0].rrf_score).toBeGreaterThan(0.03);
  });

  it("deduplicates long syndicated community posts across different URLs", () => {
    const title =
      "NVIDIA introduced a current world model for on-device robot perception and action generation across industrial deployments";
    const first = {
      ...record("https://bsky.app/profile/one/post/1", "bluesky", 1),
      kind: "post" as const,
      title,
    };
    const second = {
      ...record("https://bsky.app/profile/two/post/2", "bluesky", 2),
      kind: "post" as const,
      title,
    };

    const rows = reciprocalRankFuse([[first, second]], 10);

    expect(rows).toHaveLength(1);
  });

  it("deduplicates one paper across Hugging Face and Semantic Scholar URLs", () => {
    const retrievedAt = "2026-07-17T00:00:00Z";
    const hf = coerceAiContentRecords(
      [
        {
          id: "2302.01318",
          title: "Fast Inference from Transformers via Speculative Decoding",
          url: "https://huggingface.co/papers/2302.01318",
        },
      ],
      {
        ref: "huggingface-papers.search",
        site: "huggingface-papers",
        name: "search",
        kind: "paper",
        sourceClass: "community",
      },
      "speculative decoding",
      retrievedAt,
    );
    const semanticScholar = coerceAiContentRecords(
      [
        {
          id: "s2-paper",
          title: "Fast Inference from Transformers via Speculative Decoding",
          doi: "10.5555/speculative-decoding",
          arxiv_id: "2302.01318v2",
          semantic_scholar_id: "abcdef",
          source_url: "https://www.semanticscholar.org/paper/abcdef",
        },
      ],
      {
        ref: "semantic-scholar.search",
        site: "semantic-scholar",
        name: "search",
        kind: "paper",
        sourceClass: "community",
      },
      "speculative decoding",
      retrievedAt,
    );

    const rows = reciprocalRankFuse([hf, semanticScholar], 10);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      doi: "10.5555/speculative-decoding",
      arxiv_id: "2302.01318",
      semantic_scholar_id: "abcdef",
      source_refs: ["huggingface-papers.search", "semantic-scholar.search"],
    });
  });
});

describe("AI document structure", () => {
  it("emits headings, canonical links, provenance, truncation, and a content hash", () => {
    const document = structureAiDocument(
      "https://rocm.docs.amd.com/guide?utm_source=test#top",
      "# ROCm Guide\n\n## Install\n\nSee [matrix](/compatibility).",
      "2026-07-17T00:00:00Z",
      10_000,
      10,
    );

    expect(document).toEqual(
      expect.objectContaining({
        title: "ROCm Guide",
        url: "https://rocm.docs.amd.com/guide",
        vendor: "amd",
        source_class: "official",
        truncated: false,
      }),
    );
    expect(document.headings).toEqual([
      { level: 1, title: "ROCm Guide" },
      { level: 2, title: "Install" },
    ]);
    expect(document.links).toEqual([
      {
        text: "matrix",
        url: "https://rocm.docs.amd.com/compatibility",
      },
    ]);
    expect(document.content_sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
