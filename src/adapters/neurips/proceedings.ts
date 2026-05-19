/**
 * @owner       src::adapters::neurips::proceedings
 * @does        Registers NeurIPS proceedings search over the official yearly paper list.
 * @needs       proceedings.neurips.cc static HTML, src/registry.ts
 * @feeds       src/commands/scholar.ts via scholar.search, scholar.pdf, and scholar.venue
 * @breaks      NeurIPS markup drift surfaces as empty parse output; no unrelated source fallback is used.
 * @invariants  Year is explicit; paper URLs are absolutized against proceedings.neurips.cc.
 * @side-effects HTTPS egress to proceedings.neurips.cc only
 * @perf        O(N) over one proceedings HTML page
 * @concurrency safe
 * @test        tests/unit/adapters/scholar-sources.test.ts
 * @stability   experimental
 * @since       2026-05-19
 */

import { cli, Strategy } from "../../registry.js";
import type { ScholarlyWorkRecord } from "../../types/scholarly.js";

const ORIGIN = "https://proceedings.neurips.cc";

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

function requireYear(value: unknown): string {
  const year = String(value ?? "").trim();
  if (!/^\d{4}$/.test(year))
    throw new Error(`neurips year "${year}" is not valid.`);
  return year;
}

export function parseNeuripsRows(
  html: string,
  year = "2024",
): ScholarlyWorkRecord[] {
  const out: ScholarlyWorkRecord[] = [];
  const re =
    /<div class="paper-content">[\s\S]*?<a title="paper title" href="([^"]+)">([\s\S]*?)<\/a>[\s\S]*?<span class="paper-authors">([\s\S]*?)<\/span>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const sourceUrl = absolute(match[1]);
    out.push({
      id:
        sourceUrl
          .split("/")
          .pop()
          ?.replace(/\.html$/, "") ?? decode(match[2]),
      title: decode(match[2].replace(/<[^>]+>/g, " ")),
      authors: decode(match[3])
        .split(",")
        .map((author) => author.trim())
        .filter(Boolean),
      year: Number(year),
      venue: "NeurIPS",
      pdf_url: sourceUrl
        .replace("-Abstract-", "-Paper-")
        .replace(/\.html$/, ".pdf"),
      source_adapter: "neurips",
      source_url: sourceUrl,
      retrieved_at: new Date().toISOString(),
    });
  }
  return out;
}

cli({
  site: "neurips",
  name: "search",
  description: "Search NeurIPS proceedings by year",
  domain: "proceedings.neurips.cc",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "query", type: "str", required: true, positional: true },
    { name: "year", type: "str", default: "2024" },
    { name: "limit", type: "int", default: 20 },
  ],
  columns: ["id", "title", "authors", "year", "venue", "pdf_url", "source_url"],
  capabilities: [
    "http.fetch",
    "scholar.search",
    "scholar.venue",
    "scholar.pdf",
  ],
  func: async (_page, kwargs) => {
    const query = String(kwargs.query ?? "")
      .trim()
      .toLowerCase();
    if (!query) throw new Error("neurips search query cannot be empty.");
    const year = requireYear(kwargs.year);
    const response = await fetch(`${ORIGIN}/paper_files/paper/${year}`, {
      headers: {
        Accept: "text/html",
        "User-Agent":
          "unicli-neurips/1.0 (https://github.com/olo-dot-io/Uni-CLI)",
      },
    });
    if (response.status === 404)
      throw new Error(`NeurIPS ${year} returned no proceedings page.`);
    if (!response.ok)
      throw new Error(`NeurIPS ${year} returned HTTP ${response.status}.`);
    const limit = Math.min(Math.max(Number(kwargs.limit ?? 20), 1), 200);
    const rows = parseNeuripsRows(await response.text(), year)
      .filter((row) =>
        `${row.title} ${row.authors?.join(" ") ?? ""}`
          .toLowerCase()
          .includes(query),
      )
      .slice(0, limit);
    if (rows.length === 0)
      throw new Error(`No NeurIPS ${year} papers matched "${query}".`);
    return rows;
  },
});
