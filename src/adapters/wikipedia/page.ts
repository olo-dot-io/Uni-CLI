/**
 * @owner   src/adapters/wikipedia/page.ts
 * @does    Register agent-facing full Wikipedia page extract command.
 * @needs   MediaWiki Action API, language validation, explicit paragraph caps.
 * @feeds   surface coverage ledger, encyclopedia article reading workflow.
 * @breaks  MediaWiki envelope drift or silent extract truncation hides article content.
 */

import { cli, Strategy } from "../../registry.js";

interface WikiPage {
  title?: unknown;
  description?: unknown;
  pageid?: unknown;
  extract?: unknown;
  fullurl?: unknown;
  missing?: unknown;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function requireWikiTitle(value: unknown): string {
  const title = String(value ?? "").trim();
  if (!title) throw new Error("wikipedia page title cannot be empty.");
  return title;
}

export function requireWikiLang(value: unknown): string {
  const lang = String(value ?? "en")
    .trim()
    .toLowerCase();
  if (!/^[a-z]{2,3}(?:-[a-z0-9]+)?$/.test(lang)) {
    throw new Error(
      `wikipedia lang must be a language code, got "${String(value)}".`,
    );
  }
  return lang;
}

export function requireParagraphCap(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error("paragraphs must be a non-negative integer.");
  }
  return n;
}

export function mapWikipediaPageRow(
  page: WikiPage | undefined,
  lang: string,
  requestedTitle: string,
  paragraphCap: number,
): Record<string, unknown> {
  if (!page || page.missing) {
    throw new Error(
      `No Wikipedia article "${requestedTitle}" on ${lang}.wikipedia.org.`,
    );
  }
  const fullExtract = stringField(page.extract);
  if (!fullExtract.trim()) {
    throw new Error(
      `Wikipedia article "${stringField(page.title) || requestedTitle}" has no plain-text extract.`,
    );
  }
  const paragraphs = fullExtract
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  const selected =
    paragraphCap > 0 ? paragraphs.slice(0, paragraphCap) : paragraphs;
  const title = stringField(page.title) || requestedTitle;
  return {
    title,
    description: stringField(page.description),
    pageId: page.pageid ?? null,
    paragraphs: selected.length,
    extract: selected.join("\n\n"),
    url:
      stringField(page.fullurl) ||
      `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
  };
}

async function fetchWikipediaPage(
  lang: string,
  title: string,
): Promise<WikiPage> {
  const url = new URL(`https://${lang}.wikipedia.org/w/api.php`);
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  url.searchParams.set("prop", "extracts|info|description");
  url.searchParams.set("inprop", "url");
  url.searchParams.set("explaintext", "1");
  url.searchParams.set("redirects", "1");
  url.searchParams.set("titles", title);

  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "unicli-wikipedia/1.0 (https://github.com/olo-dot-io/Uni-CLI)",
      Accept: "application/json",
    },
  });
  if (!response.ok)
    throw new Error(`wikipedia page returned HTTP ${response.status}.`);
  const data = (await response.json()) as {
    error?: { code?: unknown; info?: unknown };
    query?: { pages?: WikiPage[] };
  };
  if (data.error) {
    throw new Error(
      `wikipedia API error: ${stringField(data.error.info) || stringField(data.error.code)}`,
    );
  }
  return Array.isArray(data.query?.pages) ? data.query.pages[0] : {};
}

cli({
  site: "wikipedia",
  name: "page",
  description: "Full plain-text extract of a Wikipedia article",
  domain: "wikipedia.org",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "title",
      type: "str",
      required: true,
      positional: true,
      description: "Article title",
    },
    { name: "lang", type: "str", default: "en", description: "Language code" },
    {
      name: "paragraphs",
      type: "int",
      default: 0,
      description: "Paragraph cap, 0 means full",
    },
  ],
  columns: ["title", "description", "pageId", "paragraphs", "extract", "url"],
  func: async (_page, kwargs) => {
    const title = requireWikiTitle(kwargs.title);
    const lang = requireWikiLang(kwargs.lang);
    const paragraphCap = requireParagraphCap(kwargs.paragraphs);
    return [
      mapWikipediaPageRow(
        await fetchWikipediaPage(lang, title),
        lang,
        title,
        paragraphCap,
      ),
    ];
  },
});
