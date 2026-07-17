/**
 * @owner       src::commands::ai-content
 * @does        Defines the canonical AI content record and pure URL, provenance, normalization, fusion, and document-structure operations.
 * @needs       node:crypto and WHATWG URL
 * @feeds       src/commands/ai.ts and AI content contract tests
 * @breaks      Weak canonicalization or provenance inference causes duplicate, misattributed, or untraceable Agent evidence.
 * @invariants  Pure functions perform no I/O; normalized records always retain source identity and retrieval time; document hashes cover returned content.
 * @side-effects None.
 * @perf        O(R) normalization/fusion and O(N) document structuring.
 * @concurrency safe
 * @test        tests/unit/commands/ai.test.ts
 * @stability   experimental
 * @since       2026-07-17
 */

import { createHash } from "node:crypto";

import {
  identifyAiPrimarySource,
  type AiOrganizationType,
} from "./ai-landscape.js";

export type AiContentKind =
  | "docs"
  | "repository"
  | "issue"
  | "pull-request"
  | "discussion"
  | "model"
  | "dataset"
  | "space"
  | "paper"
  | "release"
  | "commit"
  | "post"
  | "video"
  | "benchmark"
  | "community";

export type AiVendor =
  | "nvidia"
  | "amd"
  | "huawei-ascend"
  | "intel-ai"
  | "aws-neuron"
  | "google-tpu"
  | "cerebras"
  | "groq"
  | "tenstorrent"
  | "sambanova"
  | "apple-mlx"
  | "qualcomm-ai"
  | "hugging-face"
  | "github"
  | "unknown";

export type AiSourceClass = "official" | "community" | "search-index";

export interface AiContentSource {
  ref: string;
  site: string;
  name: string;
  kind: AiContentKind;
  sourceClass: AiSourceClass;
}

export interface AiContentRecord {
  id: string;
  title: string;
  url: string;
  domain: string;
  kind: AiContentKind;
  doi: string;
  arxiv_id: string;
  semantic_scholar_id: string;
  vendor: AiVendor;
  vendors: AiVendor[];
  publisher: string;
  organization: string;
  organization_type: AiOrganizationType | "unknown";
  primary_source_id: string;
  source_class: AiSourceClass;
  source_adapter: string;
  source_command: string;
  source_rank: number;
  summary: string;
  author: string;
  published_at: string;
  updated_at: string;
  timestamp_origin: "source-field" | "search-index-snippet" | "unavailable";
  tags: string[];
  metrics: Record<string, number>;
  matched_query: string;
  retrieved_at: string;
  source_refs?: string[];
  rrf_score?: number;
}

const KIND_BY_REF: Readonly<Record<string, AiContentKind>> = {
  "duckduckgo.search": "docs",
  "brave.search": "docs",
  "yahoo.search": "docs",
  "gh.search-repos": "repository",
  "gh.search-issues": "issue",
  "gh.search-prs": "pull-request",
  "gh.discussions": "discussion",
  "gh.release": "release",
  "hf.models": "model",
  "hf.datasets": "dataset",
  "hf.spaces": "space",
  "hf.community": "discussion",
  "huggingface-papers.search": "paper",
  "arxiv.search": "paper",
  "semantic-scholar.search": "paper",
  "openreview.search": "paper",
  "openalex.search": "paper",
  "crossref.search": "paper",
  "acl-anthology.search": "paper",
  "modelscope.models": "model",
  "modelscope.datasets": "dataset",
  "opencsg.models": "model",
  "opencsg.datasets": "dataset",
  "openrouter.search": "model",
  "bluesky.search-posts": "post",
  "twitter.search": "post",
  "reddit.search": "post",
  "linux-do.search": "post",
  "zhihu.search": "post",
  "youtube.search": "video",
  "bilibili.search": "video",
  "hackernews.search": "community",
  "lobsters.search": "community",
  "stackoverflow.search": "community",
  "devto.search": "community",
};

const SOURCE_CLASS_BY_REF: Readonly<Record<string, AiSourceClass>> = {
  "duckduckgo.search": "search-index",
  "brave.search": "search-index",
  "yahoo.search": "search-index",
};

