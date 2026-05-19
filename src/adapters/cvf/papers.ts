/**
 * @owner       src::adapters::cvf::papers
 * @does        Registers CVF OpenAccess conference paper search for CVPR/ICCV/ECCV-style proceedings pages.
 * @needs       openaccess.thecvf.com static proceedings HTML, src/registry.ts
 * @feeds       src/commands/scholar.ts via scholar.search, scholar.pdf, and scholar.venue
 * @breaks      CVF markup drift surfaces as empty/parse errors rather than non-CVF fallbacks.
 * @invariants  Venue/year map to explicit CVF event pages; PDF URLs are absolutized against openaccess.thecvf.com.
 * @side-effects HTTPS egress to openaccess.thecvf.com only
 * @perf        O(N) over one proceedings HTML page
 * @concurrency safe
 * @test        tests/unit/adapters/scholar-sources.test.ts
 * @stability   experimental
 * @since       2026-05-19
 */

import { cli, Strategy } from "../../registry.js";
import type { ScholarlyWorkRecord } from "../../types/scholarly.js";

const ORIGIN = "https://openaccess.thecvf.com";

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

function eventId(venue: unknown, year: unknown): string {
  const v = String(venue ?? "CVPR")
    .trim()
    .toUpperCase();
  const y = String(year ?? "").trim();
  if (!/^(CVPR|ICCV|ECCV|WACV)$/.test(v))
    throw new Error(`unsupported CVF venue: ${v}`);
  if (!/^\d{4}$/.test(y)) throw new Error(`cvf year "${y}" is not valid.`);
  return `${v}${y}`;
}

export function parseCvfRows(
  html: string,
  event = "CVPR2024",
): ScholarlyWorkRecord[] {
  const out: ScholarlyWorkRecord[] = [];
  const re =
    /<dt class="ptitle">[\s\S]*?<a href="([^"]+)">([\s\S]*?)<\/a><\/dt>([\s\S]*?)(?=<dt class="ptitle">|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const sourceUrl = absolute(match[1]);
    const title = decode(match[2].replace(/<[^>]+>/g, " "));
    const block = match[3];
    const pdf = block.match(/<a href="([^"]+\.pdf)">pdf<\/a>/i)?.[1] ?? "";
    const authorText = block
      .replace(/\[[\s\S]*?\]/g, " ")
      .replace(/<form[\s\S]*?<\/form>/g, " ")
      .replace(/<[^>]+>/g, " ");
    const authors = decode(authorText)
      .split(",")
      .map((author) => author.trim())
      .filter(Boolean);
    out.push({
      id:
        sourceUrl
          .split("/")
          .pop()
          ?.replace(/\.html$/, "") ?? title,
      title,
      authors: authors.length > 0 ? authors : undefined,
      year: Number(event.slice(-4)),
      venue: event.replace(/\d{4}$/, ""),
      pdf_url: pdf ? absolute(pdf) : undefined,
      source_adapter: "cvf",
      source_url: sourceUrl,
      retrieved_at: new Date().toISOString(),
    });
  }
  return out;
}

cli({
  site: "cvf",
  name: "search",
  description: "Search CVF OpenAccess proceedings (CVPR/ICCV/ECCV/WACV)",
  domain: "openaccess.thecvf.com",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "query", type: "str", required: true, positional: true },
    { name: "venue", type: "str", default: "CVPR" },
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
    if (!query) throw new Error("cvf search query cannot be empty.");
    const event = eventId(kwargs.venue, kwargs.year);
    const response = await fetch(`${ORIGIN}/${event}?day=all`, {
      headers: {
        Accept: "*/*",
        "User-Agent": "unicli-cvf/1.0 (https://github.com/olo-dot-io/Uni-CLI)",
      },
    });
    if (response.status === 404)
      throw new Error(`CVF ${event} returned no proceedings page.`);
    if (!response.ok)
      throw new Error(`CVF ${event} returned HTTP ${response.status}.`);
    const limit = Math.min(Math.max(Number(kwargs.limit ?? 20), 1), 200);
    const rows = parseCvfRows(await response.text(), event)
      .filter((row) =>
        `${row.title} ${row.authors?.join(" ") ?? ""}`
          .toLowerCase()
          .includes(query),
      )
      .slice(0, limit);
    if (rows.length === 0)
      throw new Error(`No CVF ${event} papers matched "${query}".`);
    return rows;
  },
});
