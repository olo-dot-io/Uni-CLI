/**
 * @owner   src/adapters/devto/read.ts
 * @does    Register agent-facing DEV.to article reader.
 * @needs   Public dev.to articles API, numeric article ids, explicit body truncation.
 * @feeds   surface coverage ledger, developer article reading workflow.
 * @breaks  DEV.to API shape drift or missing body_markdown would silently hide article content.
 */

import { cli, Strategy } from "../../registry.js";

const DEVTO_ARTICLE_BASE = "https://dev.to/api/articles";

interface DevtoArticle {
  id?: unknown;
  title?: unknown;
  body_markdown?: unknown;
  user?: { username?: unknown };
  public_reactions_count?: unknown;
  reading_time_minutes?: unknown;
  tag_list?: unknown;
  tags?: unknown;
  published_at?: unknown;
  url?: unknown;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function requireDevtoArticleId(value: unknown): string {
  const id = String(value ?? "").trim();
  if (!/^\d+$/.test(id)) {
    throw new Error(`Invalid DEV.to article id: ${String(value)}.`);
  }
  return id;
}

export function requireDevtoMaxLength(
  value: unknown,
  fallback = 20_000,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 100) {
    throw new Error("devto read max-length must be an integer >= 100.");
  }
  return n;
}

function normalizeTags(article: DevtoArticle): string {
  const tags = article.tag_list ?? article.tags ?? "";
  return Array.isArray(tags) ? tags.map(String).join(", ") : String(tags);
}

export function mapDevtoArticleRow(
  article: DevtoArticle,
  requestedId: string,
  maxLength: number,
): Record<string, unknown> {
  if (!article || !article.id) {
    throw new Error(`DEV.to article ${requestedId} returned no article.`);
  }
  const body = stringField(article.body_markdown);
  if (!body.trim()) {
    throw new Error(
      `DEV.to article ${requestedId} did not include body_markdown.`,
    );
  }
  return {
    id: article.id,
    title: stringField(article.title),
    author: stringField(article.user?.username) || "[deleted]",
    reactions: numberField(article.public_reactions_count),
    reading_time: numberField(article.reading_time_minutes),
    tags: normalizeTags(article),
    published_at: stringField(article.published_at),
    body:
      body.length > maxLength
        ? `${body.slice(0, maxLength)}\n\n... [truncated]`
        : body,
    url: stringField(article.url),
  };
}

async function fetchDevtoArticle(id: string): Promise<DevtoArticle> {
  const response = await fetch(`${DEVTO_ARTICLE_BASE}/${id}`, {
    headers: {
      "User-Agent": "unicli-devto/1.0 (https://github.com/olo-dot-io/Uni-CLI)",
      Accept: "application/json",
    },
  });
  if (response.status === 404)
    throw new Error(`DEV.to article ${id} not found.`);
  if (!response.ok) {
    throw new Error(
      `DEV.to API returned HTTP ${response.status} for article ${id}.`,
    );
  }
  return (await response.json()) as DevtoArticle;
}

cli({
  site: "devto",
  name: "read",
  description: "Read a DEV.to article body by id",
  domain: "dev.to",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "id",
      type: "str",
      required: true,
      positional: true,
      description: "DEV.to numeric article id",
    },
    {
      name: "max-length",
      type: "int",
      default: 20_000,
      description: "Max body characters",
    },
  ],
  columns: [
    "id",
    "title",
    "author",
    "reactions",
    "reading_time",
    "tags",
    "published_at",
    "body",
    "url",
  ],
  func: async (_page, kwargs) => {
    const id = requireDevtoArticleId(kwargs.id);
    const maxLength = requireDevtoMaxLength(
      kwargs["max-length"] ?? kwargs.maxLength,
    );
    return [mapDevtoArticleRow(await fetchDevtoArticle(id), id, maxLength)];
  },
});
