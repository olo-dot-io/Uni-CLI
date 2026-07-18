/**
 * @owner       src::commands::ai-content
 * @does        Defines the AI content record and pure domain enrichment, normalization, and fusion over the generic evidence and retrieval contracts.
 * @needs       node:crypto, WHATWG URL, AI landscape identities, and the pure EvidenceDocument value boundary
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
import {
  canonicalizeUrl,
  structureEvidenceDocument,
  type EvidenceDocument,
} from "../engine/evidence-document.js";
import type { RetrievalResultKind, RetrievalSourceClass } from "../types.js";

export type AiContentKind = RetrievalResultKind;

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
  | "alibaba-thead"
  | "kunlunxin"
  | "cambricon"
  | "hugging-face"
  | "github"
  | "unknown";

export type AiSourceClass = RetrievalSourceClass;

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
  hosting_platform: string;
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

const HARDWARE_VENDOR_IDS = new Set<AiVendor>([
  "nvidia",
  "amd",
  "huawei-ascend",
  "intel-ai",
  "aws-neuron",
  "google-tpu",
  "cerebras",
  "groq",
  "tenstorrent",
  "sambanova",
  "apple-mlx",
  "qualcomm-ai",
  "alibaba-thead",
  "kunlunxin",
  "cambricon",
]);

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
  return canonicalizeUrl(raw);
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
  const catalogOwner = identifyAiPrimarySource(url);
  if (catalogOwner && HARDWARE_VENDOR_IDS.has(catalogOwner.id as AiVendor)) {
    return [catalogOwner.id as AiVendor];
  }
  if (/(^|\.)nvidia\.com$/.test(domain)) return ["nvidia"];
  if (/(^|\.)amd\.com$/.test(domain)) return ["amd"];
  if (/(^|\.)(hiascend|huawei)\.com$/.test(domain)) {
    return ["huawei-ascend"];
  }
  if (/(^|\.)t-head\.cn$/.test(domain)) return ["alibaba-thead"];
  if (/(^|\.)kunlunxin\.com$/.test(domain)) return ["kunlunxin"];
  if (/(^|\.)cambricon\.com$/.test(domain)) return ["cambricon"];
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
  if (
    /\b(?:Alibaba T-Head|T-Head|Hanguang)\b/i.test(corpus) ||
    /平头哥|含光/.test(corpus)
  ) {
    vendors.push("alibaba-thead");
  }
  if (/\b(?:Kunlunxin|Kunlun XPU)\b/i.test(corpus) || /昆仑芯/.test(corpus)) {
    vendors.push("kunlunxin");
  }
  if (
    /\b(?:Cambricon|MagicMind|Neuware|BANG C|MLU\d*)\b/i.test(corpus) ||
    /寒武纪/.test(corpus)
  ) {
    vendors.push("cambricon");
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

function hostedArtifact(url: string, kind?: AiContentKind): boolean {
  const domain = domainOf(url);
  const artifactKind =
    kind !== undefined && ["paper", "model", "dataset", "space"].includes(kind);
  if (
    artifactKind &&
    [
      "huggingface.co",
      "openreview.net",
      "openalex.org",
      "arxiv.org",
      "semanticscholar.org",
      "aclanthology.org",
      "doi.org",
      "modelscope.cn",
      "modelscope.ai",
      "opencsg.com",
      "hub.opencsg.com",
      "openrouter.ai",
      "kaggle.com",
    ].some((host) => domain === host || domain.endsWith(`.${host}`))
  ) {
    return true;
  }
  try {
    const parsed = new URL(url);
    if (
      domain === "huggingface.co" &&
      /^\/(?:papers|models|datasets|spaces)\//.test(parsed.pathname)
    ) {
      return true;
    }
    if (
      domain === "openreview.net" &&
      /^\/(?:forum|pdf)(?:\/|$)/.test(parsed.pathname)
    ) {
      return true;
    }
    if (
      domain === "arxiv.org" &&
      /^\/(?:abs|pdf)(?:\/|$)/.test(parsed.pathname)
    ) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function officialSource(url: string, kind?: AiContentKind): boolean {
  const domain = domainOf(url);
  if (domain === "docs.github.com") return true;
  if (hostedArtifact(url, kind)) return false;
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
    const isOfficial = officialSource(url, source.kind);
    const sourceClass = isOfficial
      ? "official"
      : hostedArtifact(url, source.kind)
        ? "hosted-artifact"
        : source.sourceClass;
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
        (isOfficial ? primarySource?.name : "") ||
        author ||
        (vendor !== "unknown" ? vendor : domain),
      hosting_platform: primarySource?.name ?? source.site,
      organization: isOfficial ? (primarySource?.name ?? "") : "",
      organization_type: isOfficial
        ? (primarySource?.type ?? "unknown")
        : "unknown",
      primary_source_id: isOfficial ? (primarySource?.id ?? "") : "",
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

export function structureAiDocument(
  url: string,
  markdown: string,
  retrievedAt: string,
  maxChars: number,
  maxLinks: number,
): Record<string, unknown> {
  const evidence = structureEvidenceDocument({
    sourceUrl: url,
    content: markdown,
    contentType: "text/markdown",
    contentFormat: "markdown",
    sourceAdapter: "web",
    sourceCommand: "read",
    reader: "direct",
    retrievedAt,
    maxChars,
    maxLinks,
  });
  return enrichAiEvidenceDocument(evidence);
}

export function enrichAiEvidenceDocument(
  evidence: EvidenceDocument,
): Record<string, unknown> {
  const primarySource = identifyAiPrimarySource(evidence.url);
  const vendors = inferAiVendors(
    evidence.url,
    `${evidence.title} ${evidence.content.slice(0, 500)}`,
  );
  const vendor = vendors.length === 1 ? vendors[0] : "unknown";
  const isOfficial = officialSource(evidence.url);
  const sourceClass = isOfficial
    ? "official"
    : hostedArtifact(evidence.url)
      ? "hosted-artifact"
      : "community";
  return {
    ...evidence,
    vendor,
    vendors,
    source_class: sourceClass,
    organization: isOfficial ? (primarySource?.name ?? "") : "",
    organization_type: isOfficial
      ? (primarySource?.type ?? "unknown")
      : "unknown",
    primary_source_id: isOfficial ? (primarySource?.id ?? "") : "",
  };
}
