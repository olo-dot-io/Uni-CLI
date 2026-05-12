/**
 * @owner   src/adapters/indeed/jobs.ts
 * @does    Register agent-facing Indeed search and job-detail browser commands.
 * @needs   Logged-in or challenge-cleared indeed.com browser session and stable rendered job DOM.
 * @feeds   surface coverage ledger and job-search research workflows.
 * @breaks  Indeed Cloudflare challenge changes, search-card DOM drift, or job-detail selector changes.
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";

const INDEED_ORIGIN = "https://www.indeed.com";
const JK_PATTERN = /^[a-f0-9]{16}$/;
const FROMAGE_VALUES = new Set(["1", "3", "7", "14"]);
const SORT_VALUES = new Set(["relevance", "date"]);

export const INDEED_SEARCH_COLUMNS = [
  "rank",
  "id",
  "title",
  "company",
  "location",
  "salary",
  "tags",
  "url",
];

export const INDEED_JOB_COLUMNS = [
  "id",
  "title",
  "company",
  "location",
  "salary",
  "job_type",
  "description",
  "url",
];

interface IndeedSearchCard {
  jk?: unknown;
  title?: unknown;
  company?: unknown;
  location?: unknown;
  salary?: unknown;
  tags?: unknown;
}

interface IndeedSearchResult {
  cards?: unknown;
  challenge?: unknown;
  ready?: unknown;
}

interface IndeedJobResult {
  ready?: unknown;
  challenge?: unknown;
  notFound?: unknown;
  title?: unknown;
  company?: unknown;
  location?: unknown;
  salary?: unknown;
  jobType?: unknown;
  description?: unknown;
}

export function coerceIndeedInt(value: unknown): number {
  if (value === undefined || value === null || value === "") return Number.NaN;
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) && Number.isInteger(numberValue)
    ? numberValue
    : Number.NaN;
}

export function requireIndeedBoundedInt(
  value: unknown,
  defaultValue: number,
  maxValue: number,
  label: string,
): number {
  const numberValue = coerceIndeedInt(value ?? defaultValue);
  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    throw new Error(`indeed ${label} must be a positive integer.`);
  }
  if (numberValue > maxValue) {
    throw new Error(`indeed ${label} must be <= ${maxValue}.`);
  }
  return numberValue;
}

export function requireIndeedNonNegativeInt(
  value: unknown,
  defaultValue: number,
  label: string,
): number {
  const numberValue = coerceIndeedInt(value ?? defaultValue);
  if (!Number.isInteger(numberValue) || numberValue < 0) {
    throw new Error(`indeed ${label} must be a non-negative integer.`);
  }
  return numberValue;
}

export function requireIndeedJobKey(value: unknown): string {
  const id = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!id) throw new Error("indeed job id is required.");
  if (!JK_PATTERN.test(id)) {
    throw new Error(
      `indeed job id "${String(value)}" is not a valid jk; expected 16-char hex.`,
    );
  }
  return id;
}

export function requireIndeedQuery(value: unknown): string {
  const query = String(value ?? "").trim();
  if (!query) throw new Error("indeed query cannot be empty.");
  return query;
}

export function requireIndeedFromage(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  const fromage = String(value).trim();
  if (!FROMAGE_VALUES.has(fromage)) {
    throw new Error(
      `indeed fromage must be one of 1/3/7/14 days, got "${String(value)}".`,
    );
  }
  return fromage;
}

export function requireIndeedSort(value: unknown): string {
  const sort = String(value ?? "relevance")
    .trim()
    .toLowerCase();
  if (!SORT_VALUES.has(sort)) {
    throw new Error(`indeed sort must be "relevance" or "date".`);
  }
  return sort;
}

export function buildIndeedSearchUrl(config: {
  query: string;
  location: string;
  fromage: string;
  sort: string;
  start: number;
}): string {
  const params = new URLSearchParams();
  params.set("q", config.query);
  if (config.location) params.set("l", config.location);
  if (config.fromage) params.set("fromage", config.fromage);
  if (config.sort && config.sort !== "relevance") {
    params.set("sort", config.sort);
  }
  if (config.start > 0) params.set("start", String(config.start));
  return `${INDEED_ORIGIN}/jobs?${params.toString()}`;
}

export function buildIndeedJobUrl(jk: string): string {
  return `${INDEED_ORIGIN}/viewjob?jk=${jk}`;
}

export function dedupeIndeedTags(tags: unknown, salary: string): string {
  if (!Array.isArray(tags)) return "";
  const seen: string[] = [];
  for (const tag of tags) {
    const text = String(tag ?? "").trim();
    if (!text || text === salary || seen.includes(text)) continue;
    seen.push(text);
  }
  return seen.join(" · ");
}

export function indeedSearchCardToRow(
  card: IndeedSearchCard,
  rank: number,
): Record<string, unknown> {
  const jk = String(card?.jk ?? "").trim();
  const salary = String(card?.salary ?? "").trim();
  return {
    rank,
    id: jk,
    title: String(card?.title ?? "")
      .replace(/\s+/g, " ")
      .trim(),
    company: String(card?.company ?? "")
      .replace(/\s+/g, " ")
      .trim(),
    location: String(card?.location ?? "")
      .replace(/\s+/g, " ")
      .trim(),
    salary,
    tags: dedupeIndeedTags(card?.tags, salary),
    url: jk ? buildIndeedJobUrl(jk) : "",
  };
}

export function buildIndeedSearchExtractScript(): string {
  return `(async () => {
    const hasResults = () => Boolean(document.querySelector('.job_seen_beacon'));
    const hasEmptyState = () => {
      const text = document.body?.innerText || '';
      return Boolean(document.querySelector('[data-testid="searchCountPages"], [data-testid="searchCount"], [data-testid="noResultsMessage"], [data-testid="empty-serp-result"]'))
        || /did not match any jobs|no jobs found|0 jobs/i.test(text);
    };
    let ready = hasResults() || hasEmptyState();
    for (let index = 0; index < 30; index += 1) {
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
      ready = hasResults() || hasEmptyState();
    }
    const seen = new Set();
    const cards = [];
    for (const block of document.querySelectorAll('.job_seen_beacon')) {
      const titleAnchor = block.querySelector('h2.jobTitle a, [class*="jcs-JobTitle"]');
      const jk = titleAnchor?.getAttribute('data-jk') || '';
      if (!jk || seen.has(jk)) continue;
      seen.add(jk);
      const tags = Array.from(block.querySelectorAll('.metadataContainer li span'))
        .map((element) => (element.textContent || '').trim())
        .filter(Boolean);
      cards.push({
        jk,
        title: block.querySelector('h2.jobTitle span')?.textContent?.trim() || '',
        company: block.querySelector('[data-testid="company-name"]')?.textContent?.trim() || '',
        location: block.querySelector('[data-testid="text-location"]')?.textContent?.trim() || '',
        salary: block.querySelector('.salary-snippet-container span')?.textContent?.trim() || '',
        tags,
      });
    }
    const challenge = (document.title || '').includes('Just a moment') || Boolean(document.querySelector('[id^="cf-"]'));
    return { cards, challenge, ready };
  })()`;
}

export function buildIndeedJobExtractScript(): string {
  return `(async () => {
    let ready = Boolean(document.querySelector('#jobDescriptionText, h1, [data-testid="error-page"]'));
    for (let index = 0; index < 30; index += 1) {
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
      ready = Boolean(document.querySelector('#jobDescriptionText, h1, [data-testid="error-page"]'));
    }
    const challenge = (document.title || '').includes('Just a moment') || Boolean(document.querySelector('[id^="cf-"]'));
    const headline = document.querySelector('h1')?.textContent || '';
    const notFound = Boolean(document.querySelector('[data-testid="error-page"]')) || /Page Not Found|not found/i.test(headline);
    const title = document.querySelector('h1')?.textContent?.trim() || '';
    const company = document.querySelector('[data-testid="inlineHeader-companyName"] a, [data-testid="inlineHeader-companyName"], [data-company-name="true"]')?.textContent?.trim() || '';
    const location = document.querySelector('[data-testid="jobsearch-JobInfoHeader-companyLocation"] div, [data-testid="inlineHeader-companyLocation"]')?.textContent?.trim() || '';
    const salary = document.querySelector('[id*="salaryInfoAndJobType"] span, [data-testid="job-salary"]')?.textContent?.trim() || '';
    const jobType = Array.from(document.querySelectorAll('[id*="salaryInfoAndJobType"] span, [data-testid="job-type"]'))
      .map((element) => (element.textContent || '').trim())
      .filter((text) => text && text !== salary)
      .join(', ');
    const description = document.querySelector('#jobDescriptionText')?.innerText?.trim() || '';
    return { ready, challenge, notFound, title, company, location, salary, jobType, description };
  })()`;
}

cli({
  site: "indeed",
  name: "search",
  description: "Search Indeed jobs through the rendered browser DOM",
  domain: "www.indeed.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "query", type: "str", required: true, positional: true },
    { name: "location", type: "str", default: "" },
    { name: "fromage", type: "str", default: "" },
    { name: "sort", type: "str", default: "relevance" },
    { name: "start", type: "int", default: 0 },
    { name: "limit", type: "int", default: 15 },
  ],
  columns: INDEED_SEARCH_COLUMNS,
  func: async (page, kwargs) => {
    const p = page as IPage;
    const query = requireIndeedQuery(kwargs.query);
    const location = String(kwargs.location ?? "").trim();
    const fromage = requireIndeedFromage(kwargs.fromage);
    const sort = requireIndeedSort(kwargs.sort);
    const start = requireIndeedNonNegativeInt(kwargs.start, 0, "start");
    const limit = requireIndeedBoundedInt(kwargs.limit, 15, 25, "limit");
    const url = buildIndeedSearchUrl({
      query,
      location,
      fromage,
      sort,
      start,
    });
    await p.goto(url);
    await p.wait(4);
    const result = (await p.evaluate(
      buildIndeedSearchExtractScript(),
    )) as IndeedSearchResult;
    if (result?.challenge) {
      throw new Error(
        "Indeed served a Cloudflare challenge page. Open indeed.com in the connected browser and clear the challenge, then retry.",
      );
    }
    if (!result?.ready) {
      throw new Error(
        "Indeed search page did not expose result or empty-state markers before timeout.",
      );
    }
    const cards = Array.isArray(result?.cards) ? result.cards : [];
    if (cards.length === 0) {
      throw new Error(
        `No Indeed jobs matched "${query}"${location ? ` in ${location}` : ""}.`,
      );
    }
    return cards
      .slice(0, limit)
      .map((card, index) =>
        indeedSearchCardToRow(card as IndeedSearchCard, start + index + 1),
      );
  },
});

cli({
  site: "indeed",
  name: "job",
  description: "Read an Indeed job posting by 16-character jk job key",
  domain: "www.indeed.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "id", type: "str", required: true, positional: true }],
  columns: INDEED_JOB_COLUMNS,
  func: async (page, kwargs) => {
    const p = page as IPage;
    const jk = requireIndeedJobKey(kwargs.id);
    const url = buildIndeedJobUrl(jk);
    await p.goto(url);
    await p.wait(4);
    const detail = (await p.evaluate(
      buildIndeedJobExtractScript(),
    )) as IndeedJobResult;
    if (detail?.challenge) {
      throw new Error(
        "Indeed served a Cloudflare challenge page. Open indeed.com in the connected browser and clear the challenge, then retry.",
      );
    }
    if (!detail?.ready) {
      throw new Error(
        "Indeed job page did not expose detail or error markers before timeout.",
      );
    }
    if (detail?.notFound || (!detail?.title && !detail?.description)) {
      throw new Error(`No Indeed job posting found for jk "${jk}".`);
    }
    return [
      {
        id: jk,
        title: String(detail.title ?? "")
          .replace(/\s+/g, " ")
          .trim(),
        company: String(detail.company ?? "")
          .replace(/\s+/g, " ")
          .trim(),
        location: String(detail.location ?? "")
          .replace(/\s+/g, " ")
          .trim(),
        salary: String(detail.salary ?? "")
          .replace(/\s+/g, " ")
          .trim(),
        job_type: String(detail.jobType ?? "")
          .replace(/\s+/g, " ")
          .trim(),
        description: String(detail.description ?? ""),
        url,
      },
    ];
  },
});
