/**
 * @owner       src::adapters::ai::intelligence
 * @does        Registers AI-infrastructure intelligence as ordinary adapter commands so CLI, MCP default, expanded, deferred, discovery, and contracts execute one shared implementation.
 * @needs       src/commands/ai.ts orchestration services and the adapter registry
 * @feeds       `unicli ai search|read|sources` on every supported transport
 * @breaks      Registering these as Commander-only commands makes MCP discovery advertise commands it cannot execute.
 * @invariants  Every surface resolves ai.* through the shared invocation kernel; search and read remain read-only; provider failures stay structured in results or errors.
 * @side-effects search/read fan out to declared public or user-owned read-only adapters; sources is network-free.
 * @perf        Delegates to bounded AI orchestration limits (1-100 results).
 * @concurrency safe across invocations; each invocation owns its orchestration state.
 * @test        tests/unit/adapters/ai-intelligence.test.ts and tests/unit/commands/ai.test.ts
 * @stability   experimental
 * @since       2026-07-17
 */

import {
  listAiSourceRows,
  readAiContent,
  searchAiContent,
} from "../../commands/ai.js";
import { cli, Strategy } from "../../registry.js";

function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return String(value);
}

cli({
  site: "ai",
  name: "search",
  description:
    "Search live AI infrastructure with provenance and recovery; 实时 搜索 英伟达 NVIDIA AMD ROCm 华为昇腾 CANN GitHub Hugging Face 最新 AI 基础设施 技术文档 社区 论文 模型 数据",
  strategy: Strategy.PUBLIC,
  browser: false,
  target_surface: "web",
  args: [
    {
      name: "query",
      type: "str",
      required: true,
      positional: true,
      description: "AI or AI-infrastructure search query / AI 基础设施检索词",
    },
    {
      name: "sources",
      type: "str",
      description: "Comma-separated source refs/sites, or all",
    },
    {
      name: "kind",
      type: "str",
      default: "all",
      choices: [
        "all",
        "docs",
        "repository",
        "issue",
        "pull-request",
        "discussion",
        "model",
        "dataset",
        "space",
        "paper",
        "community",
      ],
      description: "Structured AI content kind",
    },
    {
      name: "vendors",
      type: "str",
      description: "nvidia, amd, huawei-ascend",
    },
    {
      name: "domains",
      type: "str",
      description: "Restrict results to exact domain suffixes",
    },
    {
      name: "repo",
      type: "str",
      description: "GitHub OWNER/REPO scope",
    },
    {
      name: "sort",
      type: "str",
      default: "relevance",
      choices: ["relevance", "latest"],
      description:
        "Rank by source relevance or by the newest verifiable source timestamp",
    },
    {
      name: "since",
      type: "str",
      format: "date",
      description:
        "Require a verifiable published/updated timestamp on or after YYYY-MM-DD",
    },
    {
      name: "limit",
      type: "int",
      default: 20,
      description: "Maximum fused records (1-100)",
    },
  ],
  columns: [
    "title",
    "kind",
    "vendor",
    "source_class",
    "source_adapter",
    "updated_at",
    "freshness_verifiable",
    "url",
    "summary",
  ],
  capabilities: ["http.fetch", "subprocess.exec", "ai.intelligence"],
  executables: ["gh"],
  minimum_capability: "http.fetch",
  func: async (_page, kwargs) =>
    searchAiContent(text(kwargs.query) ?? "", {
      sources: text(kwargs.sources),
      kind: text(kwargs.kind),
      vendors: text(kwargs.vendors),
      domains: text(kwargs.domains),
      repo: text(kwargs.repo),
      sort: text(kwargs.sort),
      since: text(kwargs.since),
      limit: text(kwargs.limit),
    }),
});

cli({
  site: "ai",
  name: "read",
  description:
    "Read and structure a live AI/AI-infrastructure source with clean Markdown, headings, links, provenance, timestamp, and content hash; 精确读取并结构化处理 AI 技术文档。",
  strategy: Strategy.PUBLIC,
  browser: false,
  target_surface: "web",
  args: [
    {
      name: "url",
      type: "str",
      required: true,
      positional: true,
      format: "uri",
      description: "Public HTTP(S) source URL",
    },
    {
      name: "max_chars_k",
      type: "int",
      default: 100,
      description: "Maximum Markdown size in thousands of characters (1-100)",
    },
    {
      name: "max_links",
      type: "int",
      default: 100,
      description: "Maximum structured links (1-100)",
    },
  ],
  capabilities: ["http.fetch", "ai.intelligence", "ai.docs"],
  minimum_capability: "http.fetch",
  func: async (_page, kwargs) =>
    readAiContent(text(kwargs.url) ?? "", {
      maxCharsK: text(kwargs.max_chars_k),
      maxLinks: text(kwargs.max_links),
    }),
});

cli({
  site: "ai",
  name: "sources",
  description:
    "List the registry-backed AI source, provenance, capability, auth, and adapter-path matrix without network I/O; 列出实时 AI 基础设施检索来源矩阵。",
  strategy: Strategy.PUBLIC,
  browser: false,
  target_surface: "web",
  columns: [
    "source",
    "kind",
    "source_class",
    "capabilities",
    "required_args",
    "auth",
    "domain",
  ],
  capabilities: ["ai.intelligence"],
  func: async () => listAiSourceRows(),
});
