/**
 * @owner   src/adapters/1point3acres/forum.ts
 * @does    Register agent-facing 1Point3Acres Discuz forum, thread, search, notification, and profile commands.
 * @needs   Public www.1point3acres.com/bbs HTML plus browser cookies for search and notifications.
 * @feeds   surface coverage ledger, Chinese forum research workflows, and Discuz thread/profile extraction.
 * @breaks  Discuz template drift, GBK decoding changes, guest alert copy changes, or protected-search cookie policy changes.
 */

import { formatCookieHeader } from "../../engine/cookies.js";
import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";

export const ONEPOINT_BASE = "https://www.1point3acres.com/bbs";
const ONEPOINT_HOST = "www.1point3acres.com";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0 Safari/537.36";

export const ONEPOINT_THREAD_LIST_COLUMNS = [
  "rank",
  "tid",
  "title",
  "forum",
  "author",
  "replies",
  "views",
  "lastReplyTime",
  "url",
];
export const ONEPOINT_LATEST_COLUMNS = [
  "rank",
  "tid",
  "title",
  "forum",
  "author",
  "replies",
  "views",
  "postTime",
  "url",
];
export const ONEPOINT_FORUM_COLUMNS = [
  "rank",
  "tid",
  "kind",
  "title",
  "author",
  "replies",
  "views",
  "lastReplyTime",
  "url",
];
export const ONEPOINT_FORUMS_COLUMNS = ["fid", "name", "url"];
export const ONEPOINT_SEARCH_COLUMNS = [
  "rank",
  "tid",
  "title",
  "forum",
  "author",
  "replies",
  "views",
  "postTime",
  "url",
];
export const ONEPOINT_THREAD_COLUMNS = [
  "floor",
  "pid",
  "author",
  "postTime",
  "content",
  "url",
];
export const ONEPOINT_USER_COLUMNS = [
  "uid",
  "username",
  "group",
  "credits",
  "rice",
  "posts",
  "threads",
  "digests",
  "registerTime",
  "lastAccess",
  "profileUrl",
];
export const ONEPOINT_NOTIFICATION_COLUMNS = [
  "index",
  "from",
  "summary",
  "time",
  "threadUrl",
];

interface FetchOptions {
  cookie?: string;
  headers?: Record<string, string>;
}

interface OnePointThreadRow {
  kind: string;
  tid: string;
  title: string;
  author: string;
  forum: string;
  fid: string;
  replies: number;
  views: number;
  postTime: string;
  lastReplyUser: string;
  lastReplyTime: string;
  url: string;
}

function cleanString(value: unknown): string {
  return typeof value === "string"
    ? value.trim()
    : value == null
      ? ""
      : String(value).trim();
}

export function normalizeOnePointPositiveInteger(
  value: unknown,
  defaultValue: number,
  label = "value",
  opts: { min?: number } = {},
): number {
  const raw = value ?? defaultValue;
  const parsed = Number(raw);
  const min = opts.min ?? 1;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  if (parsed < min) {
    throw new Error(`${label} must be >= ${min}`);
  }
  return parsed;
}

export function normalizeOnePointLimit(
  value: unknown,
  defaultValue: number,
  maxValue: number,
  label = "limit",
): number {
  const limit = normalizeOnePointPositiveInteger(value, defaultValue, label);
  if (limit > maxValue) throw new Error(`${label} must be <= ${maxValue}`);
  return limit;
}