export function inferAiSourceKind(
  ref: string,
  capabilities: readonly string[],
): AiContentKind {
  const known = KIND_BY_REF[ref];
  if (known) return known;
  if (capabilities.includes("ai.docs")) return "docs";
  if (capabilities.includes("ai.paper")) return "paper";
  if (capabilities.includes("ai.model")) return "model";
  if (capabilities.includes("ai.dataset")) return "dataset";
  if (capabilities.includes("ai.post")) return "post";
  if (capabilities.includes("ai.video")) return "video";
  if (capabilities.includes("ai.release")) return "release";
  if (capabilities.includes("ai.commit")) return "commit";
  if (capabilities.includes("ai.benchmark")) return "benchmark";
  if (capabilities.includes("ai.artifacts")) return "repository";
  return "community";
}

export function inferAiSourceClass(ref: string): AiSourceClass {
  return SOURCE_CLASS_BY_REF[ref] ?? "community";
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function objectString(value: unknown, keys: readonly string[]): string {
  const direct = stringValue(value);
  if (direct) return direct;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = stringValue(record[key]);
    if (candidate) return candidate;
  }
  return "";
}

function authorString(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((author) =>
        objectString(author, ["name", "fullname", "login", "username"]),
      )
      .filter(Boolean)
      .join(", ");
  }
  return objectString(value, ["name", "fullname", "login", "username"]);
}

function firstString(
  row: Record<string, unknown>,
  fields: readonly string[],
): string {
  for (const field of fields) {
    const value = stringValue(row[field]);
    if (value) return value;
  }
  return "";
}

function timestampValue(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 100_000_000_000 ? value * 1_000 : value;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }
  const text = stringValue(value);
  if (!text) return "";
  if (/^\d{10,13}$/.test(text)) return timestampValue(Number(text));
  return text;
}

function firstTimestamp(
  row: Record<string, unknown>,
  fields: readonly string[],
): string {
  for (const field of fields) {
    if (field === "year") {
      const year = Number(row[field]);
      if (Number.isInteger(year) && year >= 1_000 && year <= 9_999) {
        return String(year);
      }
    }
    const value = timestampValue(row[field]);
    if (value) return value;
  }
  return "";
}

