/**
 * @owner   src/adapters/zhihu/collection.ts
 * @does    Register agent-facing Zhihu collection item reader.
 * @needs   Logged-in Zhihu browser session, collection item API, bounded pagination.
 * @feeds   surface coverage ledger, Zhihu collection content workflows, answer/article/pin rows.
 * @breaks  Zhihu collection API shape drift or weak content mapping can hide saved items.
 */

import { cli, Strategy } from "../../registry.js";

interface ZhihuCollectionItem {
  content?: {
    type?: unknown;
    id?: unknown;
    url?: unknown;
    content?: unknown;
    question?: { id?: unknown; title?: unknown };
    title?: unknown;
    author?: { name?: unknown };
    voteup_count?: unknown;
    reaction_count?: unknown;
  };
}

interface ZhihuPage {
  data?: ZhihuCollectionItem[];
  paging?: {
    totals?: unknown;
    is_end?: unknown;
    next?: unknown;
  };
  __httpError?: unknown;
}

function stringField(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function numberField(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function stripZhihuHtml(value: unknown): string {
  return stringField(value)
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .trim();
}

export function requireZhihuCollectionId(value: unknown): string {
  const id = String(value ?? "").trim();
  if (!/^\d+$/.test(id))
    throw new Error("Zhihu collection ID must be numeric.");
  return id;
}

export function requireZhihuPositiveInt(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`zhihu collection ${label} must be a positive integer.`);
  }
  return n;
}

export function requireZhihuNonNegativeInt(
  value: unknown,
  label: string,
): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      `zhihu collection ${label} must be a non-negative integer.`,
    );
  }
  return n;
}

export function zhihuCollectionItemKey(item: ZhihuCollectionItem): string {
  const content = item.content ?? {};
  return `${stringField(content.type) || "unknown"}:${stringField(
    content.id || content.url || JSON.stringify(content).slice(0, 80),
  )}`;
}

export function mapZhihuCollectionItem(
  item: ZhihuCollectionItem,
  rank: number,
): Record<string, unknown> {
  const content = item.content ?? {};
  const type = stringField(content.type) || "unknown";
  let title = "";
  let excerpt = "";
  let url = "";
  let author = "";
  let votes = 0;
  if (type === "answer") {
    const question = content.question ?? {};
    title = stringField(question.title);
    excerpt = stripZhihuHtml(content.content).slice(0, 150);
    url =
      stringField(content.url) ||
      `https://www.zhihu.com/question/${stringField(question.id)}/answer/${stringField(content.id)}`;
    author = stringField(content.author?.name) || "匿名用户";
    votes = numberField(content.voteup_count);
  } else if (type === "article") {
    title = stringField(content.title);
    excerpt = stripZhihuHtml(content.content).slice(0, 150);
    url =
      stringField(content.url) ||
      `https://zhuanlan.zhihu.com/p/${stringField(content.id)}`;
    author = stringField(content.author?.name) || "匿名用户";
    votes = numberField(content.voteup_count);
  } else if (type === "pin") {
    title = "想法";
    const blocks = Array.isArray(content.content) ? content.content : [];
    excerpt = stripZhihuHtml(
      blocks
        .map((block) =>
          typeof block === "object" && block !== null && "content" in block
            ? stringField((block as { content?: unknown }).content)
            : "",
        )
        .join(" "),
    ).slice(0, 150);
    url =
      stringField(content.url) ||
      `https://www.zhihu.com/pin/${stringField(content.id)}`;
    author = stringField(content.author?.name) || "匿名用户";
    votes = numberField(content.reaction_count);
  }
  return {
    rank,
    type,
    title: title.slice(0, 100),
    author,
    votes,
    excerpt,
    url,
  };
}

function nextOffsetFromPaging(page: ZhihuPage, fallback: number): number {
  const next = stringField(page.paging?.next);
  if (next) {
    try {
      const url = new URL(next);
      const parsed = Number(url.searchParams.get("offset"));
      if (Number.isInteger(parsed) && parsed > fallback) return parsed;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

cli({
  site: "zhihu",
  name: "collection",
  description: "List items in a Zhihu collection",
  domain: "www.zhihu.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "id",
      type: "str",
      required: true,
      positional: true,
      description: "Collection ID",
    },
    { name: "offset", type: "int", default: 0, description: "Starting offset" },
    { name: "limit", type: "int", default: 20, description: "Number of items" },
  ],
  columns: ["rank", "type", "title", "author", "votes", "excerpt", "url"],
  func: async (page, kwargs) => {
    const browserPage = page as {
      goto: (url: string) => Promise<unknown>;
      evaluate: (script: string) => Promise<ZhihuPage>;
    };
    const id = requireZhihuCollectionId(kwargs.id);
    const offset = requireZhihuNonNegativeInt(kwargs.offset ?? 0, "offset");
    const requestedLimit = requireZhihuPositiveInt(kwargs.limit ?? 20, "limit");
    const pageLimit = Math.min(requestedLimit, 20);
    await browserPage.goto("https://www.zhihu.com");
    const collected: ZhihuCollectionItem[] = [];
    const seen = new Set<string>();
    let nextOffset = offset;
    const maxPages = Math.ceil(requestedLimit / pageLimit) + 2;
    for (
      let pageIndex = 0;
      pageIndex < maxPages && collected.length < requestedLimit;
      pageIndex += 1
    ) {
      const fetchLimit = Math.min(pageLimit, requestedLimit - collected.length);
      const url = `https://www.zhihu.com/api/v4/collections/${id}/items?offset=${nextOffset}&limit=${fetchLimit}`;
      const data = await browserPage.evaluate(`(async () => {
        const response = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
        if (!response.ok) return { __httpError: response.status };
        return await response.json();
      })()`);
      if (!data || data.__httpError) {
        throw new Error(
          `Zhihu collection request failed${data?.__httpError ? ` (HTTP ${String(data.__httpError)})` : ""}.`,
        );
      }
      const items = Array.isArray(data.data) ? data.data : [];
      for (const item of items) {
        const key = zhihuCollectionItemKey(item);
        if (!seen.has(key)) {
          seen.add(key);
          collected.push(item);
        }
        if (collected.length >= requestedLimit) break;
      }
      if (
        items.length === 0 ||
        data.paging?.is_end ||
        collected.length >= requestedLimit
      )
        break;
      const parsedNextOffset = nextOffsetFromPaging(data, nextOffset);
      nextOffset =
        parsedNextOffset > nextOffset
          ? parsedNextOffset
          : nextOffset + items.length;
    }
    if (collected.length === 0) {
      throw new Error(`No items found for Zhihu collection ${id}.`);
    }
    return collected
      .slice(0, requestedLimit)
      .map((item, index) => mapZhihuCollectionItem(item, offset + index + 1));
  },
});
