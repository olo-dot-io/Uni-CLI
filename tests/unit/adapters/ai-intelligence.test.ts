import { readFileSync } from "node:fs";
import { join } from "node:path";

import yaml from "js-yaml";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { pulseAiContent, searchAiContent } from "../../../src/commands/ai.js";
import { listCoreDiscoveryCommands } from "../../../src/discovery/core-catalog.js";
import {
  loadAllAdapters,
  loadTsAdapters,
} from "../../../src/discovery/loader.js";
import { invalidateCache, search } from "../../../src/discovery/search.js";
import { extractHtmlRows } from "../../../src/engine/steps/extract.js";
import { classifyExecFailure } from "../../../src/engine/steps/exec.js";
import { readManifest } from "../../../src/fast-path/manifest.js";
import { buildHandler } from "../../../src/mcp/handler.js";
import {
  buildDefaultTools,
  buildDeferredTools,
  buildExpandedTools,
} from "../../../src/mcp/tools.js";
import { resolveCommand } from "../../../src/registry.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");

interface ParsedAdapter {
  pipeline: Array<Record<string, Record<string, unknown>>>;
}

function readAdapter(site: string, command: string): ParsedAdapter {
  return yaml.load(
    readFileSync(
      join(ROOT, "src", "adapters", site, `${command}.yaml`),
      "utf8",
    ),
  ) as ParsedAdapter;
}

beforeAll(async () => {
  loadAllAdapters();
  await loadTsAdapters();
  invalidateCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AI intelligence transport parity", () => {
  it("registers one adapter-backed contract without a duplicate core row", () => {
    expect(resolveCommand("ai", "search")).toBeDefined();
    expect(resolveCommand("ai", "read")).toBeDefined();
    expect(resolveCommand("ai", "sources")).toBeDefined();
    expect(resolveCommand("ai", "pulse")).toBeDefined();
    expect(resolveCommand("ai", "landscape")).toBeDefined();
    expect(resolveCommand("ai", "profiles")).toBeDefined();
    expect(resolveCommand("gh", "issue-thread")).toBeDefined();
    expect(resolveCommand("gh", "pr-thread")).toBeDefined();
    expect(
      listCoreDiscoveryCommands().filter((command) => command.site === "ai"),
    ).toEqual([]);
  });

  it("ships AI commands in the fast-path manifest", () => {
    expect(
      readManifest()
        .sites.ai?.commands.map((command) => command.name)
        .sort(),
    ).toEqual(["landscape", "profiles", "pulse", "read", "search", "sources"]);
  });

  it("exposes AI commands in expanded and deferred MCP profiles", () => {
    const expanded = buildExpandedTools().find(
      (tool) => tool.name === "unicli_ai_search",
    );
    const deferred = buildDeferredTools().find(
      (tool) => tool.name === "unicli_ai_search",
    );

    expect(expanded?.inputSchema.required).toContain("query");
    expect(expanded?.annotations?.readOnlyHint).toBe(true);
    expect(deferred).toBeDefined();
  });

  it("executes ai.sources through the default MCP unicli_run tool", async () => {
    const handler = buildHandler(buildDefaultTools());
    const created = await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "unicli_run",
        arguments: { site: "ai", command: "sources", args: {} },
        task: {},
      },
    });
    const taskId = (
      created?.result as { task?: { taskId?: string } } | undefined
    )?.task?.taskId;
    expect(taskId).toEqual(expect.any(String));

    const completed = await handler({
      jsonrpc: "2.0",
      id: 2,
      method: "tasks/result",
      params: { taskId },
    });
    const result = completed?.result as {
      isError?: boolean;
      structuredContent?: {
        data?: {
          count?: number;
          results?: Array<{
            source?: string;
            auth?: boolean;
            auth_setup?: string;
          }>;
        };
      };
    };

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.data?.count).toBeGreaterThan(5);
    expect(result.structuredContent?.data?.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "hf.community" }),
        expect.objectContaining({
          source: "gh.search-issues",
          auth: true,
          auth_setup: "gh auth login",
        }),
      ]),
    );
  });
});

