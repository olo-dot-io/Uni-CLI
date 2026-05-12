/**
 * @owner   src/adapters/reddit/account.ts
 * @does    Register Reddit authenticated account, home feed, subreddit metadata, and reply commands.
 * @needs   Browser-authenticated reddit.com session, Reddit JSON endpoints, registry TypeScript adapter loader.
 * @feeds   surface coverage ledger, Reddit authenticated command surface, agent-readable command output.
 * @breaks  Reddit auth/session drift, malformed JSON envelopes, or weak ID validation can post to the wrong target or hide auth failures.
 */

import { cli, Strategy } from "../../registry.js";
import type { AdapterArg, IPage } from "../../types.js";
import { redditChildren, redditJson } from "./browser-utils.js";

const REDDIT_HOME_MAX_LIMIT = 100;
const SUBREDDIT_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{2,20}$/;
const REDDIT_COMMENT_ID_RE = /^[a-z0-9]+$/i;

const LIMIT_ARG: AdapterArg = {
  name: "limit",
  type: "int",
  default: 25,
  description: `Number of posts (1-${REDDIT_HOME_MAX_LIMIT})`,
};

interface RedditBrowserResult {
  kind?: string;
  detail?: string;
  httpStatus?: number;
  where?: string;
  identity?: Record<string, unknown>;
  createdName?: string;
}

function failRedditResult(command: string, result: RedditBrowserResult): never {
  if (result.kind === "auth") {
    throw new Error(`Authentication required for reddit.com: ${result.detail}`);
  }
  if (result.kind === "http") {
    throw new Error(
      `Reddit ${command} failed: HTTP ${result.httpStatus} from ${result.where}`,
    );
  }
  if (result.kind === "reddit-error") {
    throw new Error(`Reddit rejected ${command}: ${result.detail}`);
  }
  if (result.kind === "postcondition" || result.kind === "malformed") {
    throw new Error(
      String(result.detail ?? `Reddit ${command} response failed validation`),
    );
  }
  if (result.kind === "exception") {
    throw new Error(`Reddit ${command} failed: ${result.detail}`);
  }
  throw new Error(
    `Unexpected Reddit ${command} result: ${JSON.stringify(result)}`,
  );
}

export function parseRedditHomeLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return 25;
  const n = Number(raw);
  if (
    !Number.isFinite(n) ||
    !Number.isInteger(n) ||
    n < 1 ||
    n > REDDIT_HOME_MAX_LIMIT
  ) {
    throw new Error(
      `limit must be an integer in [1, ${REDDIT_HOME_MAX_LIMIT}]. Got: ${String(raw)}`,
    );
  }
  return n;
}

export function parseSubredditName(raw: unknown): string {
  let name = String(raw ?? "").trim();
  if (!name) {
    throw new Error(
      "Subreddit name is required. Pass a name like `python` or `r/python`.",
    );
  }
  if (name.startsWith("/r/")) name = name.slice(3);
  else if (name.startsWith("r/")) name = name.slice(2);
  if (!SUBREDDIT_NAME_RE.test(name)) {
    throw new Error(
      "Invalid subreddit name. Names are 3-21 characters, start with a letter, and contain only letters, digits, and underscores.",
    );
  }
  return name;
}

function normalizeBareCommentId(value: unknown): string {
  const commentId = String(value ?? "").trim();
  if (!REDDIT_COMMENT_ID_RE.test(commentId)) {
    throw new Error(
      "Comment ID must be a Reddit comment id, t1_ fullname, or reddit.com comment URL.",
    );
  }
  return commentId.toLowerCase();
}

export function normalizeRedditCommentFullname(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) {
    throw new Error(
      "Comment ID is required. Use a bare comment id, t1_ fullname, or full Reddit comment URL.",
    );
  }

  const fullname = raw.match(/^t1_([a-z0-9]+)$/i);
  if (fullname) return `t1_${normalizeBareCommentId(fullname[1])}`;

  if (/^https?:\/\//i.test(raw)) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(`Invalid Reddit comment URL: ${raw}`);
    }
    const host = parsed.hostname.toLowerCase();
    if (
      parsed.protocol !== "https:" ||
      (host !== "reddit.com" && !host.endsWith(".reddit.com"))
    ) {
      throw new Error("Comment URL must be an https reddit.com URL.");
    }
    const parts = parsed.pathname.split("/").filter(Boolean);
    const commentsIndex = parts.indexOf("comments");
    const commentIndex = commentsIndex + 3;
    if (commentsIndex < 0 || parts.length <= commentIndex) {
      throw new Error("Comment URL must include the target comment id.");
    }
    if (parts.length !== commentIndex + 1) {
      throw new Error("Comment URL must end at the target comment id.");
    }
    return `t1_${normalizeBareCommentId(parts[commentIndex])}`;
  }

  if (raw.includes("/") || raw.startsWith("t3_")) {
    throw new Error(
      "Comment ID must be a Reddit comment id, t1_ fullname, or reddit.com comment URL.",
    );
  }

  return `t1_${normalizeBareCommentId(raw)}`;
}

