/**
 * @owner       src::adapters::google-scholar::search
 * @does        Registers Google Scholar public browser search as a broad discovery source for scholarly metadata.
 * @needs       scholar.google.com result DOM, src/registry.ts, src/types.ts, browser tools
 * @feeds       src/commands/scholar.ts capability discovery, `unicli google-scholar search`, `unicli scholar search/doctor`
 * @breaks      Google Scholar CAPTCHA/traffic blocks surface as upstream_blocked; result DOM drift can return empty rows instead of normalized scholarly records.
 * @invariants  Search is metadata discovery only; result links are source hints, not full-text proof; publication years must be standalone years, never substrings of arXiv IDs.
 * @side-effects Navigates a Uni-CLI managed browser page to Google Scholar public search.
 * @perf        O(limit) DOM extraction after one page navigation.
 * @concurrency safe — command state is page-local
 * @test        tests/unit/adapters/scholar-sources.test.ts; live smoke via `unicli google-scholar search <query>` and `unicli scholar doctor --sources google-scholar --live`
 * @stability   experimental
 * @since       2026-06-27
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { intArg, js, str } from "../_shared/browser-tools.js";

interface GoogleScholarRawRow {
  rank?: unknown;
  title?: unknown;
  infoLine?: unknown;
  citedText?: unknown;
  url?: unknown;
}

interface GoogleScholarBrowserPayload {
  blocked?: boolean;
  block_reason?: unknown;
  rows?: unknown;
}

type GoogleScholarActionableError = Error & {
  code?: string;
  suggestion?: string;
  retryable?: boolean;
};

export function buildGoogleScholarSearchUrl(query: string): string {
  return `https://scholar.google.com/scholar?q=${encodeURIComponent(query)}&hl=en`;
}

export function parseGoogleScholarYear(infoLine: string): number | undefined {
  for (const match of infoLine.matchAll(/(^|[^\d])((?:19|20)\d{2})(?!\d)/g)) {
    const year = Number(match[2]);
    if (Number.isInteger(year)) return year;
  }
  return undefined;
}

export function parseGoogleScholarInfoLine(infoLine: string): {
  authors?: string;
  venue?: string;
  year?: number;
} {
  const parts = infoLine.split(" - ");
  const authors = parts[0]?.trim() || undefined;
  const detail = parts[1]?.trim() || "";
  const detailParts = detail.split(",");
  const venue =
    detailParts.slice(0, -1).join(",").trim() ||
    detailParts[0]?.trim() ||
    undefined;
  return {
    authors,
    venue,
    year: parseGoogleScholarYear(infoLine),
  };
}

export function googleScholarRecordId(
  title: string,
  sourceUrl: string,
): string {
  if (sourceUrl) {
    try {
      const parsed = new URL(sourceUrl);
      if (parsed.hostname === "arxiv.org") {
        const arxivId = parsed.pathname
          .replace(/^\/(?:abs|pdf)\//, "")
          .replace(/\.pdf$/i, "")
          .replace(/v\d+$/i, "");
        if (/^\d{4}\.\d{4,5}$/.test(arxivId)) return arxivId;
      }
      if (parsed.hostname === "doi.org") {
        const doi = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
        if (doi) return doi;
      }
    } catch {
      return sourceUrl;
    }
    return sourceUrl;
  }
  return title;
}

function normalize(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function googleScholarBlockedError(
  reason: string,
): GoogleScholarActionableError {
  const error = new Error(
    `Google Scholar blocked the public browser search: ${reason}.`,
  ) as GoogleScholarActionableError;
  error.code = "upstream_blocked";
  error.suggestion =
    "Retry later, import a usable browser session, or use first-source alternatives such as semantic-scholar/openalex/crossref/arxiv for non-hallucinated scholarly lookup.";
  error.retryable = true;
  return error;
}

function mapGoogleScholarRow(
  raw: GoogleScholarRawRow,
): Record<string, unknown> | undefined {
  const title = normalize(raw.title);
  if (!title) return undefined;
  const sourceUrl = normalize(raw.url);
  const info = parseGoogleScholarInfoLine(normalize(raw.infoLine));
  const citedText = normalize(raw.citedText);
  const citedByCount = Number(citedText.match(/\d+/)?.[0] ?? 0);
  return {
    id: googleScholarRecordId(title, sourceUrl),
    rank: Number(raw.rank) || undefined,
    title,
    authors: info.authors,
    source: info.venue,
    venue: info.venue,
    year: info.year,
    cited: String(citedByCount),
    cited_by_count: citedByCount,
    source_url: sourceUrl || undefined,
    url: sourceUrl || undefined,
  };
}

cli({
  site: "google-scholar",
  name: "search",
  description: "Search Google Scholar papers",
  domain: "scholar.google.com",
  strategy: Strategy.PUBLIC,
  browser: true,
  args: [
    { name: "query", type: "str", required: true, positional: true },
    { name: "limit", type: "int", default: 10 },
  ],
  columns: ["rank", "title", "authors", "source", "year", "cited", "url"],
  capabilities: [
    "cdp-browser.navigate",
    "cdp-browser.evaluate",
    "scholar.search",
  ],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const limit = intArg(kwargs.limit, 10, 20);
    await p.goto(buildGoogleScholarSearchUrl(str(kwargs.query)), {
      settleMs: 2500,
    });
    const payload = (await p.evaluate(`(() => {
      const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      const bodyText = normalize(document.body?.innerText || document.body?.textContent || '');
      const blocked =
        location.pathname.includes('/sorry/') ||
        document.querySelector('form[action*="/sorry/"], input[name="captcha"], #gs_captcha_ccl, iframe[src*="recaptcha"]') ||
        /unusual traffic|not a robot|captcha/i.test(bodyText);
      if (blocked) {
        return {
          blocked: true,
          block_reason: document.title || bodyText.slice(0, 160) || location.href,
          rows: []
        };
      }
      const seen = new Set();
      const rows = [];
      const cards = [...document.querySelectorAll('.gs_r.gs_or.gs_scl, .gs_r.gs_or')];
      for (const card of cards) {
        const body = card.querySelector('.gs_ri') || card;
        const link = body.querySelector('.gs_rt a, h3 a');
        const title = normalize(body.querySelector('.gs_rt, h3')?.textContent);
        if (!title) continue;
        const url = link ? new URL(link.getAttribute('href') || '', location.href).href : '';
        const dedupeKey = url || title.toLowerCase();
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const citedText = normalize(body.querySelector('.gs_fl a[href*="cites"]')?.textContent);
        rows.push({
          rank: rows.length + 1,
          title,
          infoLine: normalize(body.querySelector('.gs_a')?.textContent),
          citedText,
          url
        });
        if (rows.length >= ${js(limit)}) break;
      }
      return { blocked: false, rows };
    })()`)) as GoogleScholarBrowserPayload;
    if (payload.blocked) {
      throw googleScholarBlockedError(normalize(payload.block_reason));
    }
    if (!Array.isArray(payload.rows)) return [];
    return payload.rows
      .map((row) => mapGoogleScholarRow(row as GoogleScholarRawRow))
      .filter((row): row is Record<string, unknown> => row !== undefined);
  },
});
