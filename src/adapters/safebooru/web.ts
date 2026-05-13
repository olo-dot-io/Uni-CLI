/**
 * @owner   src/adapters/safebooru/web.ts
 * @does    Register Safebooru tag lookup for exact and prefix-style ACG tag discovery.
 * @needs   Safebooru DAPI tag XML endpoint.
 * @feeds   Booru tag discovery before image search/detail/download workflows.
 * @breaks  Safebooru DAPI XML attribute changes can block tag lookup.
 */

import { USER_AGENT } from "../../constants.js";
import { cli, Strategy } from "../../registry.js";

function str(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function required(value: unknown, label: string): string {
  const text = str(value).trim();
  if (!text) throw new Error(`safebooru ${label} cannot be empty.`);
  return text;
}

function requireLimit(value: unknown): number {
  if (value === undefined || value === null || value === "") return 20;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new Error("safebooru limit must be an integer in [1, 100].");
  }
  return n;
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function attr(source: string, name: string): string {
  const match = source.match(new RegExp(`\\b${name}="([^"]*)"`));
  return match ? decodeXml(match[1]) : "";
}

export function parseSafebooruTags(xml: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const tagRegex = /<tag\b[^>]*\/>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(xml)) !== null) {
    const raw = match[0];
    const name = attr(raw, "name");
    if (!name) continue;
    rows.push({
      rank: rows.length + 1,
      id: attr(raw, "id"),
      name,
      count: attr(raw, "count"),
      type: attr(raw, "type"),
      ambiguous: attr(raw, "ambiguous"),
      url: `https://safebooru.org/index.php?page=post&s=list&tags=${encodeURIComponent(name)}`,
    });
  }
  return rows;
}

export function mergeSafebooruTags(
  groups: Record<string, unknown>[][],
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const row of group) {
      const name = str(row.name);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      rows.push({ ...row, rank: rows.length + 1 });
    }
  }
  return rows;
}

async function fetchTagRows(url: URL): Promise<Record<string, unknown>[]> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/xml,text/xml",
      "User-Agent": USER_AGENT,
    },
  });
  if (!response.ok)
    throw new Error(`safebooru request failed with HTTP ${response.status}.`);
  return parseSafebooruTags(await response.text());
}

function tagUrl(kind: "name" | "name_pattern", query: string, limit: number) {
  const url = new URL("https://safebooru.org/index.php");
  url.searchParams.set("page", "dapi");
  url.searchParams.set("s", "tag");
  url.searchParams.set("q", "index");
  url.searchParams.set(kind, query);
  url.searchParams.set("limit", String(limit));
  return url;
}

async function searchTags(kwargs: Record<string, unknown>) {
  const query = required(kwargs.query, "query");
  const limit = requireLimit(kwargs.limit);
  const rows = mergeSafebooruTags([
    await fetchTagRows(tagUrl("name", query, 1)),
    await fetchTagRows(tagUrl("name_pattern", query, limit)),
  ]).slice(0, limit);
  if (rows.length === 0)
    throw new Error(`No Safebooru tags found for "${query}".`);
  return rows;
}

cli({
  site: "safebooru",
  name: "tags",
  description:
    "Search Safebooru tags by exact tag name or ASCII tag prefix such as blue_archive",
  domain: "safebooru.org",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: "query", type: "str", required: true, positional: true },
    { name: "limit", type: "int", default: 20 },
  ],
  columns: ["rank", "id", "name", "count", "type", "ambiguous", "url"],
  func: async (_page, kwargs) => searchTags(kwargs),
});
