/**
 * @owner   Threads public page metadata adapter.
 * @does    Register public profile, post, and media readers backed by Threads OG metadata.
 * @needs   Threads public HTML pages exposing Open Graph metadata.
 * @feeds   Social research workflows and Threads capability coverage.
 * @breaks  Threads hiding public metadata or changing canonical post/profile markup.
 */

import { USER_AGENT } from "../../constants.js";
import { cli, Strategy } from "../../registry.js";

export interface ThreadsPostRow {
  author: string;
  handle: string;
  text: string;
  url: string;
  image_url: string;
  image_width: number;
  image_height: number;
  shortcode: string;
  activity_json_url: string;
}

export interface ThreadsProfileRow {
  name: string;
  handle: string;
  followers: string;
  threads: string;
  bio: string;
  url: string;
  avatar_url: string;
}

interface Identity {
  name: string;
  handle: string;
}

const THREADS_HOST_RE = /(^|\.)threads\.(net|com)$/i;

function decodeHtml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 10)),
    )
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function attributesFor(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /\s([^\s"'=<>`]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const match of tag.matchAll(attrRe)) {
    attrs[match[1].toLowerCase()] = decodeHtml(
      match[2] ?? match[3] ?? match[4] ?? "",
    );
  }
  return attrs;
}

function metaContent(html: string, key: string): string {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributesFor(match[0]);
    if (attrs.property === key || attrs.name === key)
      return attrs.content ?? "";
  }
  return "";
}

function linkHref(html: string, rel: string, type: string): string {
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = attributesFor(match[0]);
    const rels = new Set(
      (attrs.rel ?? "").toLowerCase().split(/\s+/).filter(Boolean),
    );
    if (rels.has(rel.toLowerCase()) && attrs.type === type)
      return attrs.href ?? "";
  }
  return "";
}

function firstNonEmpty(...values: string[]): string {
  return values.find((value) => value.trim())?.trim() ?? "";
}

function numberFromMeta(value: string): number {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? number : 0;
}

function cleanHandle(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Threads handle cannot be empty");
  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    const handle = url.pathname.split("/").find((part) => part.startsWith("@"));
    if (!handle)
      throw new Error(`Threads URL does not contain a handle: ${input}`);
    return handle.replace(/^@/, "");
  }
  return trimmed.replace(/^@/, "").replace(/^\/+/, "").split("/")[0];
}

function handleFromUrl(input: string): string {
  const url = new URL(input);
  const handle = url.pathname.split("/").find((part) => part.startsWith("@"));
  return handle ? handle : "";
}

function identityFromTitle(title: string, fallbackHandle: string): Identity {
  const match = title.match(/^\s*(.*?)\s+\((@[A-Za-z0-9._]+)\)/);
  const handle = match?.[2] ?? fallbackHandle;
  const name = firstNonEmpty(match?.[1] ?? "", handle.replace(/^@/, ""));
  return { name, handle };
}

function ensureThreadsUrl(url: URL): void {
  if (!THREADS_HOST_RE.test(url.hostname)) {
    throw new Error(
      `Expected a threads.net or threads.com URL, got ${url.hostname}`,
    );
  }
}

export function normalizeThreadsProfileUrl(input: string): string {
  const handle = cleanHandle(input);
  return `https://www.threads.net/@${encodeURIComponent(handle)}`;
}

export function normalizeThreadsPostUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Threads post URL cannot be empty");
  const raw =
    trimmed.startsWith("@") || trimmed.startsWith("/@")
      ? `https://www.threads.net/${trimmed.replace(/^\/+/, "")}`
      : trimmed;
  const url = new URL(raw);
  ensureThreadsUrl(url);
  if (!/^\/@[^/]+\/post\/[^/?#]+/.test(url.pathname)) {
    throw new Error(
      `Expected Threads post URL path /@handle/post/shortcode, got ${url.pathname}`,
    );
  }
  return url.toString();
}

