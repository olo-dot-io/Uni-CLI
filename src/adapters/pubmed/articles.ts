/**
 * @owner   src/adapters/pubmed/articles.ts
 * @does    Register agent-facing PubMed search, article, author, citation, and related-article commands.
 * @needs   NCBI E-utilities API, TypeScript adapter loader, PMID/query validation.
 * @feeds   surface coverage ledger, biomedical literature command surface, agent-readable PubMed rows.
 * @breaks  NCBI E-utilities envelope drift, weak PMID validation, or silent empty rows hide literature lookup failures.
 */

import { DOMParser, type Document, type Element } from "@xmldom/xmldom";
import { cli, Strategy } from "../../registry.js";

const EUTILS_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const SUMMARY_COLUMNS = [
  "rank",
  "pmid",
  "title",
  "authors",
  "journal",
  "year",
  "article_type",
  "doi",
  "url",
];
const RELATED_COLUMNS = [...SUMMARY_COLUMNS.slice(0, 7), "score", "doi", "url"];

interface PubMedSummary {
  uid?: unknown;
  title?: unknown;
  authors?: Array<{
    name?: unknown;
    collectivename?: unknown;
    lastname?: unknown;
    initials?: unknown;
  }>;
  source?: unknown;
  pubdate?: unknown;
  pubtype?: unknown[];
  articleids?: Array<{
    idtype?: unknown;
    value?: unknown;
  }>;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function cleanText(value: unknown): string {
  return stringField(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function requirePubMedText(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`pubmed ${label} cannot be empty.`);
  return text;
}

export function requirePmid(value: unknown, label = "pmid"): string {
  const pmid = requirePubMedText(value, label);
  if (!/^\d+$/.test(pmid))
    throw new Error(`pubmed ${label} must be a numeric PMID.`);
  return pmid;
}

export function requirePubMedLimit(
  value: unknown,
  fallback = 20,
  max = 100,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new Error(
      `pubmed limit must be an integer in [1, ${max}]. Got: ${String(value)}`,
    );
  }
  return n;
}

function requireChoice(
  value: unknown,
  choices: string[],
  label: string,
  fallback: string,
): string {
  const text = String(value ?? fallback).trim();
  if (!choices.includes(text))
    throw new Error(`pubmed ${label} must be one of: ${choices.join(", ")}.`);
  return text;
}

function year(value: unknown): string {
  return stringField(value).match(/\d{4}/)?.[0] ?? "";
}

function buildUrl(
  tool: string,
  params: Record<string, unknown>,
  retmode = "json",
): string {
  const search = new URLSearchParams();
  search.set("db", "pubmed");
  search.set("retmode", retmode);
  if (process.env.NCBI_API_KEY) search.set("api_key", process.env.NCBI_API_KEY);
  if (process.env.NCBI_EMAIL) search.set("email", process.env.NCBI_EMAIL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "")
      search.set(key, String(value));
  }
  return `${EUTILS_BASE}/${tool}.fcgi?${search.toString()}`;
}

async function eutilsFetch(
  tool: string,
  params: Record<string, unknown>,
  retmode = "json",
): Promise<unknown> {
  const response = await fetch(buildUrl(tool, params, retmode), {
    headers: { "User-Agent": "unicli (https://github.com/olo-dot-io/Uni-CLI)" },
  });
  if (!response.ok)
    throw new Error(`PubMed ${tool} returned HTTP ${response.status}.`);
  if (retmode === "xml") return response.text();
  const json = (await response.json()) as { error?: unknown };
  if (json.error)
    throw new Error(`PubMed ${tool} returned an error: ${String(json.error)}`);
  return json;
}

function authorNames(authors: PubMedSummary["authors"], max = 3): string {
  if (!Array.isArray(authors)) return "";
  const names = authors
    .map(
      (author) =>
        stringField(author.name) ||
        stringField(author.collectivename) ||
        [author.lastname, author.initials]
          .map(stringField)
          .filter(Boolean)
          .join(" "),
    )
    .filter(Boolean);
  const shown = names.slice(0, max);
  if (names.length > max) shown.push("et al.");
  return shown.join(", ");
}

function doi(articleIds: PubMedSummary["articleids"]): string {
  return stringField(
    Array.isArray(articleIds)
      ? articleIds.find((id) => stringField(id.idtype).toLowerCase() === "doi")
          ?.value
      : "",
  );
}

function articleType(types: unknown[]): string {
  const values = Array.isArray(types)
    ? types.map(stringField).filter(Boolean)
    : [];
  return (
    values.find((type) => type === "Review") ?? values[0] ?? "Journal Article"
  );
}

export function mapPubMedSummaryRows(
  summaries: PubMedSummary[],
  pmids: string[],
): Array<Record<string, unknown>> {
  return pmids.flatMap((pmid, index) => {
    const summary = summaries.find((item) => stringField(item.uid) === pmid);
    if (!summary) return [];
    return [
      {
        rank: index + 1,
        pmid,
        title: cleanText(summary.title),
        authors: authorNames(summary.authors),
        journal: stringField(summary.source),
        year: year(summary.pubdate),
        article_type: articleType(summary.pubtype ?? []),
        doi: doi(summary.articleids),
        url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      },
    ];
  });
}

