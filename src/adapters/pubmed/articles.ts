/**
 * @owner   src/adapters/pubmed/articles.ts
 * @does    Register agent-facing PubMed search, normalized paper metadata, field/value article detail, PMC full-text read, author, citation, and related-article commands.
 * @needs   NCBI E-utilities PubMed/PMC APIs, TypeScript adapter loader, PMID/PMCID/query validation.
 * @feeds   surface coverage ledger, biomedical literature command surface, agent-readable PubMed rows, scholar full-text workflow.
 * @breaks  NCBI E-utilities envelope drift, weak PMID/PMCID validation, missing PMC full text, or silent empty rows hide literature lookup failures.
 */

import { DOMParser, type Document, type Element } from "@xmldom/xmldom";
import { cli, Strategy } from "../../registry.js";

const EUTILS_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const SUMMARY_COLUMNS = [
  "rank",
  "id",
  "pmid",
  "title",
  "authors",
  "journal",
  "year",
  "article_type",
  "doi",
  "pmc_id",
  "url",
];
const RELATED_COLUMNS = [
  "rank",
  "id",
  "pmid",
  "title",
  "authors",
  "journal",
  "year",
  "score",
  "doi",
  "pmc_id",
  "url",
];
const PMC_BASE = "https://pmc.ncbi.nlm.nih.gov/articles";

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

