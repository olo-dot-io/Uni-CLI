/**
 * @owner   src/adapters/moegirl/web.ts
 * @does    Register Moegirl public search, page reading, and article link extraction commands.
 * @needs   Moegirl public OpenSearch endpoint and rendered MediaWiki HTML.
 * @feeds   ACG entity discovery, character disambiguation, and wiki-backed content research.
 * @breaks  Moegirl skin/template markup drift can reduce page and link extraction quality.
 */

import { USER_AGENT } from "../../constants.js";
import { cli, Strategy } from "../../registry.js";

const ORIGIN = "https://zh.moegirl.org.cn";

interface SearchRow {
  rank: number;
  title: string;
  description: string;
  url: string;
}

interface LinkRow {
  rank: number;
  title: string;
  url: string;
}

function str(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function decodeHtml(value: unknown): string {
  return decodeHtmlEntities(value).replace(/\s+/g, " ").trim();
}

function decodeHtmlText(value: unknown): string {
  return decodeHtmlEntities(value)
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtmlEntities(value: unknown): string {
  return str(value)
    .replace(/&#(\d+);/g, (_m, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'");
}

function requireText(value: unknown, label: string): string {
  const text = str(value).trim();
  if (!text) throw new Error(`moegirl ${label} cannot be empty.`);
  return text;
}

function requireLimit(value: unknown, fallback = 10): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    throw new Error("moegirl limit must be an integer in [1, 50].");
  }
  return n;
}

function requireParagraphCap(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 100) {
    throw new Error("moegirl paragraphs must be an integer in [0, 100].");
  }
  return n;
}

function articleUrl(title: string): string {
  return `${ORIGIN}/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
  });
  if (!response.ok) {
    throw new Error(`moegirl request failed with HTTP ${response.status}.`);
  }
  return response.json();
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": USER_AGENT,
    },
  });
  if (!response.ok) {
    throw new Error(`moegirl request failed with HTTP ${response.status}.`);
  }
  return response.text();
}

export function mapMoegirlOpenSearch(
  data: unknown,
  limit: number,
): SearchRow[] {
  if (
    !Array.isArray(data) ||
    !Array.isArray(data[1]) ||
    !Array.isArray(data[3])
  ) {
    throw new Error("moegirl OpenSearch response shape changed.");
  }
  const titles = data[1] as unknown[];
  const descriptions = Array.isArray(data[2]) ? (data[2] as unknown[]) : [];
  const urls = data[3] as unknown[];
  return titles.slice(0, limit).map((title, index) => ({
    rank: index + 1,
    title: str(title),
    description: str(descriptions[index]),
    url: str(urls[index]),
  }));
}

function firstMatch(value: string, re: RegExp): string {
  const match = value.match(re);
  return match ? decodeHtml(match[1]) : "";
}

function bodyHtml(html: string): string {
  return (
    firstRawMatch(
      html,
      /<template id="MOE_SKIN_TEMPLATE_BODYCONTENT">([\s\S]*?)<\/template>/,
    ) ||
    firstRawMatch(
      html,
      /<div[^>]+class="[^"]*\bmw-parser-output\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/,
    ) ||
    html
  );
}

function firstRawMatch(value: string, re: RegExp): string {
  const match = value.match(re);
  return match ? match[1] : "";
}

function cleanArticleText(html: string): string {
  return decodeHtmlText(
    bodyHtml(html)
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<sup[\s\S]*?<\/sup>/gi, " ")
      .replace(/<\/(?:p|li|h[1-6]|tr)>/gi, "\n\n")
      .replace(/<(?:br|div)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/\n\s+/g, "\n")
      .replace(/\n{3,}/g, "\n\n"),
  );
}

export function parseMoegirlPageHtml(
  html: string,
  requestedTitle: string,
  paragraphCap: number,
): Record<string, unknown> {
  const pageTitle =
    firstMatch(html, /<title>([^<]+?)(?: - 萌娘百科[^<]*)?<\/title>/) ||
    firstMatch(
      html,
      /<meta property="og:title" content="(?:&lt;[^&]+&gt;)?([^"<]+)(?:&lt;\/[^&]+&gt;)?"/,
    ) ||
    requestedTitle;
  const title = requestedTitle.includes("(") ? requestedTitle : pageTitle;
  const description =
    firstMatch(html, /<meta name="description" content="([^"]*)"/) ||
    firstMatch(html, /<meta property="og:description" content="([^"]*)"/);
  const url =
    firstMatch(html, /<link rel="canonical" href="([^"]+)"/) ||
    articleUrl(title);
  const categories = [...html.matchAll(/"wgCategories":\[(.*?)\]/g)][0]?.[1]
    ?.split(",")
    .map((item) => decodeHtml(item.replace(/^"|"$/g, "")))
    .filter(Boolean);
  const text = cleanArticleText(html);
  if (!text) {
    throw new Error(
      `Moegirl article "${requestedTitle}" has no readable text.`,
    );
  }
  const paragraphs = text
    .split(/\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const selected =
    paragraphCap > 0 ? paragraphs.slice(0, paragraphCap) : paragraphs;
  return {
    title,
    description,
    categories: categories ?? [],
    paragraphs: selected.length,
    extract: selected.join("\n\n"),
    url,
  };
}

export function parseMoegirlLinksHtml(
  html: string,
  limit: number,
  contains: string,
): LinkRow[] {
  const rows: LinkRow[] = [];
  const seen = new Set<string>();
  const needle = contains.trim();
  for (const match of bodyHtml(html).matchAll(
    /<a\b(?=[^>]*\bhref="([^"]+)")(?=[^>]*\btitle="([^"]+)")[^>]*>/g,
  )) {
    const href = decodeHtml(match[1]);
    const title = decodeHtml(match[2]);
    if (!href.startsWith("/") || href.includes("redlink=1")) continue;
    if (title.includes("页面不存在")) continue;
    if (needle && !title.includes(needle)) continue;
    const key = `${title}\n${href}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      rank: rows.length + 1,
      title,
      url: `${ORIGIN}${href}`,
    });
    if (rows.length >= limit) break;
  }
  return rows;
}

