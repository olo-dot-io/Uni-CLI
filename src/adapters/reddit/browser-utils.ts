import type { IPage } from "../../types.js";

interface BrowserJsonResponse {
  ok?: boolean;
  status?: number;
  message?: string;
  data?: unknown;
}

export function clampLimit(value: unknown, fallback = 20): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : fallback;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.trunc(n), 100);
}

export function normalizeSubreddit(value: unknown): string {
  const raw = String(value ?? "").trim();
  return raw.startsWith("r/") ? raw.slice(2) : raw;
}

export async function redditJson(
  page: IPage,
  path: string,
  params: Record<string, string | number | boolean | undefined>,
): Promise<unknown> {
  await page.goto("https://www.reddit.com", { settleMs: 500 });

  const payload = (await page.evaluate(`(async () => {
    const path = ${JSON.stringify(path)};
    const rawParams = ${JSON.stringify(params)};
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(rawParams)) {
      if (value === undefined || value === null || value === '') continue;
      params.set(key, String(value));
    }
    if (!params.has('raw_json')) params.set('raw_json', '1');
    const res = await fetch(path + '?' + params.toString(), {
      credentials: 'include',
      headers: { accept: 'application/json' }
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, message: text.slice(0, 240) };
    }
    try {
      return { ok: true, data: JSON.parse(text) };
    } catch (err) {
      return { ok: false, status: 0, message: String(err) };
    }
  })()`)) as BrowserJsonResponse;

  if (!payload?.ok) {
    const status = payload?.status ? `HTTP ${payload.status}` : "unknown";
    throw new Error(
      `Reddit browser JSON failed for ${path}: ${status}. ${payload?.message ?? ""}`,
    );
  }

  return payload.data;
}

export function redditChildren(data: unknown): Array<Record<string, unknown>> {
  const root = data as { data?: { children?: unknown[] } };
  return Array.isArray(root?.data?.children)
    ? (root.data.children as Array<Record<string, unknown>>)
    : [];
}

export function mapRedditPosts(
  children: Array<Record<string, unknown>>,
  limit: number,
): Array<Record<string, unknown>> {
  return children.slice(0, limit).map((child, index) => {
    const data = (child.data ?? {}) as Record<string, unknown>;
    const permalink = String(data.permalink ?? "");
    return {
      rank: index + 1,
      title: String(data.title ?? ""),
      subreddit:
        String(data.subreddit_name_prefixed ?? "") ||
        (data.subreddit ? `r/${String(data.subreddit)}` : ""),
      author: String(data.author ?? ""),
      score: Number(data.score ?? 0),
      comments: Number(data.num_comments ?? 0),
      url: permalink ? `https://www.reddit.com${permalink}` : "",
    };
  });
}
