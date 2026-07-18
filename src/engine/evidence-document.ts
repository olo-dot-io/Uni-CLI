/**
 * @owner       src::engine::evidence-document
 * @does        Defines and constructs the domain-neutral, provenance-bearing EvidenceDocument value returned by every generic reader.
 * @needs       node:crypto and WHATWG URL
 * @feeds       evidence-reader, top-level extract, AI enrichment, and evidence-document behavior tests
 * @breaks      Inconsistent canonicalization, truncation, or hashing makes evidence impossible to compare across domain overlays.
 * @invariants  Every document identifies requested/final URL, source adapter and command, content type/format, reader, retrieval time, true original character count, and a SHA-256 hash over exactly the returned content; truncation compares the true original count, while outlines and structured payloads obey maxChars.
 * @side-effects None.
 * @perf        O(content length) structuring with bounded heading and link outputs.
 * @concurrency Pure functions are safe for concurrent callers.
 * @test        tests/unit/engine/evidence-document.test.ts, tests/unit/commands/ai.test.ts
 * @stability   experimental
 * @since       2026-07-17
 */

import { createHash } from "node:crypto";

export type EvidenceContentFormat =
  | "markdown"
  | "text"
  | "html"
  | "json"
  | "xml"
  | "pdf-text"
  | "github-thread";

export interface EvidenceDocument {
  schema_version: "evidence-document.v1";
  id: string;
  /** Canonicalized URL supplied by the caller, before redirects. */
  source_url: string;
  /** Canonicalized final response URL, or source_url when no redirect occurs. */
  url: string;
  domain: string;
  title: string;
  content_type: string;
  content_format: EvidenceContentFormat;
  source_adapter: string;
  source_command: string;
  reader: string;
  retrieved_at: string;
  http_status?: number;
  headings: Array<{ level: number; title: string }>;
  heading_count: number;
  links: Array<{ text: string; url: string }>;
  char_count: number;
  original_char_count: number;
  truncated: boolean;
  content_sha256: string;
  content: string;
  structured_data?: unknown;
  structured_data_char_count?: number;
  structured_data_truncated?: boolean;
  page_range?: { first: number; last: number };
  text_chars?: number;
  text_truncated?: boolean;
}

const MAX_TITLE_CHARS = 500;

function boundedTitle(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS);
}

export function canonicalizeUrl(raw: string): string {
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
    for (const key of trackingKeys) parsed.searchParams.delete(key);
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

function markdownLinks(
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
      const url = canonicalizeUrl(new URL(match[2], baseUrl).toString());
      if (!url || seen.has(url)) continue;
      seen.add(url);
      links.push({ text: boundedTitle(match[1]), url });
      if (links.length >= limit) break;
    } catch {
      continue;
    }
  }
  return links;
}

function markdownHeadings(
  markdown: string,
): Array<{ level: number; title: string }> {
  return markdown
    .split("\n")
    .map((line) => /^(#{1,6})\s+(.+?)\s*$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      level: match[1].length,
      title: boundedTitle(
        match[2].replace(/\s*\[[^\]]*]\([^)]*"Permalink[^)]*\)\s*$/i, ""),
      ),
    }));
}

function documentTitle(
  outline: string,
  headings: Array<{ level: number; title: string }>,
  domain: string,
  structuredData?: unknown,
): string {
  if (
    structuredData &&
    typeof structuredData === "object" &&
    !Array.isArray(structuredData)
  ) {
    const row = structuredData as Record<string, unknown>;
    for (const key of ["title", "name"]) {
      if (typeof row[key] === "string" && row[key].trim()) {
        return boundedTitle(row[key]);
      }
    }
  }
  const firstLine = outline
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const plainTitle =
    firstLine && !/^(?:#|[-*+]\s|\d+\.\s|[[\]{}])/.test(firstLine)
      ? boundedTitle(firstLine.replace(/\s+—\s+.+$/, ""))
      : "";
  return plainTitle || headings[0]?.title || boundedTitle(domain);
}

function boundedStructuredData(
  value: unknown,
  maxChars: number,
): {
  data?: unknown;
  charCount: number;
  truncated: boolean;
} {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError(
      "EvidenceDocument structured data must be JSON-serializable.",
    );
  }
  if (serialized === undefined) {
    throw new TypeError(
      "EvidenceDocument structured data must be JSON-serializable.",
    );
  }
  return serialized.length <= maxChars
    ? { data: value, charCount: serialized.length, truncated: false }
    : { charCount: serialized.length, truncated: true };
}

