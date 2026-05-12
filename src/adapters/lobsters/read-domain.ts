/**
 * @owner   src/adapters/lobsters/read-domain.ts
 * @does    Register agent-facing Lobsters read and domain commands.
 * @needs   Public lobste.rs JSON endpoints, strict ids/domains, bounded comment tree rendering.
 * @feeds   surface coverage ledger, Lobsters story readers, source-domain research workflows.
 * @breaks  Lobsters JSON shape drift, weak tree bounds, or lossy HTML conversion degrades reads.
 */

import { cli, Strategy } from "../../registry.js";

const LOBSTERS_BASE = "https://lobste.rs";
const DOMAIN_PATTERN =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

interface LobstersComment {
  short_id?: unknown;
  parent_comment?: unknown;
  comment?: unknown;
  comment_plain?: unknown;
  commenting_user?: unknown;
  score?: unknown;
  is_deleted?: unknown;
  is_moderated?: unknown;
}

interface LobstersStory {
  short_id?: unknown;
  title?: unknown;
  description?: unknown;
  description_plain?: unknown;
  submitter_user?: unknown;
  score?: unknown;
  comment_count?: unknown;
  comments?: unknown;
  created_at?: unknown;
  tags?: unknown;
  url?: unknown;
  comments_url?: unknown;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberOrBlank(value: unknown): number | "" {
  return typeof value === "number" && Number.isFinite(value) ? value : "";
}

export function requireLobstersShortId(value: unknown): string {
  const id = String(value ?? "").trim();
  if (!/^[a-z0-9]+$/.test(id)) {
    throw new Error(`Invalid Lobsters short_id: ${String(value)}.`);
  }
  return id;
}

export function requireLobstersDomain(value: unknown): string {
  const domain = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!domain) throw new Error("lobsters domain is required.");
  if (!DOMAIN_PATTERN.test(domain)) {
    throw new Error(
      `lobsters domain "${String(value)}" is not a valid hostname.`,
    );
  }
  return domain;
}

export function requireLobstersLimit(
  value: unknown,
  fallback: number,
  max: number | null,
  label: string,
): number {
  const raw =
    value === undefined || value === null || value === "" ? fallback : value;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`lobsters ${label} must be a positive integer.`);
  }
  if (max !== null && limit > max) {
    throw new Error(`lobsters ${label} must be <= ${max}.`);
  }
  return limit;
}

export function requireLobstersMinInt(
  value: unknown,
  fallback: number,
  min: number,
  label: string,
): number {
  const raw =
    value === undefined || value === null || value === "" ? fallback : value;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`lobsters ${label} must be an integer >= ${min}.`);
  }
  return n;
}

export function lobstersHtmlToText(value: unknown): string {
  return String(value ?? "")
    .replace(/<p>/gi, "\n\n")
    .replace(/<\/p>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<i>(.*?)<\/i>/gi, "$1")
    .replace(/<em>(.*?)<\/em>/gi, "$1")
    .replace(/<strong>(.*?)<\/strong>/gi, "$1")
    .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "$2 ($1)")
    .replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/gi, "\n$1\n")
    .replace(/<code>(.*?)<\/code>/gi, "`$1`")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x2F;/g, "/")
    .trim();
}

function truncate(text: string, maxLength: number, suffix: string): string {
  return text.length > maxLength
    ? `${text.slice(0, maxLength)}${suffix}`
    : text;
}