export function decodeOnePointEntities(value: string): string {
  if (!value) return "";
  const map: Record<string, string> = {
    "&nbsp;": " ",
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
  };
  return value
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, n: string) =>
      String.fromCodePoint(parseInt(n, 16)),
    )
    .replace(/&(nbsp|amp|lt|gt|quot|#39|apos);/g, (m) => map[m] || m);
}

export function stripOnePointHtml(html: string): string {
  if (!html) return "";
  return decodeOnePointEntities(
    String(html)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function truncateOnePoint(value: string, limit = 300): string {
  if (!value) return "";
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function extract(html: string, regex: RegExp, group = 1): string {
  const match = html.match(regex);
  return match ? match[group] : "";
}

async function readResponseText(response: Response): Promise<string> {
  const buffer = await response.arrayBuffer();
  const contentType = response.headers.get("content-type") ?? "";
  if (/utf-?8/i.test(contentType)) {
    return new TextDecoder("utf-8").decode(buffer);
  }
  return new TextDecoder("gbk").decode(buffer);
}

export async function fetchOnePointHtml(
  url: string,
  options: FetchOptions = {},
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        ...(options.cookie ? { Cookie: options.cookie } : {}),
        ...options.headers,
      },
      redirect: "follow",
    });
  } catch (error) {
    throw new Error(
      `1point3acres request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `1point3acres request failed: HTTP ${response.status} ${response.statusText} from ${url}`,
    );
  }
  return readResponseText(response);
}

export async function getOnePointCookie(page: unknown): Promise<string> {
  const candidate = page as Partial<IPage> | undefined;
  if (typeof candidate?.cookies !== "function") return "";
  const cookies = await candidate.cookies();
  return formatCookieHeader(cookies);
}

export function assertOnePointNotGuestAlert(html: string): void {
  if (
    /<title>提示信息 \| 一亩三分地<\/title>/.test(html) &&
    /无法进行此操作|请登录/.test(html)
  ) {
    throw new Error("Login to www.1point3acres.com is required");
  }
}

export function parseOnePointThreadRows(
  html: string,
): Array<{ kind: string; tid: string; inner: string }> {
  const rows: Array<{ kind: string; tid: string; inner: string }> = [];
  const regex =
    /<tbody id="(normalthread|stickthread)_(\d+)"[^>]*>([\s\S]*?)<\/tbody>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html))) {
    rows.push({ kind: match[1], tid: match[2], inner: match[3] });
  }
  return rows;
}

export function parseOnePointThreadRow(row: {
  kind: string;
  tid: string;
  inner: string;
}): OnePointThreadRow {
  const { kind, tid, inner } = row;
  const titleMatches = [
    ...inner.matchAll(/<a [^>]*class="[^"]*\bxst\b[^"]*"[^>]*>([^<]+)<\/a>/g),
  ];
  const title = titleMatches.length
    ? decodeOnePointEntities(titleMatches[titleMatches.length - 1][1].trim())
    : "";
  const forumMatch = inner.match(
    /<a href="forum-(\d+)-1\.html"[^>]*target="_blank"[^>]*>([^<]+)<\/a>/,
  );
  const fid = forumMatch ? forumMatch[1] : "";
  const forumName = forumMatch
    ? decodeOnePointEntities(forumMatch[2].trim())
    : "";
  const byBlocks = [
    ...inner.matchAll(/<td class="by"[^>]*>([\s\S]*?)<\/td>/g),
  ].map((match) => match[1]);
  const readCite = (block: string): string => {
    const match = block.match(/<cite[^>]*>([\s\S]*?)<\/cite>/);
    if (!match) return "";
    return decodeOnePointEntities(match[1].replace(/<[^>]+>/g, "").trim());
  };
  const readTime = (block: string): string => {
    const titleMatch = block.match(/<span [^>]*title="([^"]+)"[^>]*>/);
    if (titleMatch) return titleMatch[1].trim();
    const plainLink = block.match(/<em>[\s\S]*?<a [^>]*>\s*([^<]+?)\s*<\/a>/);
    if (plainLink) return decodeOnePointEntities(plainLink[1].trim());
    const plainSpan = block.match(
      /<em>[\s\S]*?<span[^>]*>\s*([^<]+?)\s*<\/span>/,
    );
    if (plainSpan) return decodeOnePointEntities(plainSpan[1].trim());
    const bare = block.match(/<em>\s*([^<]+?)\s*<\/em>/);
    return bare ? decodeOnePointEntities(bare[1].trim()) : "";
  };
  let authorBlock = "";
  let lastBlock = "";
  for (const block of byBlocks) {
    if (!/<cite/.test(block)) continue;
    if (!authorBlock) authorBlock = block;
    lastBlock = block;
  }
  const numberMatch = inner.match(
    /<td class="num"[^>]*>\s*<a[^>]*class="xi2"[^>]*>(\d+)<\/a>(?:\s*<em>(\d+)<\/em>)?/,
  );
  return {
    tid,
    kind,
    title,
    author: authorBlock ? readCite(authorBlock) : "",
    forum: forumName,
    fid,
    replies: numberMatch ? Number(numberMatch[1]) : 0,
    views: numberMatch?.[2] ? Number(numberMatch[2]) : 0,
    postTime: authorBlock ? readTime(authorBlock) : "",
    lastReplyUser:
      lastBlock && lastBlock !== authorBlock ? readCite(lastBlock) : "",
    lastReplyTime:
      lastBlock && lastBlock !== authorBlock ? readTime(lastBlock) : "",
    url: `${ONEPOINT_BASE}/thread-${tid}-1-1.html`,
  };
}

export function parseOnePointThreadList(html: string): OnePointThreadRow[] {
  return parseOnePointThreadRows(html)
    .map(parseOnePointThreadRow)
    .filter((thread) => thread.title);
}

export function parseOnePointSearchList(html: string): OnePointThreadRow[] {
  const items: OnePointThreadRow[] = [];
  const regex = /<li class="pbw" id="(\d+)">([\s\S]*?)<\/li>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html))) {
    const [, tid, inner] = match;
    const titleMatch = inner.match(/<h3[^>]*>\s*<a [^>]*>([\s\S]*?)<\/a>/);
    const title = decodeOnePointEntities(
      (titleMatch ? titleMatch[1] : "").replace(/<[^>]+>/g, ""),
    ).trim();
    if (!title) continue;
    const statsMatch = inner.match(
      /<p class="xg1">\s*([\d,]+)\s*个回复\s*-\s*([\d,]+)\s*次查看\s*<\/p>/,
    );
    const metaMatch = inner.match(
      /<p>\s*<span>([^<]+)<\/span>[\s\S]*?<a [^>]*space-uid-\d+[^>]*>([^<]+?)<\/a>[\s\S]*?<a [^>]*href="forum-(\d+)-[^"]*"[^>]*>([^<]+?)<\/a>/,
    );
    const postTime = metaMatch
      ? decodeOnePointEntities(metaMatch[1].trim())
      : "";
    const author = metaMatch ? decodeOnePointEntities(metaMatch[2].trim()) : "";
    const fid = metaMatch ? metaMatch[3] : "";
    const forum = metaMatch ? decodeOnePointEntities(metaMatch[4].trim()) : "";
    items.push({
      tid,
      title,
      author,
      forum,
      fid,
      replies: statsMatch ? Number(statsMatch[1].replace(/,/g, "")) : 0,
      views: statsMatch ? Number(statsMatch[2].replace(/,/g, "")) : 0,
      postTime,
      lastReplyUser: "",
      lastReplyTime: postTime,
      kind: "search",
      url: `${ONEPOINT_BASE}/thread-${tid}-1-1.html`,
    });
  }
  return items;
}

function mapThreadListRow(thread: OnePointThreadRow, index: number) {
  return {
    rank: index + 1,
    tid: thread.tid,
    title: thread.title,
    forum: thread.forum,
    author: thread.author,
    replies: thread.replies,
    views: thread.views,
    lastReplyTime: thread.lastReplyTime,
    url: thread.url,
  };
}

async function runGuideCommand(
  view: "hot" | "new" | "digest",
  kwargs: Record<string, unknown>,
) {
  const limit = normalizeOnePointLimit(kwargs.limit, 20, 50);
  const html = await fetchOnePointHtml(
    `${ONEPOINT_BASE}/forum.php?mod=guide&view=${view}`,
  );
  return parseOnePointThreadList(html)
    .slice(0, limit)
    .map((thread, index) =>
      view === "new"
        ? {
            rank: index + 1,
            tid: thread.tid,
            title: thread.title,
            forum: thread.forum,
            author: thread.author,
            replies: thread.replies,
            views: thread.views,
            postTime: thread.postTime,
            url: thread.url,
          }
        : mapThreadListRow(thread, index),
    );
}

cli({
  site: "1point3acres",
  name: "hot",
  description: "Read hot 1Point3Acres threads",
  domain: ONEPOINT_HOST,
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    {
      name: "limit",
      type: "int",
      default: 20,
      description: "Number of rows to return, max 50",
    },
  ],
  columns: ONEPOINT_THREAD_LIST_COLUMNS,
  func: async (_page, kwargs) => runGuideCommand("hot", kwargs),
});

cli({
  site: "1point3acres",
  name: "latest",
  description: "Read latest 1Point3Acres threads",
  domain: ONEPOINT_HOST,
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    {
      name: "limit",
      type: "int",
      default: 20,
      description: "Number of rows to return, max 50",
    },
  ],
  columns: ONEPOINT_LATEST_COLUMNS,
  func: async (_page, kwargs) => runGuideCommand("new", kwargs),
});

cli({
  site: "1point3acres",
  name: "digest",
  description: "Read digest 1Point3Acres threads",
  domain: ONEPOINT_HOST,
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    {
      name: "limit",
      type: "int",
      default: 20,
      description: "Number of rows to return, max 50",
    },
  ],
  columns: ONEPOINT_THREAD_LIST_COLUMNS,
  func: async (_page, kwargs) => runGuideCommand("digest", kwargs),
});

cli({
  site: "1point3acres",
  name: "forum",
  description: "Browse threads from a 1Point3Acres forum by fid",
  domain: ONEPOINT_HOST,
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: "fid", required: true, positional: true, description: "Forum id" },
    { name: "page", type: "int", default: 1, description: "Page number" },
    {
      name: "limit",
      type: "int",
      default: 20,
      description: "Number of rows to return, max 50",
    },
  ],
  columns: ONEPOINT_FORUM_COLUMNS,
  func: async (_page, kwargs) => {
    const fid = cleanString(kwargs.fid);
    if (!/^\d+$/.test(fid)) throw new Error("fid must be a numeric forum id");
    const page = normalizeOnePointPositiveInteger(kwargs.page, 1, "page");
    const limit = normalizeOnePointLimit(kwargs.limit, 20, 50);
    const html = await fetchOnePointHtml(
      `${ONEPOINT_BASE}/forum-${fid}-${page}.html`,
    );
    if (parseOnePointThreadRows(html).length === 0) return [];
    return parseOnePointThreadList(html)
      .slice(0, limit)
      .map((thread, index) => ({
        rank: index + 1,
        tid: thread.tid,
        kind: thread.kind === "stickthread" ? "sticky" : "normal",
        title: thread.title,
        author: thread.author,
        replies: thread.replies,
        views: thread.views,
        lastReplyTime: thread.lastReplyTime,
        url: thread.url,
      }));
  },
});

cli({
  site: "1point3acres",
  name: "forums",
  description: "List 1Point3Acres forum ids and names",
  domain: ONEPOINT_HOST,
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    {
      name: "filter",
      type: "str",
      default: "",
      description: "Filter by forum name substring",
    },
  ],
  columns: ONEPOINT_FORUMS_COLUMNS,
  func: async (_page, kwargs) => {
    const html = await fetchOnePointHtml(`${ONEPOINT_BASE}/forum.php`);
    const seen = new Map<string, string>();
    const regex =
      /<a href="forum-(\d+)-1\.html"[^>]*class="[^"]*overflow-hidden[^"]*"[^>]*>\s*([^<]+?)\s*<\/a>/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(html))) {
      const fid = match[1];
      const name = decodeOnePointEntities(match[2].trim())
        .replace(/^\[(.+)\]$/, "$1")
        .trim();
      if (name && !seen.has(fid)) seen.set(fid, name);
    }
    const filter = cleanString(kwargs.filter).toLowerCase();
    return [...seen]
      .filter(([, name]) => !filter || name.toLowerCase().includes(filter))
      .map(([fid, name]) => ({
        fid,
        name,
        url: `${ONEPOINT_BASE}/forum-${fid}-1.html`,
      }));
  },
});

cli({
  site: "1point3acres",
  name: "search",
  description: "Search 1Point3Acres forum posts using browser cookies",
  domain: ONEPOINT_HOST,
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "query", required: true, positional: true, description: "Keyword" },
    {
      name: "limit",
      type: "int",
      default: 20,
      description: "Number of rows to return, max 50",
    },
    { name: "fid", type: "str", default: "", description: "Optional forum id" },
  ],
  columns: ONEPOINT_SEARCH_COLUMNS,
  func: async (page, kwargs) => {
    const query = cleanString(kwargs.query);
    if (!query) throw new Error("query cannot be empty");
    const limit = normalizeOnePointLimit(kwargs.limit, 20, 50);
    const fid = cleanString(kwargs.fid);
    if (fid && !/^\d+$/.test(fid))
      throw new Error("fid must be a numeric forum id");
    const cookie = await getOnePointCookie(page);
    const params = new URLSearchParams({
      mod: "forum",
      srchtxt: query,
      searchsubmit: "yes",
      ...(fid ? { srchfid: fid } : {}),
    });
    const html = await fetchOnePointHtml(
      `${ONEPOINT_BASE}/search.php?${params}`,
      {
        cookie,
        headers: { Referer: `${ONEPOINT_BASE}/` },
      },
    );
    assertOnePointNotGuestAlert(html);
    const items = parseOnePointSearchList(html);
    if (items.length === 0)
      throw new Error(`No 1Point3Acres search results for "${query}"`);
    return items.slice(0, limit).map((thread, index) => ({
      rank: index + 1,
      tid: thread.tid,
      title: thread.title,
      forum: thread.forum,
      author: thread.author,
      replies: thread.replies,
      views: thread.views,
      postTime: thread.postTime,
      url: thread.url,
    }));
  },
});

cli({
  site: "1point3acres",
  name: "thread",
  description: "Read a 1Point3Acres thread page with floor rows",
  domain: ONEPOINT_HOST,
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: "tid", required: true, positional: true, description: "Thread id" },
    { name: "page", type: "int", default: 1, description: "Thread page" },
    {
      name: "limit",
      type: "int",
      default: 10,
      description: "Number of floors",
    },
    {
      name: "contentLimit",
      type: "int",
      default: 400,
      description: "Max content characters per floor",
    },
  ],
  columns: ONEPOINT_THREAD_COLUMNS,
  func: async (_page, kwargs) => {
    const tid = cleanString(kwargs.tid);
    if (!/^\d+$/.test(tid)) throw new Error("tid must be a numeric thread id");
    const page = normalizeOnePointPositiveInteger(kwargs.page, 1, "page");
    const limit = normalizeOnePointPositiveInteger(kwargs.limit, 10, "limit");
    const contentLimit = normalizeOnePointPositiveInteger(
      kwargs.contentLimit,
      400,
      "contentLimit",
      { min: 50 },
    );
    const html = await fetchOnePointHtml(
      `${ONEPOINT_BASE}/thread-${tid}-${page}-1.html`,
    );
    if (!/id="postlist"/.test(html) && !/id="post_\d+"/.test(html)) {
      throw new Error(`Thread ${tid} does not exist or is unavailable`);
    }
    const offsets: Array<{ postId: string; offset: number }> = [];
    const regex = /<div id="post_(\d+)"[^>]*>/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(html))) {
      offsets.push({ postId: match[1], offset: match.index });
    }
    const rows: Array<{
      floor: number;
      pid: string;
      author: string;
      postTime: string;
      content: string;
      url: string;
    }> = [];
    for (
      let index = 0;
      index < offsets.length && rows.length < limit;
      index += 1
    ) {
      const current = offsets[index];
      const end =
        index + 1 < offsets.length ? offsets[index + 1].offset : html.length;
      const block = html.slice(current.offset, end);
      const authiBlock = extract(block, /(<div class="authi"[\s\S]*?<\/div>)/);
      const author =
        decodeOnePointEntities(
          extract(
            authiBlock || block,
            /<a [^>]*class="[^"]*\bxi2\b[^"]*"[^>]*>\s*([^<]+?)\s*<\/a>/,
          ),
        ) ||
        decodeOnePointEntities(
          extract(
            authiBlock || block,
            /<a [^>]*href="space-uid-\d+\.html"[^>]*>\s*([^<]+?)\s*<\/a>/,
          ),
        );
      const postTime =
        extract(authiBlock, /<span title="([^"]+)">/) ||
        extract(block, /id="authorposton\d+"[^>]*>\s*<span title="([^"]+)">/);
      const floorText =
        extract(block, /<em>(\d+)<\/em>\s*#?\s*<\/a>/) ||
        extract(block, /id="postnum\d+"[^>]*>\s*<em>(\d+)<\/em>/);
      const content = truncateOnePoint(
        stripOnePointHtml(
          extract(block, /id="postmessage_\d+"[^>]*>([\s\S]*?)<\/td>/),
        ),
        contentLimit,
      );
      rows.push({
        floor: floorText
          ? Number(floorText)
          : page === 1 && index === 0
            ? 1
            : (page - 1) * 10 + index + 1,
        pid: current.postId,
        author,
        postTime: postTime.trim(),
        content,
        url: `${ONEPOINT_BASE}/forum.php?mod=redirect&goto=findpost&ptid=${tid}&pid=${current.postId}`,
      });
    }
    if (page === 1 && rows.length > 0) {
      const title = decodeOnePointEntities(
        extract(html, /<span id="thread_subject">([^<]+)<\/span>/).trim() ||
          extract(html, /<title>([^<]+?)\s*[-|]/).trim(),
      );
      if (title) rows[0].content = `[${title}]\n${rows[0].content}`;
    }
    if (!rows.length)
      throw new Error(`Thread ${tid} page ${page} has no readable floors`);
    return rows;
  },
});

cli({
  site: "1point3acres",
  name: "user",
  description: "Read a 1Point3Acres user profile",
  domain: ONEPOINT_HOST,
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    {
      name: "who",
      required: true,
      positional: true,
      description: "Username or numeric uid",
    },
  ],
  columns: ONEPOINT_USER_COLUMNS,
  func: async (_page, kwargs) => {
    const who = cleanString(kwargs.who);
    if (!who) throw new Error("who cannot be empty");
    const url = /^\d+$/.test(who)
      ? `${ONEPOINT_BASE}/space-uid-${who}.html`
      : `${ONEPOINT_BASE}/space-username-${encodeURIComponent(who)}.html`;
    const html = await fetchOnePointHtml(url);
    if (/<title>提示信息/.test(html) && /(没有找到|不存在)/.test(html)) {
      throw new Error(`User "${who}" does not exist`);
    }
    const pick = (regex: RegExp) =>
      decodeOnePointEntities(extract(html, regex).trim());
    const pickLi = (label: string) => {
      const regex = new RegExp(
        `<li>\\s*${label}[：:\\s]*(?:<[^>]+>)?\\s*([^<]+?)\\s*(?:<|$)`,
      );
      return pick(regex);
    };
    const username =
      pick(/<p class="mtm[^"]*"[^>]*>\s*<a [^>]*>([^<]+?)<\/a>/) ||
      pick(/<title>([^<]+?)的个人资料/);
    const uid = pick(/uid=(\d+)/) || pick(/space-uid-(\d+)\.html/);
    return [
      {
        uid,
        username,
        group: pickLi("用户组"),
        credits: pickLi("积分"),
        rice: pickLi("大米"),
        posts: pickLi("帖子数"),
        threads: pickLi("主题数"),
        digests: pickLi("精华数"),
        registerTime: pickLi("注册时间"),
        lastAccess: pickLi("最后访问"),
        profileUrl: uid ? `${ONEPOINT_BASE}/space-uid-${uid}.html` : url,
      },
    ];
  },
});

cli({
  site: "1point3acres",
  name: "notifications",
  description: "Read 1Point3Acres account notifications using browser cookies",
  domain: ONEPOINT_HOST,
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "kind",
      type: "str",
      default: "mypost",
      description: "Notice type: mypost, interactive, system, or app",
    },
    { name: "limit", type: "int", default: 20, description: "Number of rows" },
  ],
  columns: ONEPOINT_NOTIFICATION_COLUMNS,
  func: async (page, kwargs) => {
    const kind = cleanString(kwargs.kind || "mypost");
    const limit = normalizeOnePointPositiveInteger(kwargs.limit, 20, "limit");
    const cookie = await getOnePointCookie(page);
    const html = await fetchOnePointHtml(
      `${ONEPOINT_BASE}/home.php?mod=space&do=notice&view=${encodeURIComponent(kind)}`,
      { cookie, headers: { Referer: `${ONEPOINT_BASE}/` } },
    );
    if (/<title>提示信息/.test(html) && /请登录/.test(html)) {
      throw new Error("Login to www.1point3acres.com is required");
    }
    if (/暂时没有提醒内容/.test(html)) {
      throw new Error("No 1Point3Acres notifications are available");
    }
    const rows: Array<{
      index: number;
      from: string;
      summary: string;
      time: string;
      threadUrl: string;
    }> = [];
    const regex = /<dl class="[^"]*cl[^"]*"[^>]*>([\s\S]*?)<\/dl>/g;
    let match: RegExpExecArray | null;
    let index = 0;
    while ((match = regex.exec(html)) && rows.length < limit) {
      const block = match[1];
      const from = decodeOnePointEntities(
        extract(block, /<dt>([\s\S]*?)<\/dt>/),
      )
        .replace(/<[^>]+>/g, "")
        .trim();
      const summaryRaw =
        extract(block, /<dd class="ntc_body">([\s\S]*?)<\/dd>/) ||
        extract(block, /<dd>([\s\S]*?)<\/dd>/);
      const summary = truncateOnePoint(stripOnePointHtml(summaryRaw), 200);
      const time = extract(
        block,
        /<dd class="[^"]*xg1[^"]*"[^>]*>([\s\S]*?)<\/dd>/,
      )
        .replace(/<[^>]+>/g, "")
        .trim();
      const link = summaryRaw.match(/href="([^"]*thread-\d+[^"]*)"/);
      const threadUrl = link
        ? link[1].startsWith("http")
          ? link[1]
          : `${ONEPOINT_BASE}/${link[1]}`
        : "";
      index += 1;
      if (!from && !summary) continue;
      rows.push({ index, from, summary, time, threadUrl });
    }
    return rows;
  },
});