export function requireReplyText(value: unknown): string {
  const text = String(value ?? "");
  if (!text.trim()) {
    throw new Error(
      "Reply text is required. Pass non-empty text to post as the Reddit reply.",
    );
  }
  return text;
}

async function requireRedditIdentity(
  page: IPage,
): Promise<Record<string, unknown>> {
  await page.goto("https://www.reddit.com", { settleMs: 500 });
  const result = (await page.evaluate(`(async () => {
    try {
      const res = await fetch('/api/me.json?raw_json=1', { credentials: 'include' });
      if (res.status === 401 || res.status === 403) {
        return { kind: 'auth', detail: 'Reddit /api/me.json returned HTTP ' + res.status };
      }
      if (!res.ok) return { kind: 'http', httpStatus: res.status, where: '/api/me.json' };
      const body = await res.json();
      const identity = body?.data;
      if (!identity?.name) {
        return { kind: 'auth', detail: 'Not logged in to reddit.com (no identity in /api/me.json)' };
      }
      return { kind: 'ok', identity };
    } catch (err) {
      return { kind: 'exception', detail: String(err && err.message || err) };
    }
  })()`)) as RedditBrowserResult;

  if (result.kind !== "ok" || !result.identity)
    failRedditResult("identity", result);
  return result.identity;
}

function identityRows(
  identity: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const created =
    typeof identity.created_utc === "number"
      ? new Date(identity.created_utc * 1000).toISOString().split("T")[0]
      : null;
  const linkKarma =
    typeof identity.link_karma === "number" ? identity.link_karma : null;
  const commentKarma =
    typeof identity.comment_karma === "number" ? identity.comment_karma : null;
  const totalKarma =
    typeof identity.total_karma === "number"
      ? identity.total_karma
      : linkKarma != null && commentKarma != null
        ? linkKarma + commentKarma
        : null;
  const inboxCount =
    typeof identity.inbox_count === "number" ? identity.inbox_count : null;
  return [
    {
      field: "Username",
      value: identity.name ? `u/${String(identity.name)}` : null,
    },
    { field: "ID", value: identity.id ? `t2_${String(identity.id)}` : null },
    {
      field: "Post Karma",
      value: linkKarma != null ? String(linkKarma) : null,
    },
    {
      field: "Comment Karma",
      value: commentKarma != null ? String(commentKarma) : null,
    },
    {
      field: "Total Karma",
      value: totalKarma != null ? String(totalKarma) : null,
    },
    { field: "Account Created", value: created },
    { field: "Gold", value: identity.is_gold ? "Yes" : "No" },
    { field: "Mod", value: identity.is_mod ? "Yes" : "No" },
    {
      field: "Verified Email",
      value: identity.has_verified_email ? "Yes" : "No",
    },
    { field: "Has Mail", value: identity.has_mail ? "Yes" : "No" },
    {
      field: "Inbox Count",
      value: inboxCount != null ? String(inboxCount) : null,
    },
  ];
}

function homeRows(
  children: Array<Record<string, unknown>>,
  limit: number,
): Array<Record<string, unknown>> {
  return children.slice(0, limit).flatMap((child, index) => {
    const data = (child.data ?? {}) as Record<string, unknown>;
    const postId = typeof data.id === "string" ? data.id : "";
    if (!postId) return [];
    const permalink = String(data.permalink ?? "");
    return [
      {
        rank: index + 1,
        title: typeof data.title === "string" ? data.title : null,
        subreddit:
          typeof data.subreddit_name_prefixed === "string"
            ? data.subreddit_name_prefixed
            : null,
        score: typeof data.score === "number" ? data.score : null,
        comments:
          typeof data.num_comments === "number" ? data.num_comments : null,
        postId,
        author: typeof data.author === "string" ? data.author : null,
        url: permalink ? `https://www.reddit.com${permalink}` : null,
      },
    ];
  });
}

function subredditRows(
  info: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const created =
    typeof info.created_utc === "number"
      ? new Date(info.created_utc * 1000).toISOString().split("T")[0]
      : null;
  const subscribers =
    typeof info.subscribers === "number" ? info.subscribers : null;
  const activeNow =
    typeof info.active_user_count === "number"
      ? info.active_user_count
      : typeof info.accounts_active === "number"
        ? info.accounts_active
        : null;
  const displayName = String(info.display_name ?? "");
  return [
    {
      field: "Name",
      value: info.display_name_prefixed
        ? String(info.display_name_prefixed)
        : `r/${displayName}`,
    },
    {
      field: "Title",
      value: typeof info.title === "string" ? info.title : null,
    },
    {
      field: "Subscribers",
      value: subscribers != null ? String(subscribers) : null,
    },
    {
      field: "Active Now",
      value: activeNow != null ? String(activeNow) : null,
    },
    { field: "NSFW", value: info.over18 ? "Yes" : "No" },
    {
      field: "Type",
      value:
        typeof info.subreddit_type === "string" ? info.subreddit_type : null,
    },
    {
      field: "Description",
      value:
        typeof info.public_description === "string" &&
        info.public_description.trim()
          ? info.public_description.trim()
          : null,
    },
    { field: "Created", value: created },
    {
      field: "URL",
      value: info.url ? `https://www.reddit.com${String(info.url)}` : null,
    },
  ];
}

