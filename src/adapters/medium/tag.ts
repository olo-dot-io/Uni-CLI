/**
 * @owner   src/adapters/medium/tag.ts
 * @does    Register agent-facing Medium tag RSS reader.
 * @needs   Medium public tag RSS feed, strict tag slugs, bounded item parsing.
 * @feeds   surface coverage ledger, Medium topical article discovery, RSS reading workflows.
 * @breaks  Medium RSS shape drift or weak entity stripping degrades tag article rows.
 */

import { cli, Strategy } from "../../registry.js";

const MEDIUM_TAG_PATTERN = /^[a-z0-9][a-z0-9-]*$/i;
const MEDIUM_TAG_LIMIT = 25;
const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
};

export function requireMediumTag(value: unknown): string {
  const tag = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!tag) throw new Error("medium tag is required.");
  if (!MEDIUM_TAG_PATTERN.test(tag)) {
    throw new Error(`medium tag "${String(value)}" is not valid.`);
  }
  return tag;
}

export function requireMediumLimit(value: unknown, fallback = 20): number {
  const raw =
    value === undefined || value === null || value === "" ? fallback : value;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MEDIUM_TAG_LIMIT) {
    throw new Error(
      `medium limit must be an integer in [1, ${MEDIUM_TAG_LIMIT}].`,
    );
  }
  return limit;
}

export function decodeMediumHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/g, (match) => {
      return HTML_ENTITIES[match] ?? match;
    });
}

function extractXmlTag(block: string, tag: string): string {
  const cdata = block.match(
    new RegExp(
      `<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`,
    ),
  );
  if (cdata) return cdata[1] ?? "";
  const plain = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return plain?.[1] ?? "";
}

export function stripMediumHtml(value: unknown): string {
  return decodeMediumHtml(String(value ?? "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export function mediumRssDate(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

export function extractMediumCategories(block: string): string[] {
  const categories: string[] = [];
  const re =
    /<category(?:[^>]*)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/category>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(block)) !== null) {
    const category = decodeMediumHtml((match[1] ?? match[2] ?? "").trim());
    if (category) categories.push(category);
  }
  return categories;
}

export function parseMediumTagRss(
  xml: string,
  limit: number,
): Array<Record<string, unknown>> {
  const items: string[] = [];
  const re = /<item[^>]*>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    if (match[1]) items.push(match[1]);
  }
  if (items.length === 0) throw new Error("Medium tag RSS feed has no items.");
  return items.slice(0, limit).map((block, index) => ({
    rank: index + 1,
    title: decodeMediumHtml(extractXmlTag(block, "title")).trim(),
    author: decodeMediumHtml(extractXmlTag(block, "dc:creator")).trim(),
    description: stripMediumHtml(extractXmlTag(block, "description")),
    categories: extractMediumCategories(block).join(", "),
    published: mediumRssDate(decodeMediumHtml(extractXmlTag(block, "pubDate"))),
    url: decodeMediumHtml(extractXmlTag(block, "link")).trim(),
  }));
}

async function fetchMediumTagRss(tag: string): Promise<string> {
  const response = await fetch(`https://medium.com/feed/tag/${tag}`, {
    headers: {
      Accept: "application/rss+xml, application/xml",
      "User-Agent": "unicli-medium/1.0 (https://github.com/olo-dot-io/Uni-CLI)",
    },
  });
  if (response.status === 404)
    throw new Error(`Medium tag "${tag}" does not exist.`);
  if (!response.ok)
    throw new Error(`Medium tag returned HTTP ${response.status}.`);
  return response.text();
}

cli({
  site: "medium",
  name: "tag",
  description: "Latest Medium articles tagged with a keyword from RSS",
  domain: "medium.com",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    {
      name: "tag",
      type: "str",
      required: true,
      positional: true,
      description: "Medium tag slug",
    },
    { name: "limit", type: "int", default: 20, description: "Max articles" },
  ],
  columns: [
    "rank",
    "title",
    "author",
    "description",
    "categories",
    "published",
    "url",
  ],
  func: async (_page, kwargs) => {
    const tag = requireMediumTag(kwargs.tag);
    const limit = requireMediumLimit(kwargs.limit);
    return parseMediumTagRss(await fetchMediumTagRss(tag), limit);
  },
});