export function canonicalizeAiUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  let urlValue = value.startsWith("//") ? `https:${value}` : value;
  try {
    let parsed = new URL(urlValue);
    if (
      parsed.hostname.endsWith("duckduckgo.com") &&
      parsed.pathname === "/l/" &&
      parsed.searchParams.get("uddg")
    ) {
      urlValue = parsed.searchParams.get("uddg") ?? urlValue;
      parsed = new URL(urlValue);
    }
    if (parsed.hostname.endsWith("search.yahoo.com")) {
      const yahooTarget = /\/RU=([^/]+)(?:\/|$)/.exec(parsed.pathname)?.[1];
      if (yahooTarget) parsed = new URL(decodeURIComponent(yahooTarget));
    }
    parsed.hash = "";
    const trackingKeys = new Set<string>();
    parsed.searchParams.forEach((_value, key) => {
      if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) {
        trackingKeys.add(key);
      }
    });
    for (const key of trackingKeys) {
      parsed.searchParams.delete(key);
    }
    if (
      (parsed.protocol === "https:" && parsed.port === "443") ||
      (parsed.protocol === "http:" && parsed.port === "80")
    ) {
      parsed.port = "";
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function normalizeDoi(value: unknown): string {
  return stringValue(value)
    .replace(/^doi:/i, "")
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .toLowerCase();
}

function normalizeArxivId(value: unknown): string {
  return stringValue(value)
    .replace(/^arxiv:/i, "")
    .replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//i, "")
    .replace(/^https?:\/\/huggingface\.co\/papers\//i, "")
    .replace(/\.pdf$/i, "")
    .replace(/v\d+$/i, "");
}

export function inferAiVendors(url: string, text: string): AiVendor[] {
  const domain = domainOf(url);
  const corpus = `${domain} ${text}`;
  if (/(^|\.)nvidia\.com$/.test(domain)) return ["nvidia"];
  if (/(^|\.)amd\.com$/.test(domain)) return ["amd"];
  if (/(^|\.)(hiascend|huawei)\.com$/.test(domain)) {
    return ["huawei-ascend"];
  }
  if (/(^|\.)(intel|habana)\.(?:com|ai)$/.test(domain)) return ["intel-ai"];
  if (/(^|\.)aws\.amazon\.com$/.test(domain)) return ["aws-neuron"];
  if (
    /(^|\.)(cloud\.google|google\.com)$/.test(domain) &&
    /\btpu\b/i.test(corpus)
  ) {
    return ["google-tpu"];
  }
  if (/(^|\.)cerebras\.(?:ai|net)$/.test(domain)) return ["cerebras"];
  if (/(^|\.)groq\.com$/.test(domain)) return ["groq"];
  if (/(^|\.)tenstorrent\.com$/.test(domain)) return ["tenstorrent"];
  if (/(^|\.)sambanova\.ai$/.test(domain)) return ["sambanova"];
  if (/(^|\.)apple\.com$/.test(domain) && /\b(?:mlx|metal)\b/i.test(corpus)) {
    return ["apple-mlx"];
  }
  if (/(^|\.)qualcomm\.com$/.test(domain)) return ["qualcomm-ai"];
  const vendors: AiVendor[] = [];
  if (/\b(NVIDIA|CUDA|TensorRT|DGX)\b/i.test(corpus)) vendors.push("nvidia");
  if (
    /\bAMD\b/i.test(corpus) ||
    /\bROCm\b/.test(corpus) ||
    /\b(?:AMD\s+)?Instinct\s+MI\d{2,4}[A-Za-z0-9-]*\b/i.test(corpus)
  ) {
    vendors.push("amd");
  }
  if (
    /\bHuawei\s+Ascend\b/i.test(corpus) ||
    (/\bCANN\b/.test(corpus) &&
      /\b(?:Huawei|Ascend|NPU)\b|昇腾/i.test(corpus)) ||
    /\bCANN\s+v?\d+(?:\.\d+)*\b/.test(corpus) ||
    /\bMindIE\b/.test(corpus) ||
    /\bAscend\s+(?:AI|NPU|accelerator|hardware|platform|runtime|toolkit|9\d{2})\b/i.test(
      corpus,
    ) ||
    /昇腾/.test(corpus)
  ) {
    vendors.push("huawei-ascend");
  }
  if (/\b(?:Intel Gaudi|Habana|oneAPI|oneDNN)\b/i.test(corpus)) {
    vendors.push("intel-ai");
  }
  if (/\b(?:AWS Neuron|Trainium|Inferentia|NeuronX)\b/i.test(corpus)) {
    vendors.push("aws-neuron");
  }
  if (/\b(?:Google Cloud TPU|TPU v\d|XLA TPU)\b/i.test(corpus)) {
    vendors.push("google-tpu");
  }
  if (/\b(?:Cerebras|Wafer Scale Engine|WSE-\d)\b/i.test(corpus)) {
    vendors.push("cerebras");
  }
  if (/\b(?:GroqCloud|Groq LPU)\b/i.test(corpus)) vendors.push("groq");
  if (/\bTenstorrent\b/i.test(corpus)) vendors.push("tenstorrent");
  if (/\bSambaNova\b/i.test(corpus)) vendors.push("sambanova");
  if (/\b(?:Apple MLX|MLX LM|Metal Performance Shaders)\b/i.test(corpus)) {
    vendors.push("apple-mlx");
  }
  if (/\b(?:Qualcomm AI|Hexagon NPU|Cloud AI 100)\b/i.test(corpus)) {
    vendors.push("qualcomm-ai");
  }
  if (vendors.length > 0) return vendors;
  if (/(^|\.)huggingface\.co$/.test(domain)) return ["hugging-face"];
  if (/(^|\.)github\.com$/.test(domain)) return ["github"];
  return [];
}

export function inferAiVendor(url: string, text: string): AiVendor {
  const vendors = inferAiVendors(url, text);
  return vendors.length === 1 ? vendors[0] : "unknown";
}

function officialSource(url: string): boolean {
  const domain = domainOf(url);
  if (domain === "docs.github.com") return true;
  const target = identifyAiPrimarySource(url);
  return target !== undefined && target.type !== "community";
}

function tagsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(stringValue).filter(Boolean);
  return stringValue(value)
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function numericMetrics(row: Record<string, unknown>): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const field of [
    "downloads",
    "likes",
    "comments",
    "commentsCount",
    "score",
    "views",
    "replies",
    "reposts",
    "repostCount",
    "likeCount",
    "replyCount",
    "play",
    "stargazersCount",
    "forksCount",
    "upvotes",
    "cited_by_count",
    "references_count",
    "citationCount",
    "referenceCount",
  ]) {
    const raw = row[field];
    if (raw === undefined || raw === null || raw === "") continue;
    const value = Number(raw);
    if (Number.isFinite(value)) metrics[field] = value;
  }
  return metrics;
}

