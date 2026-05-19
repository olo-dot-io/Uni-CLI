/**
 * @owner       src::adapters::acl-anthology::papers
 * @does        Registers ACL Anthology paper search and event proceedings listing from official Anthology pages.
 * @needs       aclanthology.org static search/event HTML, src/registry.ts
 * @feeds       src/commands/scholar.ts via scholar.search, scholar.get, scholar.pdf, and scholar.venue
 * @breaks      ACL Anthology markup drift surfaces as empty parse output; no browser workaround is used.
 * @invariants  Paper URLs/PDF URLs are absolutized against aclanthology.org; event keys are explicit.
 * @side-effects HTTPS egress to aclanthology.org only
 * @perf        O(N) over one HTML response
 * @concurrency safe
 * @test        covered by scholar command discovery and parser style tests for sibling proceedings sources
 * @stability   experimental
 * @since       2026-05-19
 */

import { cli, Strategy } from "../../registry.js";
import type { ScholarlyWorkRecord } from "../../types/scholarly.js";

const ORIGIN = "https://aclanthology.org";

function decode(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function absolute(path: string): string {
  return /^https?:\/\//i.test(path)
    ? path
    : `${ORIGIN}${path.startsWith("/") ? "" : "/"}${path}`;
}

function normalizeId(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!/^[A-Za-z0-9.-]+$/.test(raw)) {
    throw new Error(`ACL Anthology id "${raw}" is not valid.`);
  }
  return raw.replace(/\.$/, "");
}

function parseRows(
  html: string,
  source = "acl-anthology",
): ScholarlyWorkRecord[] {
  const out: ScholarlyWorkRecord[] = [];
  const re =
    /<p class="d-sm-flex[^"]*">[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<p class="d-sm-flex|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const sourceUrl = absolute(match[1]);
    const id = sourceUrl.replace(`${ORIGIN}/`, "").replace(/\/$/, "");
    const block = match[3];
    const pdf = block.match(/href="([^"]+\.pdf)"/i)?.[1] ?? "";
    const authorText = block
      .replace(/<span class="d-block">[\s\S]*?<\/span>/g, " ")
      .replace(/<[^>]+>/g, " ");
    const authors = decode(authorText)
      .split(/,\s*/)
      .map((author) => author.trim())
      .filter(Boolean)
      .slice(0, 20);
    out.push({
      id,
      title: decode(match[2].replace(/<[^>]+>/g, " ")),
      authors: authors.length > 0 ? authors : undefined,
      year: Number(id.slice(0, 4)) || undefined,
      venue: "ACL Anthology",
      pdf_url: pdf ? absolute(pdf) : `${sourceUrl}.pdf`,
      source_adapter: source,
      source_url: sourceUrl,
      retrieved_at: new Date().toISOString(),
    });
  }
  return out;
}

async function fetchHtml(url: string, label: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      Accept: "text/html",
      "User-Agent":
        "unicli-acl-anthology/1.0 (https://github.com/olo-dot-io/Uni-CLI)",
    },
  });
  if (response.status === 404) throw new Error(`${label} returned no result.`);
  if (!response.ok)
    throw new Error(`${label} returned HTTP ${response.status}.`);
  return response.text();
}

cli({
  site: "acl-anthology",
  name: "search",
  description: "Search ACL Anthology papers",
  domain: "aclanthology.org",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "query", type: "str", required: true, positional: true },
    { name: "limit", type: "int", default: 20 },
  ],
  columns: ["id", "title", "authors", "year", "venue", "pdf_url", "source_url"],
  capabilities: ["http.fetch", "scholar.search", "scholar.pdf"],
  func: async (_page, kwargs) => {
    const query = String(kwargs.query ?? "").trim();
    if (!query) throw new Error("acl-anthology search query cannot be empty.");
    const limit = Math.min(Math.max(Number(kwargs.limit ?? 20), 1), 100);
    const rows = parseRows(
      await fetchHtml(
        `${ORIGIN}/search/?q=${encodeURIComponent(query)}`,
        "acl-anthology search",
      ),
    ).slice(0, limit);
    if (rows.length === 0)
      throw new Error(`No ACL Anthology papers matched "${query}".`);
    return rows;
  },
});

cli({
  site: "acl-anthology",
  name: "paper",
  description: "Fetch an ACL Anthology paper by anthology id",
  domain: "aclanthology.org",
  strategy: Strategy.PUBLIC,
  args: [{ name: "id", type: "str", required: true, positional: true }],
  columns: ["id", "title", "authors", "year", "venue", "pdf_url", "source_url"],
  capabilities: ["http.fetch", "scholar.get", "scholar.pdf"],
  func: async (_page, kwargs) => {
    const id = normalizeId(kwargs.id ?? kwargs.ref);
    const html = await fetchHtml(
      `${ORIGIN}/${id}/`,
      `acl-anthology paper ${id}`,
    );
    const title = decode(
      html.match(/<h2[^>]*id=title[^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? "",
    );
    if (!title)
      throw new Error(`ACL Anthology paper ${id} did not expose a title.`);
    return [
      {
        id,
        title,
        year: Number(id.slice(0, 4)) || undefined,
        venue: "ACL Anthology",
        pdf_url: `${ORIGIN}/${id}.pdf`,
        source_adapter: "acl-anthology",
        source_url: `${ORIGIN}/${id}/`,
        retrieved_at: new Date().toISOString(),
      } satisfies ScholarlyWorkRecord,
    ];
  },
});
