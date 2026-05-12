/**
 * @owner   src/adapters/mdn/search.ts
 * @does    Register agent-facing MDN Web Docs search command.
 * @needs   MDN public search API, bounded limits, locale allowlist.
 * @feeds   surface coverage ledger, web-platform documentation search rows.
 * @breaks  MDN API drift, weak locale validation, or silent empty rows hide documentation lookup failures.
 */

import { cli, Strategy } from "../../registry.js";

const API_BASE = "https://developer.mozilla.org";
const LOCALES = new Set([
  "de",
  "en-US",
  "es",
  "fr",
  "ja",
  "ko",
  "pt-BR",
  "ru",
  "zh-CN",
  "zh-TW",
]);

function requireNonEmpty(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`mdn ${label} cannot be empty.`);
  return text;
}

export function requireMdnLimit(value: unknown): number {
  const raw =
    value === undefined || value === null || value === "" ? 10 : value;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("mdn limit must be an integer in [1, 50].");
  }
  return limit;
}

export function requireMdnLocale(value: unknown): string {
  const locale = String(value ?? "en-US").trim();
  if (!LOCALES.has(locale)) {
    throw new Error(`mdn locale "${String(value)}" is not supported.`);
  }
  return locale;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function mapMdnRows(
  documents: Array<Record<string, unknown>>,
  limit: number,
  fallbackLocale: string,
): Array<Record<string, unknown>> {
  return documents.slice(0, limit).map((doc, index) => {
    const mdnUrl = stringField(doc.mdn_url);
    return {
      rank: index + 1,
      title: stringField(doc.title),
      slug: stringField(doc.slug),
      locale: stringField(doc.locale) || fallbackLocale,
      summary: stringField(doc.summary).replace(/\s+/g, " "),
      url: mdnUrl ? `${API_BASE}${mdnUrl}` : "",
    };
  });
}

async function fetchJson(url: URL | string, label: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "unicli-mdn (https://github.com/olo-dot-io/Uni-CLI)",
    },
  });
  if (response.status === 404) throw new Error(`${label} returned no result.`);
  if (response.status === 429) throw new Error(`${label} returned HTTP 429.`);
  if (!response.ok)
    throw new Error(`${label} returned HTTP ${response.status}.`);
  return response.json();
}

cli({
  site: "mdn",
  name: "search",
  description: "Search MDN Web Docs by keyword",
  domain: "developer.mozilla.org",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "query",
      type: "str",
      required: true,
      positional: true,
      description: "Search keyword",
    },
    { name: "limit", type: "int", default: 10, description: "Max rows" },
    {
      name: "locale",
      type: "str",
      default: "en-US",
      description: "MDN locale",
    },
  ],
  columns: ["rank", "title", "slug", "locale", "summary", "url"],
  func: async (_page, kwargs) => {
    const query = requireNonEmpty(kwargs.query, "query");
    const limit = requireMdnLimit(kwargs.limit);
    const locale = requireMdnLocale(kwargs.locale);
    const url = new URL(`${API_BASE}/api/v1/search`);
    url.searchParams.set("q", query);
    url.searchParams.set("locale", locale);
    url.searchParams.set("size", String(limit));
    const body = (await fetchJson(url, "mdn search")) as {
      documents?: unknown;
    };
    const rows = mapMdnRows(
      Array.isArray(body.documents)
        ? (body.documents as Array<Record<string, unknown>>)
        : [],
      limit,
      locale,
    );
    if (rows.length === 0) {
      throw new Error(
        `mdn search returned no rows for "${query}" (${locale}).`,
      );
    }
    return rows;
  },
});
