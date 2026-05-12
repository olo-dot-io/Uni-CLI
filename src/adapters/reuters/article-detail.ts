/**
 * @owner   src/adapters/reuters/article-detail.ts
 * @does    Register agent-facing Reuters article-detail using the public Fusion content API.
 * @needs   Reuters article URLs, article-by-id-or-url-v1 envelope, robust article body extraction.
 * @feeds   surface coverage ledger, Reuters search-to-detail workflow, article reading surfaces.
 * @breaks  Reuters API query shape drift or content element changes can hide article bodies.
 */

import { cli, Strategy } from "../../registry.js";

const REUTERS_API =
  "https://www.reuters.com/pf/api/v3/content/fetch/article-by-id-or-url-v1";
const REUTERS_HOST = /^https?:\/\/(?:www\.)?reuters\.com\//i;

interface ReutersAuthor {
  name?: unknown;
  byline?: unknown;
}

interface ReutersContentElement {
  type?: unknown;
  content?: unknown;
}

interface ReutersArticle {
  title?: unknown;
  headlines?: { basic?: unknown };
  display_date?: unknown;
  published_time?: unknown;
  taxonomy?: {
    section?: {
      name?: unknown;
      path?: unknown;
    };
  };
  authors?: unknown;
  description?: { basic?: unknown };
  subheadlines?: { basic?: unknown };
  word_count?: unknown;
  canonical_url?: unknown;
  content_elements?: unknown;
}

interface ReutersEnvelope {
  result?: ReutersArticle;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function dateOnly(value: unknown): string {
  return stringField(value).split("T")[0] ?? "";
}

function absoluteReutersUrl(value: unknown, fallback: string): string {
  const raw = stringField(value);
  if (!raw) return fallback;
  return /^https?:\/\//i.test(raw) ? raw : `https://www.reuters.com${raw}`;
}

function authorNames(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((author: ReutersAuthor | string) => {
      return typeof author === "string"
        ? author
        : stringField(author.name) || stringField(author.byline);
    })
    .map((name) => name.trim())
    .filter(Boolean)
    .join(", ");
}

export function requireReutersArticleUrl(value: unknown): string {
  const url = String(value ?? "").trim();
  if (!url) throw new Error("Reuters article URL cannot be empty.");
  if (!REUTERS_HOST.test(url)) {
    throw new Error(`Reuters article URL must be on reuters.com: ${url}`);
  }
  return url;
}

export function reutersPathFromUrl(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}` || "/";
}

export function extractReutersBody(article: ReutersArticle): string {
  const elements = Array.isArray(article.content_elements)
    ? article.content_elements
    : [];
  return elements
    .filter((element): element is ReutersContentElement => {
      return typeof element === "object" && element !== null;
    })
    .filter((element) => element.type === "text")
    .map((element) => stringField(element.content))
    .filter(Boolean)
    .join("\n\n");
}

export function mapReutersArticleDetail(
  article: ReutersArticle | undefined,
  fallbackUrl: string,
): Record<string, unknown> {
  if (!article) throw new Error("Reuters article-detail returned no result.");
  const body = extractReutersBody(article);
  const title =
    stringField(article.title) || stringField(article.headlines?.basic);
  if (!title && !body) {
    throw new Error("Reuters article-detail returned no article body.");
  }
  return {
    title,
    date: dateOnly(article.display_date || article.published_time),
    section: stringField(article.taxonomy?.section?.name),
    section_path: stringField(article.taxonomy?.section?.path),
    authors: authorNames(article.authors),
    description:
      stringField(article.description?.basic) ||
      stringField(article.subheadlines?.basic),
    word_count:
      typeof article.word_count === "number" &&
      Number.isFinite(article.word_count)
        ? article.word_count
        : null,
    url: absoluteReutersUrl(article.canonical_url, fallbackUrl),
    body,
  };
}

async function fetchReutersArticle(url: string): Promise<ReutersArticle> {
  const query = JSON.stringify({
    url: reutersPathFromUrl(url),
    website: "reuters",
  });
  const apiUrl = new URL(REUTERS_API);
  apiUrl.searchParams.set("query", query);
  const response = await fetch(apiUrl, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; Uni-CLI)",
    },
  });
  if (!response.ok) {
    throw new Error(`Reuters article-detail returned HTTP ${response.status}.`);
  }
  const envelope = (await response.json()) as ReutersEnvelope;
  if (!envelope.result)
    throw new Error("Reuters article-detail returned no result.");
  return envelope.result;
}

cli({
  site: "reuters",
  name: "article-detail",
  description: "Reuters article detail with title, metadata, and body text",
  domain: "www.reuters.com",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    {
      name: "url",
      type: "str",
      required: true,
      positional: true,
      description: "Reuters article URL",
    },
  ],
  columns: [
    "title",
    "date",
    "section",
    "section_path",
    "authors",
    "description",
    "word_count",
    "url",
    "body",
  ],
  func: async (_page, kwargs) => {
    const url = requireReutersArticleUrl(kwargs.url);
    return [mapReutersArticleDetail(await fetchReutersArticle(url), url)];
  },
});