function recordRows(results: unknown[]): Record<string, unknown>[] {
  return results
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter(
      (value): value is Record<string, unknown> =>
        value !== null && typeof value === "object" && !Array.isArray(value),
    );
}

function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const finalSegment = parsed.pathname.split("/").filter(Boolean).at(-1);
    return finalSegment
      ? decodeURIComponent(finalSegment).replaceAll(/[-_]+/g, " ")
      : parsed.hostname;
  } catch {
    return "Untitled result";
  }
}

function searchIndexSnippetTimestamp(summary: string): string {
  const match = summary.match(
    /^\s*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+\d{4}|\d{4}-\d{2}-\d{2})\s*[·•|\-–—]/i,
  );
  if (!match) return "";
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(match[1]);
  const monthNames = [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
  ];
  const named = /^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/.exec(match[1]);
  const month = named
    ? monthNames.indexOf(named[1].slice(0, 3).toLowerCase())
    : -1;
  const parsed = iso
    ? new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])))
    : named && month >= 0
      ? new Date(Date.UTC(Number(named[3]), month, Number(named[2])))
      : new Date(Number.NaN);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

export function coerceAiContentRecords(
  results: unknown[],
  source: AiContentSource,
  query: string,
  retrievedAt: string,
): AiContentRecord[] {
  return recordRows(results).map((row, index) => {
    const url = canonicalizeAiUrl(
      firstString(row, ["url", "source_url", "link", "html_url"]),
    );
    const title =
      firstString(row, ["title", "name", "fullName", "modelId", "id"]) ||
      titleFromUrl(url);
    const domain = domainOf(url);
    const primarySource = identifyAiPrimarySource(url);
    const summary = firstString(row, [
      "summary",
      "description",
      "snippet",
      "body",
      "text",
      "abstract",
      "aiSummary",
    ]).slice(0, 4_000);
    const author = authorString(row.author) || authorString(row.authors);
    const vendors = inferAiVendors(
      url,
      `${title} ${summary} ${tagsOf(row.tags).join(" ")}`,
    );
    const vendor = vendors.length === 1 ? vendors[0] : "unknown";
    const sourceClass = officialSource(url) ? "official" : source.sourceClass;
    const nativeId = firstString(row, ["id", "number", "objectID", "fullName"]);
    const doi = normalizeDoi(row.doi);
    const arxivId = normalizeArxivId(
      row.arxiv_id ??
        (source.kind === "paper" &&
        (source.site === "arxiv" || source.site === "huggingface-papers")
          ? (row.id ?? url)
          : undefined),
    );
    const semanticScholarId = firstString(row, [
      "semantic_scholar_id",
      "paperId",
    ]);
    const identity = url || `${source.ref}:${nativeId || title}`;
    const publishedAt = firstTimestamp(row, [
      "published_at",
      "publishedAt",
      "published",
      "createdAt",
      "created_at",
      "creation_date",
      "date",
      "year",
    ]);
    const updatedAt = firstTimestamp(row, [
      "updated_at",
      "updatedAt",
      "lastModified",
      "last_posted_at",
      "last_activity_date",
    ]);
    const indexedAt =
      !publishedAt &&
      !updatedAt &&
      source.kind === "docs" &&
      source.sourceClass === "search-index"
        ? searchIndexSnippetTimestamp(summary)
        : "";
    return {
      id: createHash("sha256").update(identity).digest("hex").slice(0, 24),
      title,
      url,
      domain,
      kind: source.kind,
      doi,
      arxiv_id: arxivId,
      semantic_scholar_id: semanticScholarId,
      vendor,
      vendors,
      publisher:
        firstString(row, ["repository", "publisher"]) ||
        (primarySource?.type !== "community" ? primarySource?.name : "") ||
        author ||
        (vendor !== "unknown" ? vendor : domain),
      organization: primarySource?.name ?? "",
      organization_type: primarySource?.type ?? "unknown",
      primary_source_id: primarySource?.id ?? "",
      source_class: sourceClass,
      source_adapter: source.site,
      source_command: source.name,
      source_rank: index + 1,
      summary,
      author,
      published_at: publishedAt || indexedAt,
      updated_at: updatedAt,
      timestamp_origin:
        publishedAt || updatedAt
          ? "source-field"
          : indexedAt
            ? "search-index-snippet"
            : "unavailable",
      tags: tagsOf(row.tags),
      metrics: numericMetrics(row),
      matched_query: query,
      retrieved_at: retrievedAt,
    };
  });
}