function shortcodeFromPost(url: string, iosUrl: string): string {
  const iosMatch = iosUrl.match(/[?&]shortcode=([^&]+)/);
  if (iosMatch) return decodeURIComponent(iosMatch[1]);
  const urlMatch = url.match(/\/post\/([^/?#]+)/);
  return urlMatch ? decodeURIComponent(urlMatch[1]) : "";
}

export function parseThreadsPostHtml(
  html: string,
  fallbackUrl: string,
): ThreadsPostRow {
  const url = firstNonEmpty(metaContent(html, "og:url"), fallbackUrl);
  const title = metaContent(html, "og:title");
  const text = firstNonEmpty(
    metaContent(html, "og:description"),
    metaContent(html, "twitter:description"),
  );
  const imageUrl = metaContent(html, "og:image");
  const fallbackHandle = handleFromUrl(url);
  const identity = identityFromTitle(title, fallbackHandle);
  if (!identity.handle || (!text && !imageUrl)) {
    throw new Error("Threads post page did not expose usable public metadata");
  }
  return {
    activity_json_url: linkHref(html, "alternate", "application/activity+json"),
    author: identity.name,
    handle: identity.handle,
    image_height: numberFromMeta(metaContent(html, "og:image:height")),
    image_url: imageUrl,
    image_width: numberFromMeta(metaContent(html, "og:image:width")),
    shortcode: shortcodeFromPost(url, metaContent(html, "al:ios:url")),
    text,
    url,
  };
}

export function parseThreadsProfileHtml(
  html: string,
  handleInput: string,
): ThreadsProfileRow {
  const title = metaContent(html, "og:title");
  const description = metaContent(html, "og:description");
  const url = firstNonEmpty(
    metaContent(html, "og:url"),
    normalizeThreadsProfileUrl(handleInput),
  );
  const identity = identityFromTitle(title, `@${cleanHandle(handleInput)}`);
  const parts = description
    .split("•")
    .map((part) => part.trim())
    .filter(Boolean);
  const followers =
    parts
      .find((part) => /\bFollowers\b/i.test(part))
      ?.replace(/\s*Followers\b/i, "") ?? "";
  const threads =
    parts
      .find((part) => /\bThreads\b/i.test(part))
      ?.replace(/\s*Threads\b/i, "") ?? "";
  const bio = firstNonEmpty(
    ...parts.filter((part) => !/\b(Followers|Threads)\b/i.test(part)),
  ).replace(/\s*See the latest conversations with @[^.]+\.?$/i, "");
  if (!identity.handle || !identity.name) {
    throw new Error(
      "Threads profile page did not expose usable public metadata",
    );
  }
  return {
    avatar_url: metaContent(html, "og:image"),
    bio,
    followers,
    handle: identity.handle,
    name: identity.name,
    threads,
    url,
  };
}

function mediaRowsFromPost(
  post: ThreadsPostRow,
): Array<Record<string, string | number>> {
  if (!post.image_url) return [];
  return [
    {
      rank: 1,
      type: "image",
      url: post.image_url,
      width: post.image_width,
      height: post.image_height,
      post_url: post.url,
      shortcode: post.shortcode,
      source: "og:image",
    },
  ];
}

async function fetchThreadsHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": USER_AGENT,
    },
  });
  if (!response.ok) {
    const preview = (await response.text()).slice(0, 200);
    throw new Error(`Threads HTTP ${response.status} from ${url}: ${preview}`);
  }
  return response.text();
}

cli({
  site: "threads",
  name: "profile",
  description: "Get public Threads profile metadata",
  domain: "threads.net",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "handle",
      required: true,
      positional: true,
      description: "Threads handle or profile URL, e.g. zuck",
    },
  ],
  columns: [
    "name",
    "handle",
    "followers",
    "threads",
    "bio",
    "url",
    "avatar_url",
  ],
  socialCapabilities: ["read", "author", "relations"],
  func: async (_page, kwargs) => {
    const url = normalizeThreadsProfileUrl(String(kwargs.handle ?? ""));
    const html = await fetchThreadsHtml(url);
    return [parseThreadsProfileHtml(html, String(kwargs.handle ?? ""))];
  },
});

cli({
  site: "threads",
  name: "post",
  description: "Get a public Threads post from its metadata",
  domain: "threads.net",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "url",
      required: true,
      positional: true,
      description:
        "Threads post URL, e.g. https://www.threads.net/@zuck/post/DYSAIo_FL77",
    },
  ],
  columns: [
    "author",
    "handle",
    "text",
    "url",
    "image_url",
    "image_width",
    "image_height",
    "shortcode",
    "activity_json_url",
  ],
  socialCapabilities: ["read", "author", "media"],
  func: async (_page, kwargs) => {
    const url = normalizeThreadsPostUrl(String(kwargs.url ?? ""));
    const html = await fetchThreadsHtml(url);
    return [parseThreadsPostHtml(html, url)];
  },
});

cli({
  site: "threads",
  name: "media",
  description: "List public media exposed by a Threads post",
  domain: "threads.net",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "url",
      required: true,
      positional: true,
      description:
        "Threads post URL, e.g. https://www.threads.net/@zuck/post/DYSAIo_FL77",
    },
  ],
  columns: [
    "rank",
    "type",
    "url",
    "width",
    "height",
    "post_url",
    "shortcode",
    "source",
  ],
  socialCapabilities: ["read", "media"],
  func: async (_page, kwargs) => {
    const url = normalizeThreadsPostUrl(String(kwargs.url ?? ""));
    const html = await fetchThreadsHtml(url);
    const rows = mediaRowsFromPost(parseThreadsPostHtml(html, url));
    if (rows.length === 0)
      throw new Error("Threads post metadata did not include media");
    return rows;
  },
});