describe("AI intelligence bilingual discovery", () => {
  it.each([
    "华为昇腾 CANN 社区",
    "AMD ROCm 最新消息",
    "英伟达 昇腾 AI 基础设施 最新文档",
  ])("ranks ai.search first for %s", (query) => {
    expect(search(query, 5)[0]).toMatchObject({
      site: "ai",
      command: "search",
    });
  });
});

describe("AI source precision contracts", () => {
  it("normalizes ModelScope public OpenAPI model rows with first-party attribution", async () => {
    let requestedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        requestedUrl = String(input);
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              models: [
                {
                  id: "lab/world-model",
                  display_name: "World Model",
                  description: "Interactive environment model",
                  downloads: 12,
                  likes: 3,
                  created_at: "2026-07-15T00:00:00Z",
                  last_modified: "2026-07-17T00:00:00Z",
                  tags: ["video-generation"],
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const rows = await searchAiContent("world model", {
      sources: "modelscope.models",
      limit: 2,
    });

    expect(new URL(requestedUrl).pathname).toBe("/openapi/v1/models");
    expect(new URL(requestedUrl).searchParams.get("search")).toBe(
      "world model",
    );
    expect(rows[0]).toMatchObject({
      title: "World Model",
      kind: "model",
      organization: "",
      hosting_platform: "ModelScope",
      source_class: "hosted-artifact",
      updated_at: "2026-07-17T00:00:00Z",
      metrics: { downloads: 12, likes: 3 },
    });
  });

  it("normalizes OpenCSG model rows and forwards its current sort vocabulary", async () => {
    let requestedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        requestedUrl = String(input);
        return new Response(
          JSON.stringify({
            msg: "OK",
            data: [
              {
                path: "lab/world-model",
                nickname: "World Model",
                description: "A spatial model",
                downloads: 8,
                likes: 2,
                created_at: "2026-07-15T00:00:00Z",
                updated_at: "2026-07-17T00:00:00Z",
                license: "apache-2.0",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const rows = await searchAiContent("world model", {
      sources: "opencsg.models",
      sort: "latest",
      limit: 2,
    });

    expect(new URL(requestedUrl).pathname).toBe("/api/v1/models");
    expect(new URL(requestedUrl).searchParams.get("sort")).toBe(
      "recently_update",
    );
    expect(rows[0]).toMatchObject({
      kind: "model",
      organization: "",
      hosting_platform: "OpenCSG",
      source_class: "hosted-artifact",
      updated_at: "2026-07-17T00:00:00Z",
    });
  });

  it("uses Bluesky's public app view for one bounded latest-post page", async () => {
    let requestedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        requestedUrl = String(input);
        return new Response(
          JSON.stringify({
            posts: [
              {
                uri: "at://did:plc:noise/app.bsky.feed.post/3noise",
                author: { handle: "noise.bsky.social" },
                record: {
                  text: "A model prediction surprised the world",
                  createdAt: "2026-07-17T02:00:00Z",
                },
                indexedAt: "2026-07-17T02:01:00Z",
                likeCount: 40,
                repostCount: 20,
                replyCount: 10,
              },
              {
                uri: "at://did:plc:one/app.bsky.feed.post/3abc",
                author: { handle: "researcher.bsky.social" },
                record: {
                  text: "New interactive world model",
                  createdAt: "2026-07-17T01:00:00Z",
                },
                indexedAt: "2026-07-17T01:01:00Z",
                likeCount: 4,
                repostCount: 2,
                replyCount: 1,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const rows = await searchAiContent("world model", {
      sources: "bluesky.search-posts",
      sort: "latest",
      since: "2026-07-01",
      limit: 2,
    });

    const url = new URL(requestedUrl);
    expect(url.hostname).toBe("api.bsky.app");
    expect(url.searchParams.get("sort")).toBe("latest");
    expect(url.searchParams.get("since")).toBe("2026-07-01T00:00:00.000Z");
    expect(rows[0]).toMatchObject({
      kind: "post",
      source_class: "community",
      published_at: "2026-07-17T01:00:00Z",
      metrics: { likes: 4, reposts: 2, replies: 1 },
    });
    expect(rows).toHaveLength(1);
  });

  it("builds a role-labelled current pulse from a bounded explicit source", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              hits: [
                {
                  objectID: "pulse-1",
                  title: "vLLM scheduler update",
                  created_at: "2026-07-17T01:00:00Z",
                  url: "https://example.com/vllm",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );

    const rows = await pulseAiContent({
      profile: "inference",
      query: "vLLM",
      sources: "hackernews.search",
      window: "all",
      limit: 1,
    });

    expect(rows[0]).toMatchObject({
      title: "vLLM scheduler update",
      pulse_profile: "inference",
      pulse_window: "all",
      pulse_queries: ["vLLM"],
      freshness_mode: "latest",
    });
  });

  it("preserves source failure and recovery detail when every pulse lane is empty", async () => {
    vi.stubGlobal(
      "fetch",
      // REASON: Semantic Scholar is external; the real retrieval, error mapping, and pulse aggregation run unchanged.
      vi.fn(
        async () => new Response("temporarily unavailable", { status: 503 }),
      ),
    );

    const failure = await pulseAiContent({
      profile: "inference",
      query: "continuous batching",
      sources: "yahoo.search",
      window: "all",
      limit: 2,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({
      retryable: true,
      suggestion: expect.stringContaining("yahoo.search"),
      alternatives: expect.arrayContaining([
        expect.stringContaining("unicli yahoo search"),
      ]),
    });
  });

  it("ranks an exact rare technical term above a broader high-rank overview", async () => {
    vi.stubGlobal(
      "fetch",
      // REASON: Hacker News is external; the real adapter normalization and AI fusion/ranking run unchanged.
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              hits: [
                {
                  objectID: "broad",
                  title: "NVIDIA Blackwell systems overview",
                  story_text: "A broad AI infrastructure overview.",
                  url: "https://example.com/blackwell-overview",
                },
                {
                  objectID: "exact",
                  title: "NVL72 NVLink bandwidth formula and topology",
                  story_text: "Exact NVL72 engineering details.",
                  url: "https://example.com/nvl72-bandwidth",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );

    const rows = await searchAiContent("NVL72", {
      sources: "hackernews.search",
      limit: 2,
    });

    expect(rows.map((row) => row.title)).toEqual([
      "NVL72 NVLink bandwidth formula and topology",
    ]);
  });

  it("reports a repeated provider failure once across profile pulse queries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).includes("hn.algolia.com")) {
          const query = new URL(String(input)).searchParams.get("query") ?? "";
          return new Response(
            JSON.stringify({
              hits: [
                {
                  objectID: `pulse-${query}`,
                  title: `${query} current update`,
                  created_at: "2026-07-17T01:00:00Z",
                  url: `https://example.com/inference/${encodeURIComponent(query)}`,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("unavailable", { status: 503 });
      }),
    );

    const rows = await pulseAiContent({
      profile: "inference",
      sources: "hackernews.search,semantic-scholar.search",
      window: "all",
      limit: 2,
    });

    expect(rows[0].source_errors).toEqual([
      expect.objectContaining({ ref: "semantic-scholar.search" }),
    ]);
    expect(rows[0].partial_failure_count).toBe(1);
  });

  it("keeps Hacker News query relevance when the aggregator invokes it", async () => {
    let requestedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        requestedUrl = String(input);
        return new Response(
          JSON.stringify({
            hits: [
              {
                objectID: "42",
                title: "ROCm infrastructure update",
                points: 10,
                author: "infra",
                num_comments: 2,
                created_at: "2026-07-16T01:02:03.000Z",
                updated_at: "2026-07-17T01:02:03.000Z",
                url: "https://example.com/rocm",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const rows = await searchAiContent("ROCm", {
      sources: "hackernews.search",
      limit: 5,
    });

    expect(new URL(requestedUrl).pathname).toBe("/api/v1/search");
    expect(new URL(requestedUrl).searchParams.get("query")).toBe("ROCm");
    expect(new URL(requestedUrl).searchParams.get("typoTolerance")).toBe(
      "false",
    );
    expect(rows[0]).toMatchObject({
      title: "ROCm infrastructure update",
      published_at: "2026-07-16T01:02:03.000Z",
      updated_at: "2026-07-17T01:02:03.000Z",
      source_errors: [],
    });
  });

  it("sorts timestamped community evidence by freshness and enforces since", async () => {
    let requestedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        requestedUrl = String(input);
        return new Response(
          JSON.stringify({
            hits: [
              {
                objectID: "old",
                title: "Old ROCm update",
                created_at: "2025-12-31T00:00:00.000Z",
                url: "https://example.com/old",
              },
              {
                objectID: "early",
                title: "Early ROCm update",
                created_at: "2026-01-02T00:00:00.000Z",
                url: "https://example.com/early",
              },
              {
                objectID: "new",
                title: "New ROCm update",
                created_at: "2026-07-17T00:00:00.000Z",
                url: "https://example.com/new",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const rows = await searchAiContent("ROCm", {
      sources: "hackernews.search",
      sort: "latest",
      since: "2026-01-01",
      limit: 3,
    });

    expect(new URL(requestedUrl).pathname).toBe("/api/v1/search_by_date");
    expect(new URL(requestedUrl).searchParams.get("typoTolerance")).toBe(
      "false",
    );
    expect(rows.map((row) => row.title)).toEqual([
      "New ROCm update",
      "Early ROCm update",
    ]);
    expect(rows[0]).toMatchObject({
      freshness_mode: "latest",
      source_timestamp: "2026-07-17T00:00:00.000Z",
      freshness_verifiable: true,
    });
  });

  it("normalizes Stack Overflow epoch timestamps through its live adapter shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              items: [
                {
                  title: "ROCm deployment",
                  score: 3,
                  answer_count: 1,
                  creation_date: 1_700_000_000,
                  last_activity_date: 1_700_100_000,
                  link: "https://stackoverflow.com/questions/1/rocm",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );

    const rows = await searchAiContent("ROCm", {
      sources: "stackoverflow.search",
      limit: 1,
    });

    expect(rows[0]).toMatchObject({
      published_at: "2023-11-14T22:13:20.000Z",
      updated_at: "2023-11-16T02:00:00.000Z",
    });
  });

  it("retains Lobsters publication time through its live adapter shape", async () => {
    let requestedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        requestedUrl = String(input);
        return new Response(
          `<li class="story">
            <div class="story_liner h-entry">
              <div class="voters"><a class="upvoter">6</a></div>
              <div class="details">
                <a class="u-url" href="https://example.com/rocm">ROCm update</a>
                <ul class="tags"><li><a class="tag">ai</a></li><li><a class="tag">release</a></li></ul>
                <div class="byline">
                  <a aria-hidden="true">avatar</a><a href="/~infra">infra</a>
                  <time datetime="2026-07-15T08:30:00.000Z" data-at-unix="1784104200">today</time>
                  <span class="comments_label"><a>4 comments</a></span>
                </div>
              </div>
            </div>
          </li>`,
          { status: 200, headers: { "Content-Type": "text/html" } },
        );
      }),
    );

    const rows = await searchAiContent("accelerator", {
      sources: "lobsters.search",
      sort: "latest",
      limit: 1,
    });

    expect(new URL(requestedUrl).pathname).toBe("/search");
    expect(new URL(requestedUrl).searchParams.get("order")).toBe("newest");
    expect(rows[0]).toMatchObject({
      title: "ROCm update",
      published_at: "2026-07-15T08:30:00.000Z",
      author: "infra",
      metrics: { score: 6, comments: 4 },
      tags: ["ai", "release"],
    });
  });

  it("overfetches before applying a vendor filter", async () => {
    let requestedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        requestedUrl = String(input);
        return new Response(
          JSON.stringify({
            hits: [
              {
                objectID: "1",
                title: "NVIDIA CUDA update",
                author: "nvidia",
                url: "https://example.com/cuda",
              },
              {
                objectID: "2",
                title: "AMD ROCm update",
                author: "amd",
                url: "https://example.com/rocm",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const rows = await searchAiContent("accelerator", {
      sources: "hackernews.search",
      vendors: "amd",
      limit: 1,
    });

    expect(new URL(requestedUrl).searchParams.get("hitsPerPage")).toBe("20");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "AMD ROCm update", vendor: "amd" });
  });

  it("treats a legitimate empty Semantic Scholar window as empty, not a source failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    const command = resolveCommand("semantic-scholar", "search")?.command;
    await expect(
      command?.func?.(null as never, { query: "no match", limit: 5 }),
    ).resolves.toEqual([]);
    await expect(
      searchAiContent("no match", {
        sources: "semantic-scholar.search",
        limit: 5,
      }),
    ).rejects.toMatchObject({
      code: "empty_result",
      alternatives: expect.arrayContaining(["unicli ai sources"]),
    });
  });

  it("exposes bounded first-party recovery targets for an empty vendor scope", async () => {
    vi.stubGlobal(
      "fetch",
      // REASON: Semantic Scholar is external; the real empty-result and vendor recovery boundary run unchanged.
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    const failure = await searchAiContent("BANG C kernel occupancy", {
      sources: "semantic-scholar.search",
      vendors: "cambricon",
      limit: 5,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({
      code: "empty_result",
      suggestion: expect.stringContaining("developer.cambricon.com"),
      alternatives: expect.arrayContaining([
        "unicli ai read 'https://developer.cambricon.com'",
        "unicli ai read 'https://github.com/Cambricon/mlu-ops'",
      ]),
    });
  });

  it("details partial source failures once while counting them on every row", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("hn.algolia.com")) {
          return new Response(
            JSON.stringify({
              hits: [
                {
                  objectID: "1",
                  title: "ROCm runtime update",
                  url: "https://example.com/rocm-runtime",
                },
                {
                  objectID: "2",
                  title: "ROCm compiler update",
                  url: "https://example.com/rocm-compiler",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("upstream unavailable", { status: 503 });
      }),
    );

    const rows = await searchAiContent("ROCm", {
      sources: "hackernews.search,semantic-scholar.search",
      limit: 2,
    });

    expect(rows).toHaveLength(2);
    expect(rows[0].partial_failure_count).toBe(1);
    expect(rows[0].source_errors).toEqual([
      expect.objectContaining({ ref: "semantic-scholar.search" }),
    ]);
    expect(rows[1].partial_failure_count).toBe(1);
    expect(Object.hasOwn(rows[1], "source_errors")).toBe(false);
  });

  it("uses a dated search-index snippet to enforce official-doc freshness", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            `<div class="algo">
              <div class="compTitle"><a href="https://rocm.docs.amd.com/en/latest/release-notes.html"><h3 class="title">ROCm release notes</h3></a></div>
              <div class="compText">Jun 29, 2026 · Current AMD ROCm changes.</div>
            </div>`,
            { status: 200, headers: { "Content-Type": "text/html" } },
          ),
      ),
    );

    const rows = await searchAiContent("release notes", {
      sources: "yahoo.search",
      vendors: "amd",
      kind: "docs",
      sort: "latest",
      since: "2026-01-01",
      limit: 5,
    });

    expect(rows[0]).toMatchObject({
      published_at: "2026-06-29T00:00:00.000Z",
      timestamp_origin: "search-index-snippet",
      freshness_verifiable: true,
    });
  });

  it("reports timestamp-unverifiable official docs as an unsupported strict freshness state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            `<div class="algo">
              <div class="compTitle"><a href="https://www.hiascend.com/document/detail/zh/canncommercial/900/releasenote/release-notes.md"><h3 class="title">CANN 9.0 release notes</h3></a></div>
              <div class="compText">Current Huawei Ascend CANN release notes.</div>
            </div>`,
            { status: 200, headers: { "Content-Type": "text/html" } },
          ),
      ),
    );

    const failure = await searchAiContent("CANN release notes", {
      sources: "yahoo.search",
      vendors: "huawei-ascend",
      kind: "docs",
      sort: "latest",
      since: "2026-01-01",
      limit: 5,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({
      code: "empty_result",
      message: expect.stringContaining("No timestamp-verifiable results"),
      suggestion: expect.stringContaining("timestamp_origin"),
    });
    expect((failure as { alternatives: string[] }).alternatives).toContain(
      "unicli ai search 'CANN release notes' --sources 'yahoo.search' --kind 'docs' --vendors 'huawei-ascend' --sort 'latest' --limit '5'",
    );
  });

  it("classifies GitHub CLI exit 4 as actionable authentication", () => {
    const error = Object.assign(
      new Error("To get started with GitHub CLI, please run: gh auth login"),
      { code: 4 },
    );

    expect(classifyExecFailure("gh", error)).toEqual({
      errorType: "auth_required",
      suggestion:
        "Authenticate GitHub CLI with `gh auth login`, then verify with `gh auth status`.",
      retryable: false,
      alternatives: ["gh auth login", "gh auth status"],
      preserveErrorCode: true,
    });
  });

  it("distinguishes a missing GitHub repository from a missing gh executable", () => {
    const repository = Object.assign(
      new Error(
        "GraphQL: Could not resolve to a Repository with the name 'missing/repo'.",
      ),
      {
        code: 1,
        stderr:
          "GraphQL: Could not resolve to a Repository with the name 'missing/repo'.",
      },
    );
    const executable = Object.assign(new Error("spawn gh ENOENT"), {
      code: "ENOENT",
    });

    expect(classifyExecFailure("gh", repository)).toMatchObject({
      errorType: "not_found",
      preserveErrorCode: true,
      suggestion: expect.stringContaining("owner/repository"),
    });
    expect(classifyExecFailure("gh", executable)).toMatchObject({
      errorType: "config_error",
      preserveErrorCode: true,
      suggestion: expect.stringContaining("which gh"),
    });
  });

  it("extracts current Brave result title and summary selectors", () => {
    const extract = readAdapter("brave", "search").pipeline[1].extract;
    const html = `
      <div class="snippet" data-type="web">
        <a href="https://rocm.docs.amd.com/en/latest/">
          <div class="title search-snippet-title">ROCm documentation</div>
        </a>
        <div class="generic-snippet">
          <div class="content">Current AMD accelerator documentation.</div>
        </div>
      </div>`;

    expect(
      extractHtmlRows(html, String(extract.from), extract.fields as never),
    ).toEqual([
      {
        title: "ROCm documentation",
        url: "https://rocm.docs.amd.com/en/latest/",
        snippet: "Current AMD accelerator documentation.",
      },
    ]);
  });

  it.each(["search-issues", "search-prs"])(
    "forces public visibility for gh.%s",
    (command) => {
      const exec = readAdapter("gh", command).pipeline[0].exec;
      const args = exec.args as unknown[];
      const visibility = args.indexOf("--visibility");

      expect(visibility).toBeGreaterThan(-1);
      expect(args[visibility + 1]).toBe("public");
      expect(String(args[args.indexOf("--json") + 1])).toContain("body");
    },
  );
});