function childText(root: Document | Element, tagName: string): string {
  return cleanText(root.getElementsByTagName(tagName)[0]?.textContent ?? "");
}

function elementTexts(root: Document | Element, tagName: string): string[] {
  const nodes = root.getElementsByTagName(tagName);
  return Array.from({ length: nodes.length }, (_, index) => nodes.item(index))
    .filter((node): node is Element => node !== null)
    .map((node) => cleanText(node.textContent ?? ""));
}

function firstElement(
  root: Document | Element,
  tagName: string,
): Element | null {
  return root.getElementsByTagName(tagName)[0] ?? null;
}

export function mapPubMedArticleRows(
  xml: string,
  pmid: string,
  fullAbstract = false,
): Array<Record<string, unknown>> {
  const document = new DOMParser().parseFromString(xml, "text/xml");
  const title = childText(document, "ArticleTitle");
  if (!title)
    throw new Error(`pubmed article ${pmid} did not include a title.`);
  const abstract = elementTexts(document, "AbstractText").join(" ");
  const shownAbstract =
    fullAbstract || abstract.length <= 500
      ? abstract
      : `${abstract.slice(0, 497)}...`;
  const doiValue =
    Array.from(
      { length: document.getElementsByTagName("ArticleId").length },
      (_, index) => document.getElementsByTagName("ArticleId").item(index),
    )
      .filter((node): node is Element => node !== null)
      .find((node) => node.getAttribute("IdType")?.toLowerCase() === "doi")
      ?.textContent?.trim() ?? "";
  const authorNodes = document.getElementsByTagName("Author");
  const authors = Array.from({ length: authorNodes.length }, (_, index) =>
    authorNodes.item(index),
  )
    .filter((author): author is Element => author !== null)
    .map((author) =>
      [childText(author, "LastName"), childText(author, "Initials")]
        .filter(Boolean)
        .join(" "),
    )
    .filter(Boolean)
    .join(", ");
  const journal = firstElement(document, "Journal");
  const pubDate = firstElement(document, "PubDate");
  return [
    { field: "PMID", value: pmid },
    { field: "Title", value: title },
    { field: "Authors", value: authors },
    { field: "Journal", value: journal ? childText(journal, "Title") : "" },
    { field: "Year", value: pubDate ? childText(pubDate, "Year") : "" },
    {
      field: "Date",
      value: pubDate ? cleanText(pubDate.textContent ?? "") : "",
    },
    {
      field: "Article Type",
      value: elementTexts(document, "PublicationType")[0] ?? null,
    },
    { field: "Language", value: childText(document, "Language") },
    { field: "DOI", value: doiValue || null },
    { field: "Abstract", value: shownAbstract || null },
    { field: "URL", value: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` },
  ];
}

async function fetchSummaryRows(
  pmids: string[],
  label: string,
): Promise<Array<Record<string, unknown>>> {
  const json = (await eutilsFetch("esummary", { id: pmids.join(",") })) as {
    result?: Record<string, PubMedSummary | string[]>;
  };
  const result = json.result ?? {};
  const summaries = pmids
    .map((pmid) => result[pmid])
    .filter(
      (item): item is PubMedSummary => !!item && typeof item === "object",
    );
  const rows = mapPubMedSummaryRows(summaries, pmids);
  if (rows.length === 0) throw new Error(`${label} returned no summary rows.`);
  return rows;
}

cli({
  site: "pubmed",
  name: "search",
  description: "Search PubMed articles",
  domain: "pubmed.ncbi.nlm.nih.gov",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "query",
      type: "str",
      required: true,
      positional: true,
      description: "Search query",
    },
    { name: "limit", type: "int", default: 20, description: "Max results" },
  ],
  columns: SUMMARY_COLUMNS,
  capabilities: ["http.fetch", "scholar.search"],
  func: async (_page, kwargs) => {
    const query = requirePubMedText(kwargs.query, "query");
    const limit = requirePubMedLimit(kwargs.limit);
    const json = (await eutilsFetch("esearch", {
      term: query,
      retmax: limit,
      sort: "",
    })) as {
      esearchresult?: { idlist?: string[] };
    };
    const pmids = Array.isArray(json.esearchresult?.idlist)
      ? json.esearchresult.idlist
      : [];
    if (pmids.length === 0)
      throw new Error(`No PubMed articles matched "${query}".`);
    return fetchSummaryRows(pmids, "pubmed search");
  },
});

cli({
  site: "pubmed",
  name: "article",
  description: "Get detailed information for a PubMed article by PMID",
  domain: "pubmed.ncbi.nlm.nih.gov",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "pmid",
      type: "str",
      required: true,
      positional: true,
      description: "PubMed ID",
    },
    {
      name: "full-abstract",
      type: "bool",
      default: false,
      description: "Do not truncate abstract",
    },
  ],
  columns: ["field", "value"],
  capabilities: ["http.fetch", "scholar.get"],
  func: async (_page, kwargs) => {
    const pmid = requirePmid(kwargs.pmid);
    const xml = String(
      await eutilsFetch("efetch", { id: pmid, rettype: "abstract" }, "xml"),
    );
    return mapPubMedArticleRows(xml, pmid, kwargs["full-abstract"] === true);
  },
});

cli({
  site: "pubmed",
  name: "author",
  description: "Search PubMed articles by author name",
  domain: "pubmed.ncbi.nlm.nih.gov",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "name",
      type: "str",
      required: true,
      positional: true,
      description: "Author name",
    },
    { name: "limit", type: "int", default: 20, description: "Max results" },
  ],
  columns: SUMMARY_COLUMNS,
  capabilities: ["http.fetch", "scholar.author", "scholar.search"],
  func: async (_page, kwargs) => {
    const name = requirePubMedText(kwargs.name, "author");
    const limit = requirePubMedLimit(kwargs.limit);
    const json = (await eutilsFetch("esearch", {
      term: `${name}[au]`,
      retmax: limit,
      sort: "pub_date",
    })) as {
      esearchresult?: { idlist?: string[] };
    };
    const pmids = Array.isArray(json.esearchresult?.idlist)
      ? json.esearchresult.idlist
      : [];
    if (pmids.length === 0)
      throw new Error(`No PubMed articles found for author "${name}".`);
    return fetchSummaryRows(pmids, "pubmed author");
  },
});

cli({
  site: "pubmed",
  name: "citations",
  description: "Get PubMed citation relationships for an article",
  domain: "pubmed.ncbi.nlm.nih.gov",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "pmid",
      type: "str",
      required: true,
      positional: true,
      description: "PubMed ID",
    },
    {
      name: "direction",
      type: "str",
      default: "citedby",
      choices: ["citedby", "references"],
      description: "citedby or references",
    },
    { name: "limit", type: "int", default: 20, description: "Max results" },
  ],
  columns: SUMMARY_COLUMNS,
  capabilities: ["http.fetch", "scholar.citations", "scholar.references"],
  func: async (_page, kwargs) => {
    const pmid = requirePmid(kwargs.pmid);
    const direction = requireChoice(
      kwargs.direction,
      ["citedby", "references"],
      "direction",
      "citedby",
    );
    const linkname =
      direction === "citedby" ? "pubmed_pubmed_citedin" : "pubmed_pubmed_refs";
    const limit = requirePubMedLimit(kwargs.limit);
    const json = (await eutilsFetch("elink", {
      id: pmid,
      dbfrom: "pubmed",
      cmd: "neighbor",
      linkname,
    })) as {
      linksets?: Array<{ linksetdbs?: Array<{ links?: unknown[] }> }>;
    };
    const links =
      json.linksets?.[0]?.linksetdbs?.[0]?.links?.map(String).slice(0, limit) ??
      [];
    if (links.length === 0)
      throw new Error(`No ${direction} links found for PMID ${pmid}.`);
    return fetchSummaryRows(links, "pubmed citations");
  },
});

cli({
  site: "pubmed",
  name: "related",
  description: "Find articles related to a PubMed article",
  domain: "pubmed.ncbi.nlm.nih.gov",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "pmid",
      type: "str",
      required: true,
      positional: true,
      description: "PubMed ID",
    },
    { name: "limit", type: "int", default: 20, description: "Max results" },
  ],
  columns: RELATED_COLUMNS,
  capabilities: ["http.fetch", "scholar.search"],
  func: async (_page, kwargs) => {
    const pmid = requirePmid(kwargs.pmid);
    const limit = requirePubMedLimit(kwargs.limit);
    const json = (await eutilsFetch("elink", {
      id: pmid,
      dbfrom: "pubmed",
      cmd: "neighbor_score",
      linkname: "pubmed_pubmed",
    })) as {
      linksets?: Array<{
        linksetdbs?: Array<{
          links?: Array<string | { id?: unknown; score?: unknown }>;
        }>;
      }>;
    };
    const links =
      json.linksets?.[0]?.linksetdbs?.[0]?.links
        ?.map((link) =>
          typeof link === "string"
            ? { id: link, score: null }
            : { id: stringField(link.id), score: Number(link.score) },
        )
        .filter((link) => link.id && link.id !== pmid)
        .slice(0, limit) ?? [];
    if (links.length === 0)
      throw new Error(`No related articles found for PMID ${pmid}.`);
    const rows = await fetchSummaryRows(
      links.map((link) => link.id),
      "pubmed related",
    );
    return rows.map((row, index) => ({
      ...row,
      score: links[index]?.score ?? null,
    }));
  },
});
