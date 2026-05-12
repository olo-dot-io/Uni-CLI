/**
 * @owner   src/adapters/hackernews/read.ts
 * @does    Register agent-facing Hacker News story reader with threaded comments.
 * @needs   Public Firebase item API, bounded tree traversal, HTML-to-text conversion.
 * @feeds   surface coverage ledger, HN story reading workflow, comment thread inspection.
 * @breaks  HN item shape drift, weak traversal bounds, or HTML entity loss degrades story reads.
 */

import { cli, Strategy } from "../../registry.js";

const HN_ITEM_BASE = "https://hacker-news.firebaseio.com/v0/item";

interface HnItem {
  id?: unknown;
  type?: unknown;
  by?: unknown;
  title?: unknown;
  text?: unknown;
  url?: unknown;
  score?: unknown;
  kids?: unknown;
  deleted?: unknown;
  dead?: unknown;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function requireHnItemId(value: unknown): string {
  const id = String(value ?? "").trim();
  if (!/^\d+$/.test(id))
    throw new Error(`Invalid HN item id: ${String(value)}.`);
  return id;
}

export function requirePositiveInt(
  value: unknown,
  fallback: number,
  label: string,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return n;
}

export function requireMinInt(
  value: unknown,
  fallback: number,
  min: number,
  label: string,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${label} must be an integer >= ${min}.`);
  }
  return n;
}

export function hnHtmlToText(html: unknown): string {
  return String(html ?? "")
    .replace(/<p>/gi, "\n\n")
    .replace(/<\/p>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<i>(.*?)<\/i>/gi, "$1")
    .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "$2 ($1)")
    .replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/gi, "\n$1\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x2F;/g, "/")
    .trim();
}

function indentLines(text: string, depth: number): string {
  if (depth === 0) return text;
  const prefix = `${"  ".repeat(depth)}> `;
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function childIds(item: HnItem): number[] {
  return Array.isArray(item.kids)
    ? item.kids.filter((id): id is number => Number.isInteger(id))
    : [];
}

function truncate(text: string, maxLength: number, suffix: string): string {
  return text.length > maxLength
    ? `${text.slice(0, maxLength)}${suffix}`
    : text;
}

export async function buildHnReadRows(
  story: HnItem | null,
  fetchItem: (id: number) => Promise<HnItem | null>,
  options: {
    limit: number;
    maxDepth: number;
    maxReplies: number;
    maxLength: number;
  },
): Promise<Array<Record<string, unknown>>> {
  if (!story || story.deleted || story.dead) {
    throw new Error("HN story not found, deleted, or dead.");
  }
  const rows: Array<Record<string, unknown>> = [];
  const storyBody = truncate(
    hnHtmlToText(story.text),
    options.maxLength,
    "\n... [truncated]",
  );
  const storyParts = [stringField(story.title)];
  if (storyBody) storyParts.push(`\n${storyBody}`);
  if (story.url) storyParts.push(`\n${stringField(story.url)}`);
  rows.push({
    type: "POST",
    author: stringField(story.by) || "[deleted]",
    score: numberField(story.score),
    text: storyParts.join("").trim(),
  });

  async function walkComment(
    item: HnItem | null,
    depth: number,
  ): Promise<void> {
    if (!item || item.deleted || item.dead || item.type !== "comment") return;
    rows.push({
      type: depth === 0 ? "L0" : `L${depth}`,
      author: stringField(item.by) || "[deleted]",
      score: "",
      text: indentLines(
        truncate(hnHtmlToText(item.text), options.maxLength, "..."),
        depth,
      ),
    });

    const kids = childIds(item);
    if (depth + 1 >= options.maxDepth) {
      if (kids.length > 0) {
        rows.push({
          type: `L${depth + 1}`,
          author: "",
          score: "",
          text: `${"  ".repeat(depth + 1)}[+${kids.length} more replies]`,
        });
      }
      return;
    }

    const visible = kids.slice(0, options.maxReplies);
    for (const reply of await Promise.all(visible.map((id) => fetchItem(id)))) {
      await walkComment(reply, depth + 1);
    }
    const hidden = kids.length - visible.length;
    if (hidden > 0) {
      rows.push({
        type: `L${depth + 1}`,
        author: "",
        score: "",
        text: `${"  ".repeat(depth + 1)}[+${hidden} more replies]`,
      });
    }
  }

  const topKids = childIds(story);
  const visibleTop = topKids.slice(0, options.limit);
  for (const comment of await Promise.all(
    visibleTop.map((id) => fetchItem(id)),
  )) {
    await walkComment(comment, 0);
  }
  const hiddenTop = topKids.length - visibleTop.length;
  if (hiddenTop > 0) {
    rows.push({
      type: "",
      author: "",
      score: "",
      text: `[+${hiddenTop} more top-level comments]`,
    });
  }
  return rows;
}

async function fetchHnItem(id: number): Promise<HnItem | null> {
  const response = await fetch(`${HN_ITEM_BASE}/${id}.json`, {
    headers: {
      "User-Agent":
        "unicli-hackernews/1.0 (https://github.com/olo-dot-io/Uni-CLI)",
      Accept: "application/json",
    },
  });
  if (!response.ok)
    throw new Error(`HN API returned HTTP ${response.status} for item ${id}.`);
  return (await response.json()) as HnItem | null;
}

cli({
  site: "hackernews",
  name: "read",
  description: "Read a Hacker News story and comment tree",
  domain: "news.ycombinator.com",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "id",
      type: "str",
      required: true,
      positional: true,
      description: "HN item id",
    },
    {
      name: "limit",
      type: "int",
      default: 25,
      description: "Max top-level comments",
    },
    { name: "depth", type: "int", default: 2, description: "Max reply depth" },
    {
      name: "replies",
      type: "int",
      default: 5,
      description: "Max replies per comment",
    },
    {
      name: "max-length",
      type: "int",
      default: 2000,
      description: "Max chars per body",
    },
  ],
  columns: ["type", "author", "score", "text"],
  func: async (_page, kwargs) => {
    const id = Number(requireHnItemId(kwargs.id));
    return buildHnReadRows(await fetchHnItem(id), fetchHnItem, {
      limit: requirePositiveInt(kwargs.limit, 25, "hackernews read limit"),
      maxDepth: requirePositiveInt(kwargs.depth, 2, "hackernews read depth"),
      maxReplies: requirePositiveInt(
        kwargs.replies,
        5,
        "hackernews read replies",
      ),
      maxLength: requireMinInt(
        kwargs["max-length"] ?? kwargs.maxLength,
        2000,
        100,
        "hackernews read max-length",
      ),
    });
  },
});
