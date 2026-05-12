/**
 * @owner   src/adapters/hf/paper.ts
 * @does    Register agent-facing Hugging Face paper detail command.
 * @needs   Hugging Face public papers API, modern arXiv ids, paper metadata normalization.
 * @feeds   surface coverage ledger, HF daily paper detail workflows, scholarly metadata readers.
 * @breaks  HF papers API shape drift or invalid arXiv id handling can hide paper details.
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

export function mapHfPaperRow(
  paper: HfPaper,
  endpoint = HF_DEFAULT_ENDPOINT,
): Record<string, unknown> {
  const id = stringField(paper.id);
  if (!id) throw new Error("Hugging Face returned no paper data.");
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
    url: `${hfEndpoint(endpoint)}/papers/${id}`,
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
    "url",
  ],
  func: async (_page, kwargs) => {
    const id = requireHfPaperId(kwargs.id);
    return [mapHfPaperRow(await fetchHfPaper(id), hfEndpoint())];
  },
});
