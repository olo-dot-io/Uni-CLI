/**
 * @owner   src/adapters/hf/paper.ts
 * @does    Register agent-facing Hugging Face paper detail and resource-link command.
 * @needs   Hugging Face public papers API, modern arXiv ids, paper metadata normalization.
 * @feeds   surface coverage ledger, HF daily paper detail workflows, scholarly metadata and resource readers.
 * @breaks  HF papers API shape drift, resource-link schema drift, or invalid arXiv id handling can hide paper details.
 */

import { cli, Strategy } from "../../registry.js";

const HF_DEFAULT_ENDPOINT = "https://huggingface.co";
const ARXIV_ID_PATTERN = /^\d{4}\.\d{4,5}(?:v\d+)?$/;

interface HfAuthor {
  name?: unknown;
  fullname?: unknown;
}

interface HfPaper {
  id?: unknown;
  title?: unknown;
  authors?: unknown;
  publishedAt?: unknown;
  upvotes?: unknown;
  ai_keywords?: unknown;
  summary?: unknown;
  ai_summary?: unknown;
  githubRepo?: unknown;
  githubStars?: unknown;
  projectPage?: unknown;
  linkedDatasets?: unknown;
  linkedModels?: unknown;
  linkedSpaces?: unknown;
  numTotalDatasets?: unknown;
  numTotalModels?: unknown;
  numTotalSpaces?: unknown;
}

interface HfLinkedResource {
  id?: unknown;
}

function stringField(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function numberOrNull(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function requireHfPaperId(value: unknown): string {
  const id = String(value ?? "").trim();
  if (!id) throw new Error("hf paper id cannot be empty.");
  if (!ARXIV_ID_PATTERN.test(id)) {
    throw new Error(`hf paper id "${String(value)}" is not a valid arXiv id.`);
  }
  return id;
}

export function hfEndpoint(value = process.env.HF_ENDPOINT): string {
  return (value || HF_DEFAULT_ENDPOINT).replace(/\/+$/, "");
}

function hfAuthorNames(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((author: HfAuthor | string) => {
      if (typeof author === "string") return author;
      return stringField(author.name || author.fullname);
    })
    .filter(Boolean)
    .join(", ");
}

function bareArxivId(value: string): string {
  return value.replace(/v\d+$/i, "");
}

function linkedResourceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item: HfLinkedResource | string) =>
      typeof item === "string" ? item : stringField(item.id),
    )
    .map((id) => id.trim())
    .filter(Boolean);
}

function linkedResourceUrls(
  value: unknown,
  kind: "dataset" | "model" | "space",
  endpoint: string,
): string[] {
  const base = hfEndpoint(endpoint);
  return linkedResourceIds(value).map((id) => {
    if (kind === "dataset") return `${base}/datasets/${id}`;
    if (kind === "space") return `${base}/spaces/${id}`;
    return `${base}/${id}`;
  });
}

function csv(values: string[]): string {
  return values.join(", ");
}

export function mapHfPaperRow(
  paper: HfPaper,
  endpoint = HF_DEFAULT_ENDPOINT,
): Record<string, unknown> {
  const id = stringField(paper.id);
  if (!id) throw new Error("Hugging Face returned no paper data.");
  const sourceUrl = `${hfEndpoint(endpoint)}/papers/${id}`;
  const datasetUrls = linkedResourceUrls(
    paper.linkedDatasets,
    "dataset",
    endpoint,
  );
  const modelUrls = linkedResourceUrls(paper.linkedModels, "model", endpoint);
  const spaceUrls = linkedResourceUrls(paper.linkedSpaces, "space", endpoint);
  return {
    id,
    title: stringField(paper.title),
    authors: hfAuthorNames(paper.authors),
    publishedAt: stringField(paper.publishedAt).slice(0, 10),
    upvotes: numberOrNull(paper.upvotes),
    aiKeywords: Array.isArray(paper.ai_keywords)
      ? paper.ai_keywords.map(String).join(", ")
      : "",
    summary: stringField(paper.summary),
    aiSummary: stringField(paper.ai_summary),
    arxiv_id: bareArxivId(id),
    pdf_url: `https://arxiv.org/pdf/${id}`,
    source_url: sourceUrl,
    code_url: stringField(paper.githubRepo),
    github_stars: numberOrNull(paper.githubStars),
    project_url: stringField(paper.projectPage),
    dataset_url: datasetUrls[0] ?? "",
    model_urls: csv(modelUrls),
    dataset_urls: csv(datasetUrls),
    space_urls: csv(spaceUrls),
    num_models: numberOrNull(paper.numTotalModels),
    num_datasets: numberOrNull(paper.numTotalDatasets),
    num_spaces: numberOrNull(paper.numTotalSpaces),
    url: sourceUrl,
  };
}

async function fetchHfPaper(id: string): Promise<HfPaper> {
  const endpoint = hfEndpoint();
  const response = await fetch(
    `${endpoint}/api/papers/${encodeURIComponent(id)}`,
    {
      headers: {
        Accept: "application/json",
        "User-Agent": "unicli-hf/1.0 (https://github.com/olo-dot-io/Uni-CLI)",
      },
    },
  );
  if (response.status === 404) {
    throw new Error(`Hugging Face has no paper page for "${id}".`);
  }
  if (response.status === 429) {
    throw new Error("Hugging Face paper API returned HTTP 429.");
  }
  if (!response.ok)
    throw new Error(`Hugging Face paper API returned HTTP ${response.status}.`);
  return (await response.json()) as HfPaper;
}

cli({
  site: "hf",
  name: "paper",
  description: "Hugging Face paper detail by arXiv id",
  domain: "huggingface.co",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    {
      name: "id",
      type: "str",
      required: true,
      positional: true,
      description: "arXiv id",
    },
  ],
  columns: [
    "id",
    "title",
    "authors",
    "publishedAt",
    "upvotes",
    "aiKeywords",
    "summary",
    "aiSummary",
    "arxiv_id",
    "pdf_url",
    "source_url",
    "code_url",
    "github_stars",
    "project_url",
    "dataset_url",
    "model_urls",
    "dataset_urls",
    "space_urls",
    "num_models",
    "num_datasets",
    "num_spaces",
    "url",
  ],
  capabilities: [
    "http.fetch",
    "scholar.get",
    "scholar.pdf",
    "scholar.code",
    "scholar.datasets",
  ],
  func: async (_page, kwargs) => {
    const id = requireHfPaperId(kwargs.id);
    return [mapHfPaperRow(await fetchHfPaper(id), hfEndpoint())];
  },
});