export function reciprocalRankFuse(
  lists: readonly AiContentRecord[][],
  limit: number,
): AiContentRecord[] {
  type FusedGroup = {
    record: AiContentRecord;
    score: number;
    refs: Set<string>;
    aliases: Set<string>;
  };
  const groups = new Map<string, FusedGroup>();
  const aliasToGroup = new Map<string, string>();
  let nextGroupId = 0;

  function aliasesFor(record: AiContentRecord): string[] {
    const persistent =
      record.kind === "paper"
        ? [
            record.doi ? `paper:doi:${record.doi}` : "",
            record.arxiv_id
              ? `paper:arxiv:${record.arxiv_id.toLowerCase()}`
              : "",
            record.semantic_scholar_id
              ? `paper:semantic-scholar:${record.semantic_scholar_id.toLowerCase()}`
              : "",
          ]
        : [];
    const normalizedTitle = record.title
      .toLowerCase()
      .replaceAll(/\s+/g, " ")
      .trim();
    const syndicatedTitle =
      ["post", "community", "video"].includes(record.kind) &&
      normalizedTitle.length >= 80
        ? `syndicated:title:${normalizedTitle}`
        : "";
    return [
      ...persistent,
      syndicatedTitle,
      record.url ? `${record.kind}:url:${record.url}` : "",
      persistent.every((alias) => !alias) && !record.url
        ? `${record.kind}:title:${record.title.toLowerCase()}`
        : "",
    ].filter(Boolean);
  }

  function mergeRecords(
    primary: AiContentRecord,
    secondary: AiContentRecord,
  ): AiContentRecord {
    const vendors = [...new Set([...primary.vendors, ...secondary.vendors])];
    const primaryHasTimestamp = Boolean(
      primary.updated_at || primary.published_at,
    );
    return {
      ...primary,
      summary: primary.summary || secondary.summary,
      author: primary.author || secondary.author,
      doi: primary.doi || secondary.doi,
      arxiv_id: primary.arxiv_id || secondary.arxiv_id,
      semantic_scholar_id:
        primary.semantic_scholar_id || secondary.semantic_scholar_id,
      published_at: primary.published_at || secondary.published_at,
      updated_at: primary.updated_at || secondary.updated_at,
      timestamp_origin: primaryHasTimestamp
        ? primary.timestamp_origin
        : secondary.timestamp_origin,
      tags: [...new Set([...primary.tags, ...secondary.tags])],
      vendor: vendors.length === 1 ? vendors[0] : "unknown",
      vendors,
      metrics: { ...secondary.metrics, ...primary.metrics },
    };
  }

  for (const records of lists) {
    records.forEach((record, index) => {
      const aliases = aliasesFor(record);
      const matchedGroupIds = [
        ...new Set(
          aliases
            .map((alias) => aliasToGroup.get(alias))
            .filter((id): id is string => id !== undefined),
        ),
      ];
      const groupId = matchedGroupIds[0] ?? `group-${nextGroupId++}`;
      const current = groups.get(groupId) ?? {
        record,
        score: 0,
        refs: new Set<string>(),
        aliases: new Set<string>(),
      };

      for (const mergedId of matchedGroupIds.slice(1)) {
        const merged = groups.get(mergedId);
        if (!merged) continue;
        current.record = mergeRecords(current.record, merged.record);
        current.score += merged.score;
        for (const ref of merged.refs) current.refs.add(ref);
        for (const alias of merged.aliases) {
          current.aliases.add(alias);
          aliasToGroup.set(alias, groupId);
        }
        groups.delete(mergedId);
      }

      current.score += 1 / (60 + index + 1);
      current.refs.add(`${record.source_adapter}.${record.source_command}`);
      current.record = mergeRecords(current.record, record);
      for (const alias of aliases) {
        current.aliases.add(alias);
        aliasToGroup.set(alias, groupId);
      }
      groups.set(groupId, current);
    });
  }
  return [...groups.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ record, score, refs, aliases }) => ({
      ...record,
      id: createHash("sha256")
        .update([...aliases].sort()[0] ?? record.id)
        .digest("hex")
        .slice(0, 24),
      rrf_score: Number(score.toFixed(8)),
      source_refs: [...refs].sort(),
    }));
}

