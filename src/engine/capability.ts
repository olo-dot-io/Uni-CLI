/**
 * Capability Inference — map analyzed endpoints to CLI capabilities.
 *
 * Determines what a site can do (search, hot, feed, detail, etc.),
 * what columns to display, what arguments to accept, and which
 * pipeline pattern to use for adapter generation.
 */

import type { AnalyzedEndpoint } from "./endpoint.js";
import type { StoreInfo } from "./framework.js";

// ── Types ────────────────────────────────────────────────────────────────

export type PipelinePattern =
  | "public-fetch"
  | "cookie-fetch"
  | "browser-evaluate"
  | "intercept"
  | "store-action";

export interface ArgDefinition {
  name: string;
  type: "string" | "int";
  required: boolean;
  default?: unknown;
  positional?: boolean;
  description?: string;
}

export interface InferredCapability {
  name: string;
  description: string;
  strategy: string;
  endpoint: AnalyzedEndpoint;
  itemPath: string | null;
  columns: string[];
  args: ArgDefinition[];
  storeHint?: { store: string; action: string };
  pipelinePattern: PipelinePattern;
}

// ── Goal Aliases (EN + ZH, 12 capabilities) ─────────────────────────────

const CAPABILITY_ALIASES: Record<string, string[]> = {
  search: ["search", "query", "find", "搜索", "查找", "检索"],
  hot: [
    "hot",
    "trending",
    "popular",
    "rank",
    "top",
    "热门",
    "热榜",
    "排行",
    "榜单",
  ],
  feed: ["feed", "timeline", "latest", "new", "stream", "最新", "动态", "推荐"],
  profile: ["profile", "user", "me", "account", "个人", "用户", "我的"],
  detail: ["detail", "item", "article", "post", "详情", "文章"],
  comments: ["comments", "replies", "review", "评论", "回复"],
  history: ["history", "recent", "历史", "最近"],
  favorite: ["favorite", "bookmark", "star", "like", "收藏", "点赞"],
  download: ["download", "save", "export", "下载", "导出"],
  create: ["create", "post", "publish", "write", "发布", "创建"],
  list: ["list", "index", "all", "列表", "全部"],
  follow: ["follow", "subscribe", "关注", "订阅"],
};

// ── Goal Matching ───────────────────────────────────────────────────────

export function normalizeGoal(goal?: string | null): string | null {
  if (!goal) return null;
  const lower = goal.toLowerCase().trim();

  for (const [key, aliases] of Object.entries(CAPABILITY_ALIASES)) {
    if (aliases.some((a) => lower.includes(a))) return key;
  }
  return null;
}

export function selectBestCapability(
  capabilities: InferredCapability[],
  goal?: string | null,
): InferredCapability | null {
  if (capabilities.length === 0) return null;

  const normalized = normalizeGoal(goal);
  if (normalized) {
    // Exact match
    const exact = capabilities.find((c) => c.name === normalized);
    if (exact) return exact;

    // Substring match (bidirectional)
    const partial = capabilities.find(
      (c) => c.name.includes(normalized) || normalized.includes(c.name),
    );
    if (partial) return partial;
  }

  // Default: first capability (highest-scored endpoint)
  return capabilities[0];
}

// ── Strategy Inference ──────────────────────────────────────────────────

function inferStrategy(authIndicators: string[]): string {
  if (authIndicators.includes("signature")) return "intercept";
  if (authIndicators.includes("bearer") || authIndicators.includes("csrf"))
    return "header";
  if (authIndicators.includes("cookie")) return "cookie";
  return "public";
}

function inferPipelinePattern(
  strategy: string,
  hasStoreHint: boolean,
): PipelinePattern {
  if (hasStoreHint) return "store-action";
  switch (strategy) {
    case "public":
      return "public-fetch";
    case "cookie":
      return "cookie-fetch";
    case "header":
      return "browser-evaluate";
    case "intercept":
      return "intercept";
    default:
      return "public-fetch";
  }
}

// ── Capability Inference ────────────────────────────────────────────────

const COLUMN_ROLE_ORDER = [
  "title",
  "url",
  "author",
  "score",
  "time",
  "description",
  "image",
];

export function inferCapabilities(
  endpoints: AnalyzedEndpoint[],
  stores: StoreInfo[],
  options: { site: string; goal?: string; url: string },
): InferredCapability[] {
  const capabilities: InferredCapability[] = [];
  const usedNames = new Set<string>();

  for (const ep of endpoints.slice(0, 8)) {
    // Capability name
    let capName = ep.capability ?? "data";
    if (usedNames.has(capName)) {
      const suffix = ep.pattern
        .split("/")
        .filter((s) => s && !s.startsWith(":") && !s.includes("."))
        .pop();
      capName = suffix
        ? `${capName}-${suffix}`
        : `${capName}-${usedNames.size}`;
    }
    usedNames.add(capName);

    // Columns from detected fields
    const columns: string[] = [];
    if (ep.responseAnalysis?.detectedFields) {
      for (const role of COLUMN_ROLE_ORDER) {
        if (ep.responseAnalysis.detectedFields[role]) {
          columns.push(role);
        }
      }
    }
    if (columns.length === 0) columns.push("title", "url");

    // Args from query params
    const args: ArgDefinition[] = [];
    if (ep.queryParams.hasSearch) {
      args.push({
        name: "query",
        type: "string",
        required: true,
        positional: true,
        description: "Search keyword",
      });
    }
    args.push({
      name: "limit",
      type: "int",
      required: false,
      default: 20,
      description: "Number of items to return",
    });
    if (ep.queryParams.hasPagination) {
      args.push({
        name: "page",
        type: "int",
        required: false,
        default: 1,
        description: "Page number",
      });
    }
    if (ep.queryParams.hasId) {
      args.push({
        name: "id",
        type: "string",
        required: true,
        positional: true,
        description: "Item ID",
      });
    }

    // Strategy
    const strategy = inferStrategy(ep.authIndicators);

    // Store hint matching
    let storeHint: { store: string; action: string } | undefined;
    if (
      (strategy === "intercept" || ep.authIndicators.includes("signature")) &&
      stores.length > 0
    ) {
      for (const s of stores) {
        const matchingAction = s.actions.find(
          (a) =>
            capName.split("-").some((part) => a.toLowerCase().includes(part)) ||
            a.toLowerCase().includes("fetch") ||
            a.toLowerCase().includes("get"),
        );
        if (matchingAction) {
          storeHint = { store: s.id, action: matchingAction };
          break;
        }
      }
    }

    const pipelinePattern = inferPipelinePattern(strategy, !!storeHint);

    capabilities.push({
      name: capName,
      description: `${options.site} ${capName}`,
      strategy: storeHint ? "intercept" : strategy,
      endpoint: ep,
      itemPath: ep.responseAnalysis?.itemPath ?? null,
      columns,
      args,
      storeHint,
      pipelinePattern,
    });
  }

  return capabilities;
}
