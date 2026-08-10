/**
 * @owner       src::adapters::iclr::awards
 * @does        Registers official ICLR award-paper discovery and links each announcement entry to its OpenReview forum and PDF.
 * @needs       blog.iclr.cc WordPress REST API and cheerio
 * @feeds       Direct ICLR award lookup and src/commands/scholar.ts cross-site award, review, rebuttal, and PDF tracing
 * @breaks      ICLR blog search or award-post markup drift surfaces as an explicit adapter error.
 * @invariants  Award labels and paper membership come only from an official ICLR announcement; OpenReview identifiers come only from links in that announcement.
 * @side-effects HTTPS egress to blog.iclr.cc
 * @perf        One bounded WordPress request and O(post markup) parsing
 * @concurrency safe
 * @test        tests/unit/adapters/scholar-publishers.test.ts
 * @stability   experimental
 * @since       2026-08-09
 */

import { load } from "cheerio";

import { cli, Strategy } from "../../registry.js";
import type { ScholarlyContextRecord } from "../../types/scholarly.js";

const ICLR_POSTS_API = "https://blog.iclr.cc/wp-json/wp/v2/posts";
const OPENREVIEW_FORUM_RE =
  /^https?:\/\/(?:www\.)?openreview\.net\/forum\?id=([A-Za-z0-9_-]{6,20})(?:[&#].*)?$/i;

export interface IclrAwardPost {
  id?: unknown;
  date?: unknown;
  link?: unknown;
  slug?: unknown;
  title?: { rendered?: unknown };
  content?: { rendered?: unknown };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function normalized(value: unknown): string {
  return text(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function boundedLimit(value: unknown): number {
  const raw =
    value === undefined || value === null || value === "" ? 100 : value;
  const limit = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("iclr limit must be an integer in [1, 500].");
  }
  return limit;
}

function optionalYear(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const year = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(year) || year < 2022 || year > 2100) {
    throw new Error("iclr award year must be an integer in [2022, 2100].");
  }
  return year;
}

function conferenceYear(
  conference: unknown,
  year: unknown,
): number | undefined {
  const explicit = optionalYear(year);
  if (explicit !== undefined) return explicit;
  const inferred = text(conference).match(/\b(20\d{2})\b/)?.[1];
  return optionalYear(inferred);
}

function requireIclrConference(value: unknown): string {
  const conference = text(value) || "ICLR";
  const key = normalized(conference);
  if (
    !key.includes("iclr") &&
    !key.includes("international conference on learning representations")
  ) {
    throw new Error(`iclr awards does not cover conference "${conference}".`);
  }
  return conference;
}

function postYear(post: IclrAwardPost): number | undefined {
  const titleYear = text(post.title?.rendered).match(/\b(20\d{2})\b/)?.[1];
  const dateYear = text(post.date).match(/^(20\d{2})-/)?.[1];
  const year = Number(titleYear ?? dateYear);
  return Number.isInteger(year) ? year : undefined;
}

function isAwardPost(post: IclrAwardPost): boolean {
  const title = normalized(post.title?.rendered);
  return (
    title.includes("iclr") &&
    (title.includes("outstanding paper") || title.includes("paper award"))
  );
}

export function selectIclrAwardPost(
  posts: IclrAwardPost[],
  year?: number,
): IclrAwardPost {
  const matches = posts
    .filter(isAwardPost)
    .filter((post) => year === undefined || postYear(post) === year)
    .sort((left, right) => (postYear(right) ?? 0) - (postYear(left) ?? 0));
  const post = matches[0];
  if (!post) {
    throw new Error(
      `ICLR returned no official outstanding-paper announcement${year ? ` for ${year}` : ""}.`,
    );
  }
  return post;
}

function awardFromHeading(value: string): string | undefined {
  const heading = normalized(value);
  if (/honou?rable mentions?/.test(heading)) return "Honorable Mention";
  if (/outstanding papers?/.test(heading) || /best papers?/.test(heading)) {
    return "Outstanding Paper";
  }
  return undefined;
}

function authorsFromContainer(
  containerHtml: string,
  forumId: string,
): string[] | undefined {
  const $ = load(containerHtml);
  $("a[href]").each((_index, anchor) => {
    const href = text($(anchor).attr("href"));
    if (href.match(OPENREVIEW_FORUM_RE)?.[1] === forumId) $(anchor).remove();
  });
  const authorText = text($.root().text())
    .replace(/^[\s,;:.\-–—]*(?:by\s+)?/i, "")
    .replace(/[.;:,\s]+$/, "");
  if (!authorText) return undefined;
  const authors = authorText
    .split(/\s*,\s*|\s+and\s+/i)
    .map((author) => author.trim())
    .filter(Boolean);
  return authors.length > 0 ? authors : undefined;
}

export function parseIclrAwardPost(
  post: IclrAwardPost,
): ScholarlyContextRecord[] {
  const html = text(post.content?.rendered);
  const year = postYear(post);
  const sourceUrl = text(post.link);
  if (!html || !year || !sourceUrl) {
    throw new Error(
      "ICLR award announcement is missing content, year, or URL.",
    );
  }
  const $ = load(html);
  const rows: ScholarlyContextRecord[] = [];
  let award: string | undefined;
  $("h2,h3,h4,p,li").each((_index, element) => {
    const tagName = element.tagName.toLowerCase();
    if (/^h[2-4]$/.test(tagName)) {
      award = awardFromHeading($(element).text());
      return;
    }
    if (!award) return;
    $(element)
      .find("a[href]")
      .each((_linkIndex, anchor) => {
        const href = text($(anchor).attr("href"));
        const forumId = href.match(OPENREVIEW_FORUM_RE)?.[1];
        const title = text($(anchor).text()).replace(/[.\s]+$/, "");
        if (!forumId || !title) return;
        const authors = authorsFromContainer($.html(element), forumId);
        rows.push({
          id: forumId,
          title,
          relation: "official-award",
          authors,
          year,
          venue: `ICLR ${year}`,
          type: "Conference Paper",
          openreview_id: forumId,
          award,
          pdf_url: `https://openreview.net/pdf?id=${forumId}`,
          landing_url: href,
          source_adapter: "iclr",
          source_url: sourceUrl,
          next_command: `unicli scholar reviews ${JSON.stringify(forumId)} -D`,
          retrieved_at: new Date().toISOString(),
          raw: {
            announcement_id: post.id,
            announcement_date: text(post.date) || undefined,
            announcement_title: text(post.title?.rendered) || undefined,
          },
        });
      });
  });
  if (rows.length === 0) {
    throw new Error(
      `ICLR ${year} announcement contained no award-linked OpenReview papers.`,
    );
  }
  return rows;
}

async function fetchIclrAwardPosts(): Promise<IclrAwardPost[]> {
  const params = new URLSearchParams({
    search: "Outstanding Paper",
    per_page: "100",
    _fields: "id,date,link,slug,title,content",
  });
  const response = await fetch(`${ICLR_POSTS_API}?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });
  if (response.status === 429) {
    const error = new Error("ICLR blog returned HTTP 429.") as Error & {
      code: string;
    };
    error.code = "rate_limited";
    throw error;
  }
  if (!response.ok) {
    throw new Error(`ICLR blog returned HTTP ${response.status}.`);
  }
  const posts = (await response.json()) as unknown;
  if (!Array.isArray(posts)) {
    throw new Error("ICLR blog returned an invalid posts response.");
  }
  return posts as IclrAwardPost[];
}

function searchable(row: ScholarlyContextRecord): string {
  return normalized(
    [row.title, row.authors?.join(" "), row.award, row.openreview_id].join(" "),
  );
}

cli({
  site: "iclr",
  name: "awards",
  description:
    "List official ICLR award papers with OpenReview forum, review, and PDF links",
  domain: "blog.iclr.cc",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "conference", type: "str", positional: true, default: "ICLR" },
    { name: "year", type: "int", minimum: 2022, maximum: 2100 },
    { name: "query", type: "str" },
    {
      name: "award",
      type: "str",
      choices: ["all", "outstanding-paper", "honorable-mention"],
      default: "all",
    },
    { name: "limit", type: "int", default: 100, minimum: 1, maximum: 500 },
  ],
  columns: [
    "id",
    "title",
    "authors",
    "year",
    "venue",
    "award",
    "openreview_id",
    "pdf_url",
    "landing_url",
    "source_url",
    "next_command",
  ],
  operation_effect: "read",
  execution_operator: "structured-api",
  operation_family: "list",
  capabilities: ["http.fetch", "scholar.awards", "scholar.context"],
  func: async (_page, kwargs) => {
    const conference = requireIclrConference(
      kwargs.conference ?? kwargs.venue ?? "ICLR",
    );
    const year = conferenceYear(conference, kwargs.year);
    const query = normalized(kwargs.query);
    const awardFilter = text(kwargs.award) || "all";
    const limit = boundedLimit(kwargs.limit);
    const post = selectIclrAwardPost(await fetchIclrAwardPosts(), year);
    const rows = parseIclrAwardPost(post)
      .filter((row) => {
        if (query && !searchable(row).includes(query)) return false;
        if (awardFilter === "outstanding-paper") {
          return row.award === "Outstanding Paper";
        }
        if (awardFilter === "honorable-mention") {
          return row.award === "Honorable Mention";
        }
        return true;
      })
      .slice(0, limit);
    if (rows.length === 0) {
      throw new Error("ICLR announcement returned no matching award papers.");
    }
    return rows;
  },
});