cli({
  site: "reddit",
  name: "whoami",
  description: "Show the currently logged-in Reddit user",
  domain: "www.reddit.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [],
  columns: ["field", "value"],
  func: async (page) =>
    identityRows(await requireRedditIdentity(page as IPage)),
});

cli({
  site: "reddit",
  name: "home",
  description: "Reddit personalized home feed",
  domain: "www.reddit.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [LIMIT_ARG],
  columns: [
    "rank",
    "title",
    "subreddit",
    "score",
    "comments",
    "postId",
    "author",
    "url",
  ],
  func: async (page, kwargs) => {
    const limit = parseRedditHomeLimit(kwargs.limit);
    await requireRedditIdentity(page as IPage);
    const data = await redditJson(page as IPage, "/best.json", { limit });
    const children = redditChildren(data);
    const rows = homeRows(children, limit);
    if (rows.length === 0) {
      throw new Error(
        children.length > 0
          ? "Reddit home feed entries were missing required post id anchors."
          : "Reddit returned no posts in the personalized home feed.",
      );
    }
    return rows;
  },
});

cli({
  site: "reddit",
  name: "subreddit-info",
  description: "Show metadata for a Reddit subreddit",
  domain: "www.reddit.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "name",
      type: "str",
      required: true,
      positional: true,
      description: "Subreddit name without r/",
    },
  ],
  columns: ["field", "value"],
  func: async (page, kwargs) => {
    const sub = parseSubredditName(kwargs.name);
    const data = (await redditJson(
      page as IPage,
      `/r/${encodeURIComponent(sub)}/about.json`,
      {},
    )) as {
      error?: unknown;
      reason?: unknown;
      data?: Record<string, unknown>;
    };
    if (data.error) {
      throw new Error(
        `Subreddit r/${sub} is ${String(data.reason || "unavailable")}.`,
      );
    }
    const info = data.data;
    if (!info?.display_name) {
      throw new Error(`Reddit returned malformed subreddit info for r/${sub}.`);
    }
    return subredditRows(info);
  },
});

cli({
  site: "reddit",
  name: "reply",
  description: "Reply to a Reddit comment",
  domain: "www.reddit.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "comment-id",
      type: "str",
      required: true,
      positional: true,
      description: "Comment ID, t1_ fullname, or Reddit comment URL",
    },
    {
      name: "text",
      type: "str",
      required: true,
      positional: true,
      description: "Reply text",
    },
  ],
  columns: ["status", "message"],
  func: async (page, kwargs) => {
    const fullname = normalizeRedditCommentFullname(kwargs["comment-id"]);
    const text = requireReplyText(kwargs.text);
    await requireRedditIdentity(page as IPage);
    const result = (await (page as IPage).evaluate(`(async () => {
      try {
        const fullname = ${JSON.stringify(fullname)};
        const text = ${JSON.stringify(text)};
        const meRes = await fetch('/api/me.json?raw_json=1', { credentials: 'include' });
        if (meRes.status === 401 || meRes.status === 403) {
          return { kind: 'auth', detail: 'Reddit /api/me.json returned HTTP ' + meRes.status };
        }
        if (!meRes.ok) return { kind: 'http', httpStatus: meRes.status, where: '/api/me.json' };
        const me = await meRes.json();
        const modhash = me?.data?.modhash || '';
        if (!me?.data?.name) {
          return { kind: 'auth', detail: 'Not logged in to reddit.com (no identity in /api/me.json)' };
        }
        const res = await fetch('/api/comment', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'parent=' + encodeURIComponent(fullname)
            + '&text=' + encodeURIComponent(text)
            + '&api_type=json'
            + (modhash ? '&uh=' + encodeURIComponent(modhash) : ''),
        });
        if (res.status === 401 || res.status === 403) {
          return { kind: 'auth', detail: 'Reddit /api/comment returned HTTP ' + res.status };
        }
        if (!res.ok) return { kind: 'http', httpStatus: res.status, where: '/api/comment' };
        const data = await res.json();
        const errors = data?.json?.errors;
        if (Array.isArray(errors) && errors.length > 0) {
          return { kind: 'reddit-error', detail: errors.map((entry) => entry.join(': ')).join('; ') };
        }
        const things = data?.json?.data?.things;
        const created = Array.isArray(things)
          ? things.find((thing) => thing?.kind === 't1' || String(thing?.data?.name || '').startsWith('t1_'))
          : null;
        const createdName = created?.data?.name || (created?.data?.id ? 't1_' + created.data.id : '');
        if (!createdName) {
          return { kind: 'postcondition', detail: 'Reddit comment response did not include a created reply id' };
        }
        return { kind: 'ok', createdName };
      } catch (err) {
        return { kind: 'exception', detail: String(err && err.message || err) };
      }
    })()`)) as RedditBrowserResult;

    if (result.kind !== "ok" || !result.createdName)
      failRedditResult("reply", result);
    return [
      {
        status: "success",
        message: `Reply posted on ${fullname} as ${result.createdName}`,
      },
    ];
  },
});