function indentLines(text: string, depth: number): string {
  if (depth <= 0) return text;
  const prefix = `${"  ".repeat(depth)}> `;
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function commentShortId(comment: LobstersComment): string {
  return stringField(comment.short_id);
}

function commentParentId(comment: LobstersComment): string {
  return stringField(comment.parent_comment);
}

function commentBody(comment: LobstersComment): string {
  return (
    stringField(comment.comment_plain) || lobstersHtmlToText(comment.comment)
  );
}

function storyBody(story: LobstersStory): string {
  return (
    stringField(story.description_plain) ||
    lobstersHtmlToText(story.description)
  );
}

function visibleComments(story: LobstersStory): LobstersComment[] {
  return Array.isArray(story.comments)
    ? story.comments.filter((comment): comment is LobstersComment => {
        return typeof comment === "object" && comment !== null;
      })
    : [];
}

export function buildLobstersReadRows(
  story: LobstersStory | null | undefined,
  options: {
    limit: number;
    maxDepth: number;
    maxReplies: number;
    maxLength: number;
  },
): Array<Record<string, unknown>> {
  if (!story || !story.short_id) throw new Error("Lobsters story not found.");
  const rows: Array<Record<string, unknown>> = [];
  const body = truncate(
    storyBody(story).trim(),
    options.maxLength,
    "\n... [truncated]",
  );
  const storyParts = [stringField(story.title)];
  if (body) storyParts.push(`\n${body}`);
  if (story.url) storyParts.push(`\n${stringField(story.url)}`);
  rows.push({
    type: "POST",
    author: stringField(story.submitter_user) || "[deleted]",
    score: numberOrNull(story.score) ?? 0,
    text: storyParts.join("").trim(),
  });

  const children = new Map<string, LobstersComment[]>();
  for (const comment of visibleComments(story)) {
    const parent = commentParentId(comment);
    const bucket = children.get(parent) ?? [];
    bucket.push(comment);
    children.set(parent, bucket);
  }

  function emit(comment: LobstersComment, depth: number): void {
    if (comment.is_deleted || comment.is_moderated) return;
    const id = commentShortId(comment);
    rows.push({
      type: depth === 0 ? "L0" : `L${depth}`,
      author: stringField(comment.commenting_user) || "[deleted]",
      score: numberOrBlank(comment.score),
      text: indentLines(
        truncate(commentBody(comment).trim(), options.maxLength, "..."),
        depth,
      ),
    });
    const kids = id ? (children.get(id) ?? []) : [];
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
    for (const kid of visible) emit(kid, depth + 1);
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

  const topLevel = children.get("") ?? [];
  const visibleTop = topLevel.slice(0, options.limit);
  for (const comment of visibleTop) emit(comment, 0);
  const hiddenTop = topLevel.length - visibleTop.length;
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

export function mapLobstersDomainRows(
  stories: LobstersStory[],
): Array<Record<string, unknown>> {
  return stories.map((item, index) => ({
    rank: index + 1,
    id: stringField(item.short_id),
    title: stringField(item.title),
    score: numberOrNull(item.score),
    author: stringField(item.submitter_user),
    comments: numberOrNull(item.comment_count),
    created_at: stringField(item.created_at).slice(0, 10),
    tags: Array.isArray(item.tags) ? item.tags.map(String).join(", ") : "",
    submission_url: stringField(item.url),
    comments_url: stringField(item.comments_url),
  }));
}

async function fetchLobstersJson<T>(url: string, label: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent":
        "unicli-lobsters/1.0 (https://github.com/olo-dot-io/Uni-CLI)",
    },
  });
  if (response.status === 404) throw new Error(`${label} not found.`);
  if (!response.ok)
    throw new Error(`Lobsters returned HTTP ${response.status} for ${label}.`);
  return (await response.json()) as T;
}

cli({
  site: "lobsters",
  name: "read",
  description: "Read a Lobste.rs story and its comment tree",
  domain: "lobste.rs",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    {
      name: "id",
      type: "str",
      required: true,
      positional: true,
      description: "Lobste.rs short_id",
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
      description: "Max characters per comment body",
    },
  ],
  columns: ["type", "author", "score", "text"],
  func: async (_page, kwargs) => {
    const id = requireLobstersShortId(kwargs.id);
    const story = await fetchLobstersJson<LobstersStory>(
      `${LOBSTERS_BASE}/s/${id}.json`,
      `lobsters/${id}`,
    );
    return buildLobstersReadRows(story, {
      limit: requireLobstersLimit(kwargs.limit, 25, null, "read limit"),
      maxDepth: requireLobstersLimit(kwargs.depth, 2, null, "read depth"),
      maxReplies: requireLobstersLimit(kwargs.replies, 5, null, "read replies"),
      maxLength: requireLobstersMinInt(
        kwargs["max-length"] ?? kwargs.maxLength,
        2000,
        100,
        "read max-length",
      ),
    });
  },
});

cli({
  site: "lobsters",
  name: "domain",
  description: "Lobste.rs stories submitted from a specific domain",
  domain: "lobste.rs",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    {
      name: "domain",
      type: "str",
      required: true,
      positional: true,
      description: "Source domain",
    },
    {
      name: "limit",
      type: "int",
      default: 20,
      description: "Number of stories",
    },
  ],
  columns: [
    "rank",
    "id",
    "title",
    "score",
    "author",
    "comments",
    "created_at",
    "tags",
    "submission_url",
    "comments_url",
  ],
  func: async (_page, kwargs) => {
    const domain = requireLobstersDomain(kwargs.domain);
    const limit = requireLobstersLimit(kwargs.limit, 20, 25, "domain limit");
    const stories = await fetchLobstersJson<unknown>(
      `${LOBSTERS_BASE}/domains/${encodeURIComponent(domain)}.json`,
      `lobsters domain ${domain}`,
    );
    if (!Array.isArray(stories) || stories.length === 0) {
      throw new Error(`No Lobste.rs stories found for domain "${domain}".`);
    }
    return mapLobstersDomainRows(
      stories
        .filter(
          (story): story is LobstersStory =>
            typeof story === "object" && story !== null,
        )
        .slice(0, limit),
    );
  },
});