cli({
  site: "moegirl",
  name: "search",
  description:
    "Search Moegirl ACG wiki articles for characters, works, songs, games, and studios",
  domain: "zh.moegirl.org.cn",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: "query", type: "str", required: true, positional: true },
    { name: "limit", type: "int", default: 10 },
  ],
  columns: ["rank", "title", "description", "url"],
  func: async (_page, kwargs) => {
    const query = requireText(kwargs.query, "query");
    const limit = requireLimit(kwargs.limit);
    const url = new URL(`${ORIGIN}/api.php`);
    url.searchParams.set("action", "opensearch");
    url.searchParams.set("search", query);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("namespace", "0");
    url.searchParams.set("format", "json");
    const rows = mapMoegirlOpenSearch(await fetchJson(url.toString()), limit);
    if (rows.length === 0)
      throw new Error(`No Moegirl pages found for "${query}".`);
    return rows;
  },
});

cli({
  site: "moegirl",
  name: "page",
  description: "Read a Moegirl article as plain text with metadata",
  domain: "zh.moegirl.org.cn",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: "title", type: "str", required: true, positional: true },
    {
      name: "paragraphs",
      type: "int",
      default: 0,
      description: "Paragraph cap, 0 means full",
    },
  ],
  columns: [
    "title",
    "description",
    "categories",
    "paragraphs",
    "extract",
    "url",
  ],
  func: async (_page, kwargs) => {
    const title = requireText(kwargs.title, "title");
    const paragraphCap = requireParagraphCap(kwargs.paragraphs);
    return [
      parseMoegirlPageHtml(
        await fetchText(articleUrl(title)),
        title,
        paragraphCap,
      ),
    ];
  },
});

cli({
  site: "moegirl",
  name: "links",
  description:
    "Extract internal Moegirl article links from a page, useful for disambiguation pages",
  domain: "zh.moegirl.org.cn",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: "title", type: "str", required: true, positional: true },
    { name: "limit", type: "int", default: 20 },
    {
      name: "contains",
      type: "str",
      description: "Only return links whose title contains this text",
    },
  ],
  columns: ["rank", "title", "url"],
  func: async (_page, kwargs) => {
    const title = requireText(kwargs.title, "title");
    const rows = parseMoegirlLinksHtml(
      await fetchText(articleUrl(title)),
      requireLimit(kwargs.limit),
      str(kwargs.contains),
    );
    if (rows.length === 0)
      throw new Error(`No Moegirl links found on "${title}".`);
    return rows;
  },
});