export function structureEvidenceDocument(input: {
  sourceUrl: string;
  finalUrl?: string;
  content: string;
  outline?: string;
  contentType: string;
  contentFormat: EvidenceContentFormat;
  sourceAdapter: string;
  sourceCommand: string;
  reader: string;
  retrievedAt: string;
  maxChars: number;
  maxLinks: number;
  httpStatus?: number;
  structuredData?: unknown;
  originalCharCount?: number;
  pageRange?: { first: number; last: number };
  textChars?: number;
  textTruncated?: boolean;
}): EvidenceDocument {
  const sourceUrl = canonicalizeUrl(input.sourceUrl);
  const url = canonicalizeUrl(input.finalUrl ?? input.sourceUrl);
  if (!sourceUrl || !url) {
    throw new TypeError("EvidenceDocument requires absolute HTTP(S) URLs.");
  }
  const domain = new URL(url).hostname.toLowerCase();
  const pathLeaf = decodeURIComponent(
    new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "",
  );
  const fallbackTitle = boundedTitle(
    pathLeaf ? `${pathLeaf} — ${domain}` : domain,
  );
  const originalCharCount = input.originalCharCount ?? input.content.length;
  if (
    !Number.isSafeInteger(originalCharCount) ||
    originalCharCount < input.content.length
  ) {
    throw new TypeError(
      "EvidenceDocument originalCharCount must be a safe integer no smaller than supplied content.",
    );
  }
  const content = input.content.slice(0, input.maxChars);
  const outline = (input.outline ?? input.content).slice(0, input.maxChars);
  const headings = markdownHeadings(outline);
  const structured =
    input.structuredData === undefined
      ? undefined
      : boundedStructuredData(input.structuredData, input.maxChars);
  return {
    schema_version: "evidence-document.v1",
    id: createHash("sha256").update(url).digest("hex").slice(0, 24),
    source_url: sourceUrl,
    url,
    domain,
    title: documentTitle(
      outline,
      headings,
      fallbackTitle,
      input.structuredData,
    ),
    content_type: input.contentType,
    content_format: input.contentFormat,
    source_adapter: input.sourceAdapter,
    source_command: input.sourceCommand,
    reader: input.reader,
    retrieved_at: input.retrievedAt,
    ...(input.httpStatus !== undefined
      ? { http_status: input.httpStatus }
      : {}),
    headings: headings.slice(0, 200),
    heading_count: headings.length,
    links: markdownLinks(outline, url, input.maxLinks),
    char_count: content.length,
    original_char_count: originalCharCount,
    truncated: originalCharCount > content.length,
    content_sha256: createHash("sha256").update(content).digest("hex"),
    content,
    ...(structured?.data !== undefined
      ? { structured_data: structured.data }
      : {}),
    ...(structured
      ? {
          structured_data_char_count: structured.charCount,
          structured_data_truncated: structured.truncated,
        }
      : {}),
    ...(input.pageRange ? { page_range: input.pageRange } : {}),
    ...(input.textChars !== undefined ? { text_chars: input.textChars } : {}),
    ...(input.textTruncated !== undefined
      ? { text_truncated: input.textTruncated }
      : {}),
  };
}

export function isDynamicDocumentShell(
  html: string,
  markdown: string,
): boolean {
  const dynamicRuntime =
    /<script\b[^>]*\btype=["']module["']/i.test(html) ||
    /(?:\bng-version\b|\bdata-reactroot\b|\b__NEXT_DATA__\b|id=["'](?:root|app|__next)["'])/i.test(
      html,
    );
  const visible = markdown
    .replace(/^#{1,6}\s+/gm, "")
    .replaceAll(/\s+/g, " ")
    .trim();
  return dynamicRuntime && visible.length < 200;
}