export function normalizePmcId(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const match = raw.match(/^(?:PMC)?(\d+)$/i);
  if (!match) throw new Error(`pubmed pmc id "${raw}" is not valid.`);
  return `PMC${match[1]}`;
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

export function requirePubMedMaxChars(
  value: unknown,
  fallback = 40_000,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1_000 || n > 1_000_000) {
    throw new Error(
      `pubmed max-chars must be an integer in [1000, 1000000]. Got: ${String(value)}`,
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
  db = "pubmed",
): string {
  const search = new URLSearchParams();
  search.set("db", db);
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
  db = "pubmed",
): Promise<unknown> {
  const response = await fetch(buildUrl(tool, params, retmode, db), {
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
  return articleId(articleIds, "doi");
}

function articleId(
  articleIds: PubMedSummary["articleids"],
  type: string,
): string {
  return stringField(
    Array.isArray(articleIds)
      ? articleIds.find(
          (id) => stringField(id.idtype).toLowerCase() === type.toLowerCase(),
        )?.value
      : "",
  );
}

function pmcUrl(pmcId: string): string {
  return pmcId ? `${PMC_BASE}/${pmcId}/` : "";
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
    const pmcId = articleId(summary.articleids, "pmc");
    const url = `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
    return [
      {
        rank: index + 1,
        id: pmid,
        pmid,
        title: cleanText(summary.title),
        authors: authorNames(summary.authors),
        journal: stringField(summary.source),
        venue: stringField(summary.source),
        year: year(summary.pubdate),
        article_type: articleType(summary.pubtype ?? []),
        type: articleType(summary.pubtype ?? []),
        doi: doi(summary.articleids),
        pmc_id: pmcId || undefined,
        pmc_url: pmcUrl(pmcId),
        source_adapter: "pubmed",
        source_url: url,
        retrieved_at: new Date().toISOString(),
        url,
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

function elements(root: Document | Element, tagName: string): Element[] {
  const nodes = root.getElementsByTagName(tagName);
  return Array.from({ length: nodes.length }, (_, index) =>
    nodes.item(index),
  ).filter((node): node is Element => node !== null);
}

function articleIdText(
  root: Document | Element,
  attrName: "IdType" | "pub-id-type",
  attrValue: string,
): string {
  return (
    elements(root, attrName === "IdType" ? "ArticleId" : "article-id")
      .find(
        (node) =>
          node.getAttribute(attrName)?.toLowerCase() ===
          attrValue.toLowerCase(),
      )
      ?.textContent?.trim() ?? ""
  );
}

export function mapPubMedArticleRecord(
  xml: string,
  pmid: string,
): Record<string, unknown> {
  const document = new DOMParser().parseFromString(xml, "text/xml");
  const title = childText(document, "ArticleTitle");
  if (!title)
    throw new Error(`pubmed article ${pmid} did not include a title.`);
  const doiValue = articleIdText(document, "IdType", "doi");
  const pmcId = articleIdText(document, "IdType", "pmc");
  const abstract = elementTexts(document, "AbstractText").join(" ");
  const authorNodes = document.getElementsByTagName("Author");
  const authorList = Array.from({ length: authorNodes.length }, (_, index) =>
    authorNodes.item(index),
  )
    .filter((author): author is Element => author !== null)
    .map((author) =>
      [childText(author, "LastName"), childText(author, "Initials")]
        .filter(Boolean)
        .join(" "),
    )
    .filter(Boolean);
  const journal = firstElement(document, "Journal");
  const pubDate = firstElement(document, "PubDate");
  const yearValue = pubDate ? childText(pubDate, "Year") : "";
  const sourceUrl = `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
  return {
    id: pmid,
    pmid,
    title,
    authors: authorList,
    journal: journal ? childText(journal, "Title") : "",
    venue: journal ? childText(journal, "Title") : "",
    year: yearValue ? Number(yearValue) : undefined,
    date: pubDate ? cleanText(pubDate.textContent ?? "") : "",
    article_type: elementTexts(document, "PublicationType")[0] ?? "",
    type: elementTexts(document, "PublicationType")[0] ?? "",
    language: childText(document, "Language"),
    doi: doiValue || undefined,
    pmc_id: pmcId || undefined,
    pmc_url: pmcUrl(pmcId),
    abstract: abstract || undefined,
    source_adapter: "pubmed",
    source_url: sourceUrl,
    retrieved_at: new Date().toISOString(),
    url: sourceUrl,
  };
}

export function mapPubMedArticleRows(
  xml: string,
  pmid: string,
  fullAbstract = false,
): Array<Record<string, unknown>> {
  const record = mapPubMedArticleRecord(xml, pmid);
  const abstract = stringField(record.abstract);
  const shownAbstract =
    fullAbstract || abstract.length <= 500
      ? abstract
      : `${abstract.slice(0, 497)}...`;
  return [
    { field: "PMID", value: pmid },
    { field: "PMCID", value: record.pmc_id || null },
    { field: "Title", value: record.title },
    { field: "Authors", value: (record.authors as string[]).join(", ") },
    { field: "Journal", value: record.journal },
    { field: "Year", value: record.year ? String(record.year) : "" },
    { field: "Date", value: record.date },
    { field: "Article Type", value: record.article_type || null },
    { field: "Language", value: record.language },
    { field: "DOI", value: record.doi || null },
    { field: "Abstract", value: shownAbstract || null },
    { field: "URL", value: record.source_url },
    { field: "PMC URL", value: record.pmc_url || null },
  ];
}

function directChildElements(root: Element, tagName: string): Element[] {
  const out: Element[] = [];
  for (let index = 0; index < root.childNodes.length; index += 1) {
    const node = root.childNodes.item(index);
    if (node?.nodeType === 1 && node.nodeName === tagName) {
      out.push(node as Element);
    }
  }
  return out;
}

function directChildText(root: Element, tagName: string): string {
  return cleanText(directChildElements(root, tagName)[0]?.textContent ?? "");
}

function sectionText(section: Element): string {
  const title = directChildText(section, "title");
  const paragraphs = directChildElements(section, "p")
    .map((paragraph) => cleanText(paragraph.textContent ?? ""))
    .filter(Boolean);
  const nested = directChildElements(section, "sec")
    .map(sectionText)
    .filter(Boolean);
  return [title ? `## ${title}` : "", ...paragraphs, ...nested]
    .filter(Boolean)
    .join("\n\n");
}

function truncateText(
  text: string,
  maxChars: number,
): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, maxChars).trimEnd()}\n\n[truncated at ${maxChars} characters]`,
    truncated: true,
  };
}

export function mapPmcFullTextRow(
  xml: string,
  ref: string,
  maxChars = 40_000,
): Record<string, unknown> {
  const document = new DOMParser().parseFromString(xml, "text/xml");
  const title = childText(document, "article-title");
  if (!title) {
    throw new Error(`PMC full text ${ref} did not include an article title.`);
  }
  const pmcId = normalizePmcId(
    articleIdText(document, "pub-id-type", "pmcid") || ref,
  );
  const pmid = articleIdText(document, "pub-id-type", "pmid");
  const doiValue = articleIdText(document, "pub-id-type", "doi");
  const abstract = cleanText(
    firstElement(document, "abstract")?.textContent ?? "",
  );
  const body = firstElement(document, "body");
  const bodyText = body
    ? directChildElements(body, "sec")
        .map(sectionText)
        .filter(Boolean)
        .join("\n\n")
    : "";
  const text = [abstract ? `## Abstract\n\n${abstract}` : "", bodyText]
    .filter(Boolean)
    .join("\n\n");
  if (!text) {
    throw new Error(`PMC full text ${pmcId} did not include readable text.`);
  }
  const truncated = truncateText(text, maxChars);
  return {
    id: pmid || pmcId,
    title,
    pmid: pmid || undefined,
    pmc_id: pmcId,
    doi: doiValue || undefined,
    source_adapter: "pubmed",
    source_url: pmcUrl(pmcId),
    text: truncated.text,
    text_truncated: truncated.truncated,
    text_source: "pmc_xml",
    retrieved_at: new Date().toISOString(),
  };
}

async function pmcIdFromPubMedRef(ref: string): Promise<string> {
  if (/^(?:PMC)?\d+$/i.test(ref) && /^PMC/i.test(ref)) {
    return normalizePmcId(ref);
  }
  const pmid = requirePmid(ref, "pmid");
  const json = (await eutilsFetch(
    "esearch",
    { term: `${pmid}[PMID]`, retmax: 1 },
    "json",
    "pmc",
  )) as { esearchresult?: { idlist?: string[] } };
  const numericPmc = json.esearchresult?.idlist?.[0];
  if (!numericPmc) {
    throw new Error(
      `PubMed PMID ${pmid} has no PubMed Central full text record.`,
    );
  }
  return normalizePmcId(numericPmc);
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
  capabilities: ["http.fetch"],
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
  name: "paper",
  description: "Fetch normalized PubMed article metadata by PMID",
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
  ],
  columns: [
    "id",
    "title",
    "authors",
    "year",
    "journal",
    "doi",
    "pmc_id",
    "source_url",
  ],
  capabilities: ["http.fetch", "scholar.get"],
  func: async (_page, kwargs) => {
    const pmid = requirePmid(kwargs.pmid ?? kwargs.id ?? kwargs.ref);
    const xml = String(
      await eutilsFetch("efetch", { id: pmid, rettype: "abstract" }, "xml"),
    );
    return [mapPubMedArticleRecord(xml, pmid)];
  },
});

cli({
  site: "pubmed",
  name: "read",
  description: "Read PubMed Central full text for a PMID or PMCID",
  domain: "eutils.ncbi.nlm.nih.gov",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "ref",
      type: "str",
      required: true,
      positional: true,
      description: "PubMed PMID or PubMed Central PMCID",
    },
    {
      name: "max-chars",
      type: "int",
      default: 40000,
      description: "Maximum extracted text characters",
    },
  ],
  columns: [
    "id",
    "title",
    "pmid",
    "pmc_id",
    "doi",
    "source_url",
    "text",
    "text_truncated",
  ],
  capabilities: ["http.fetch", "scholar.fulltext"],
  func: async (_page, kwargs) => {
    const ref = requirePubMedText(
      kwargs.ref ?? kwargs.id ?? kwargs.pmid,
      "ref",
    );
    const maxChars = requirePubMedMaxChars(kwargs["max-chars"]);
    const pmcId = await pmcIdFromPubMedRef(ref);
    const xml = String(
      await eutilsFetch(
        "efetch",
        { id: pmcId.replace(/^PMC/i, "") },
        "xml",
        "pmc",
      ),
    );
    return [mapPmcFullTextRow(xml, pmcId, maxChars)];
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