function extractMarkdownLinks(
  markdown: string,
  baseUrl: string,
  limit: number,
): Array<{ text: string; url: string }> {
  const links: Array<{ text: string; url: string }> = [];
  const seen = new Set<string>();
  for (const match of markdown.matchAll(
    /(?<!!)\[([^\]]+)]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
  )) {
    try {
      if (match[1].trim().startsWith("![")) continue;
      const url = canonicalizeAiUrl(new URL(match[2], baseUrl).toString());
      if (!url || seen.has(url)) continue;
      seen.add(url);
      links.push({ text: match[1].trim(), url });
      if (links.length >= limit) break;
    } catch {
      continue;
    }
  }
  return links;
}

export function structureAiDocument(
  url: string,
  markdown: string,
  retrievedAt: string,
  maxChars: number,
  maxLinks: number,
): Record<string, unknown> {
  const canonicalUrl = canonicalizeAiUrl(url);
  const originalCharCount = markdown.length;
  const content = markdown.slice(0, maxChars);
  const allHeadings = markdown
    .split("\n")
    .map((line) => /^(#{1,6})\s+(.+?)\s*$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      level: match[1].length,
      title: match[2]
        .replace(/\s*\[[^\]]*]\([^)]*"Permalink[^)]*\)\s*$/i, "")
        .trim(),
    }));
  const domain = domainOf(canonicalUrl);
  const firstLine = content
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const documentTitle =
    firstLine && !/^(?:#|[-*+]\s|\d+\.\s|\[)/.test(firstLine)
      ? firstLine.replace(/\s+—\s+.+$/, "").trim()
      : "";
  const title =
    documentTitle || allHeadings[0]?.title || domain || canonicalUrl;
  const vendors = inferAiVendors(
    canonicalUrl,
    `${title} ${content.slice(0, 500)}`,
  );
  const vendor = vendors.length === 1 ? vendors[0] : "unknown";
  return {
    id: createHash("sha256").update(canonicalUrl).digest("hex").slice(0, 24),
    title,
    url: canonicalUrl,
    domain,
    vendor,
    vendors,
    source_class: officialSource(canonicalUrl) ? "official" : "community",
    content_format: "markdown",
    headings: allHeadings.slice(0, 200),
    heading_count: allHeadings.length,
    links: extractMarkdownLinks(content, canonicalUrl, maxLinks),
    char_count: content.length,
    original_char_count: originalCharCount,
    truncated: originalCharCount > maxChars,
    content_sha256: createHash("sha256").update(content).digest("hex"),
    retrieved_at: retrievedAt,
    content,
  };
}
