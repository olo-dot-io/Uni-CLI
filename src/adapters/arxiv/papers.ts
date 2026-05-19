/**
 * @owner   src/adapters/arxiv/papers.ts
 * @does    Register agent-facing arXiv author and recent category commands.
 * @needs   export.arxiv.org Atom API, category validation, conservative XML parsing.
 * @feeds   surface coverage ledger, scholarly search workflow, arXiv category monitoring.
 * @breaks  arXiv Atom shape drift, weak category parsing, or silent empty feeds hide paper discovery failures.
 */

import { cli, Strategy } from "../../registry.js";

const ARXIV_BASE = "https://export.arxiv.org/api/query";
const CATEGORY_RE = /^[a-z]+(?:-[a-z]+)*(?:\.[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)?$/;

interface ArxivEntry {
  id: string;
  title: string;
  authors: string;
  abstract: string;
  published: string;
  updated: string;
  primary_category: string;
  categories: string;
  comment: string;
  pdf: string;
  url: string;
}

export function requireArxivLimit(
  value: unknown,
  fallback: number,
  max = 50,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new Error(`arxiv limit must be an integer in [1, ${max}].`);
  }
  return n;
}

export function requireArxivAuthor(value: unknown): string {
  const author = String(value ?? "").trim();
  if (!author) throw new Error("arxiv author cannot be empty.");
  return author;
}

export function requireArxivCategory(value: unknown): string {
  const category = String(value ?? "").trim();
  if (!CATEGORY_RE.test(category)) {
    throw new Error(`Invalid arXiv category "${String(value)}".`);
  }
  return category;
}

export function decodeArxivEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'");
}

function extractFirst(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return match ? match[1].trim() : "";
}

function extractAll(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) out.push(match[1].trim());
  return out;
}

function extractAttr(xml: string, tag: string, attr: string): string {
  const match = xml.match(new RegExp(`<${tag}\\b[^>]*?\\b${attr}="([^"]*)"`));
  return match ? match[1] : "";
}

function extractAllAttr(xml: string, tag: string, attr: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}\\b[^>]*?\\b${attr}="([^"]*)"`, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) out.push(match[1]);
  return out;
}

function findLinkHref(xml: string, rel: string): string {
  const re = /<link\b([^>]*)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const attrs = match[1];
    if (!new RegExp(`\\brel="${rel}"`).test(attrs)) continue;
    const href = attrs.match(/\bhref="([^"]*)"/);
    if (href) return href[1];
  }
  return "";
}

export function parseArxivEntries(xml: string): ArxivEntry[] {
  const out: ArxivEntry[] = [];
  const re = /<entry>([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const entry = match[1];
    const rawId = extractFirst(entry, "id");
    const id = rawId
      .replace(/^https?:\/\/arxiv\.org\/abs\//, "")
      .replace(/v\d+$/, "");
    const title = decodeArxivEntities(
      extractFirst(entry, "title").replace(/\s+/g, " "),
    ).trim();
    out.push({
      id,
      title,
      authors: decodeArxivEntities(extractAll(entry, "name").join(", ")),
      abstract: decodeArxivEntities(
        extractFirst(entry, "summary").replace(/\s+/g, " "),
      ).trim(),
      published: extractFirst(entry, "published").slice(0, 10),
      updated: extractFirst(entry, "updated").slice(0, 10),
      primary_category: extractAttr(entry, "arxiv:primary_category", "term"),
      categories: extractAllAttr(entry, "category", "term").join(", "),
      comment: decodeArxivEntities(
        extractFirst(entry, "arxiv:comment").replace(/\s+/g, " "),
      ).trim(),
      pdf: findLinkHref(entry, "related") || `https://arxiv.org/pdf/${id}`,
      url: `https://arxiv.org/abs/${id}`,
    });
  }
  return out;
}

async function fetchArxiv(params: URLSearchParams): Promise<string> {
  const response = await fetch(`${ARXIV_BASE}?${params.toString()}`, {
    headers: {
      "User-Agent": "unicli-arxiv/1.0 (https://github.com/olo-dot-io/Uni-CLI)",
      Accept: "application/atom+xml, application/xml, text/xml",
    },
  });
  if (!response.ok)
    throw new Error(`arXiv API returned HTTP ${response.status}.`);
  return response.text();
}

function compactRows(entries: ArxivEntry[]): Array<Record<string, unknown>> {
  return entries.map((entry) => ({
    id: entry.id,
    title: entry.title,
    authors: entry.authors,
    published: entry.published,
    primary_category: entry.primary_category,
    url: entry.url,
  }));
}

cli({
  site: "arxiv",
  name: "author",
  description: "List arXiv papers by a given author",
  domain: "export.arxiv.org",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "author",
      type: "str",
      required: true,
      positional: true,
      description: "Author name",
    },
    { name: "limit", type: "int", default: 20, description: "Max papers" },
  ],
  columns: ["id", "title", "authors", "published", "primary_category", "url"],
  capabilities: ["http.fetch", "scholar.author", "scholar.search"],
  func: async (_page, kwargs) => {
    const author = requireArxivAuthor(kwargs.author);
    const limit = requireArxivLimit(kwargs.limit, 20);
    const params = new URLSearchParams({
      search_query: `au:"${author}"`,
      max_results: String(limit),
      sortBy: "submittedDate",
      sortOrder: "descending",
    });
    const rows = compactRows(parseArxivEntries(await fetchArxiv(params)));
    if (rows.length === 0) {
      throw new Error(`No arXiv papers found for author "${author}".`);
    }
    return rows;
  },
});

cli({
  site: "arxiv",
  name: "recent",
  description: "List recent arXiv submissions in a category",
  domain: "export.arxiv.org",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "category",
      type: "str",
      required: true,
      positional: true,
      description: "arXiv category",
    },
    { name: "limit", type: "int", default: 10, description: "Max papers" },
  ],
  columns: ["id", "title", "authors", "published", "primary_category", "url"],
  capabilities: ["http.fetch", "scholar.search", "scholar.venue"],
  func: async (_page, kwargs) => {
    const category = requireArxivCategory(kwargs.category);
    const limit = requireArxivLimit(kwargs.limit, 10);
    const params = new URLSearchParams({
      search_query: `cat:${category}`,
      max_results: String(limit),
      sortBy: "submittedDate",
      sortOrder: "descending",
    });
    const rows = compactRows(parseArxivEntries(await fetchArxiv(params)));
    if (rows.length === 0) {
      throw new Error(`No recent arXiv papers found in ${category}.`);
    }
    return rows;
  },
});
