/**
 * @owner   src/adapters/ehentai/web.ts
 * @does    Register E-Hentai public search, gallery metadata, page listing, and torrent metadata commands.
 * @needs   E-Hentai search HTML, official api.e-hentai.org gdata endpoint, conservative gallery URL parsing.
 * @feeds   surface coverage ledger, gallery research workflows, torrent metadata discovery.
 * @breaks  Search table markup drift, gdata envelope drift, or gallery token parsing errors hide gallery results.
 */

import { USER_AGENT } from "../../constants.js";
import { cli, Strategy } from "../../registry.js";

const EHENTAI_ORIGIN = "https://e-hentai.org";
const EHENTAI_API = "https://api.e-hentai.org/api.php";
const GALLERY_RE = /\/g\/(\d+)\/([0-9a-f]{10})\/?/i;
const GID_TOKEN_RE = /^(\d+)[/:]([0-9a-f]{10})$/i;
const EHENTAI_CATEGORY_BITS = {
  misc: 1,
  doujinshi: 2,
  manga: 4,
  artistcg: 8,
  gamecg: 16,
  imageset: 32,
  cosplay: 64,
  asianporn: 128,
  nonh: 256,
  western: 512,
} as const;
const EHENTAI_ALL_CATEGORIES = 1023;
const EHENTAI_TAG_NAMESPACES = new Set([
  "artist",
  "character",
  "female",
  "group",
  "language",
  "male",
  "mixed",
  "other",
  "parody",
]);

interface EhentaiGalleryIdentity {
  gid: number;
  token: string;
  url: string;
}

interface EhentaiTorrent {
  hash?: unknown;
  added?: unknown;
  name?: unknown;
  tsize?: unknown;
  fsize?: unknown;
}

interface EhentaiMetadata {
  gid?: unknown;
  token?: unknown;
  title?: unknown;
  title_jpn?: unknown;
  category?: unknown;
  thumb?: unknown;
  uploader?: unknown;
  posted?: unknown;
  filecount?: unknown;
  filesize?: unknown;
  expunged?: unknown;
  rating?: unknown;
  torrentcount?: unknown;
  torrents?: unknown;
  tags?: unknown;
}

interface EhentaiGdataResponse {
  gmetadata?: EhentaiMetadata[];
}

interface EhentaiSearchRow {
  rank: number;
  gid: number;
  token: string;
  title: string;
  category: string;
  published: string;
  pages: string;
  uploader: string;
  thumb: string;
  torrent_available: boolean;
  tags: string;
  url: string;
}

interface EhentaiSearchOptions {
  query: string;
  page: number;
  cursor: string;
  categoryMask?: number;
  requireTorrent: boolean;
  includeExpunged: boolean;
  minPages: string;
  maxPages: string;
  minRating: string;
}

function str(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

export function decodeEhentaiHtml(value: unknown): string {
  return str(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, dec: string) =>
      String.fromCodePoint(Number.parseInt(dec, 10)),
    )
    .trim();
}

export function requireEhentaiLimit(value: unknown, fallback = 20): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new Error("ehentai limit must be an integer in [1, 100].");
  }
  return n;
}

export function requireEhentaiQuery(value: unknown): string {
  const query = str(value).trim();
  if (!query) throw new Error("ehentai search query cannot be empty.");
  return query;
}

function splitCommaList(value: unknown): string[] {
  return str(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeEhentaiTagValue(value: unknown): string {
  return str(value)
    .trim()
    .replace(/\$$/, "")
    .replace(/\s+/g, "_")
    .toLowerCase();
}

function namespacedTag(
  namespace: string,
  value: unknown,
  exact: boolean,
): string {
  const tag = normalizeEhentaiTagValue(value);
  if (!tag) return "";
  return `${namespace}:${tag}${exact ? "$" : ""}`;
}

function normalizeCategory(value: string): keyof typeof EHENTAI_CATEGORY_BITS {
  const token = value.toLowerCase().replace(/[\s_-]+/g, "");
  if (token === "artistcg" || token === "artist") return "artistcg";
  if (token === "gamecg" || token === "game") return "gamecg";
  if (token === "imageset" || token === "image") return "imageset";
  if (token === "asianporn" || token === "asian") return "asianporn";
  if (token === "nonh" || token === "non") return "nonh";
  if (token === "comic") return "manga";
  if (token in EHENTAI_CATEGORY_BITS) {
    return token as keyof typeof EHENTAI_CATEGORY_BITS;
  }
  throw new Error(`Unsupported E-Hentai category: ${value}.`);
}

export function ehentaiCategoryMask(value: unknown): number | undefined {
  const raw = splitCommaList(value);
  if (raw.length === 0) return undefined;
  const expanded = raw.flatMap((item) => {
    const token = item.toLowerCase().replace(/[\s_-]+/g, "");
    if (token === "all" || token === "*") {
      return Object.keys(EHENTAI_CATEGORY_BITS);
    }
    if (token === "cg") return ["artistcg", "gamecg"];
    return [item];
  });
  const includeMask = expanded.reduce(
    (mask, item) => mask | EHENTAI_CATEGORY_BITS[normalizeCategory(item)],
    0,
  );
  return EHENTAI_ALL_CATEGORIES ^ includeMask;
}

function structuredTags(kwargs: Record<string, unknown>): string[] {
  const exact = kwargs.exact_tags !== false;
  const out: string[] = [];
  for (const namespace of EHENTAI_TAG_NAMESPACES) {
    for (const value of splitCommaList(kwargs[namespace])) {
      const tag = namespacedTag(namespace, value, exact);
      if (tag) out.push(tag);
    }
  }
  for (const raw of splitCommaList(kwargs.tags)) {
    const [namespace, value] = raw.split(/:(.+)/, 2);
    if (!value || !EHENTAI_TAG_NAMESPACES.has(namespace.toLowerCase())) {
      throw new Error(
        `E-Hentai tags must be namespaced, for example artist:tony taka or language:chinese. Received: ${raw}`,
      );
    }
    out.push(namespacedTag(namespace.toLowerCase(), value, exact));
  }
  return out;
}

export function buildEhentaiSearchQuery(
  kwargs: Record<string, unknown>,
): string {
  const parts = [str(kwargs.query).trim(), ...structuredTags(kwargs)].filter(
    Boolean,
  );
  const query = parts.join(" ").trim();
  if (!query) {
    throw new Error(
      "E-Hentai search needs a query or at least one structured tag filter.",
    );
  }
  return query;
}

export function parseEhentaiGallery(value: unknown): EhentaiGalleryIdentity {
  const raw = str(value).trim();
  const direct = raw.match(GID_TOKEN_RE);
  if (direct) {
    const gid = Number(direct[1]);
    return {
      gid,
      token: direct[2].toLowerCase(),
      url: `${EHENTAI_ORIGIN}/g/${gid}/${direct[2].toLowerCase()}/`,
    };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      "E-Hentai gallery must be a gallery URL or gid/token pair.",
    );
  }
  if (url.hostname !== "e-hentai.org" && url.hostname !== "exhentai.org") {
    throw new Error(
      "E-Hentai gallery URL must use e-hentai.org or exhentai.org.",
    );
  }
  const match = url.pathname.match(GALLERY_RE);
  if (!match) {
    throw new Error("E-Hentai gallery URL must have /g/<gid>/<token>/ shape.");
  }
  const gid = Number(match[1]);
  return {
    gid,
    token: match[2].toLowerCase(),
    url: `${url.origin}/g/${gid}/${match[2].toLowerCase()}/`,
  };
}

export function ehentaiSearchUrl(options: EhentaiSearchOptions): string {
  const url = new URL(EHENTAI_ORIGIN);
  if (options.query) url.searchParams.set("f_search", options.query);
  if (options.categoryMask !== undefined && options.categoryMask !== 0) {
    url.searchParams.set("f_cats", String(options.categoryMask));
  }
  if (options.cursor) {
    url.searchParams.set("next", options.cursor);
  } else if (options.page > 0) {
    url.searchParams.set("page", String(options.page));
  }
  if (
    options.requireTorrent ||
    options.includeExpunged ||
    options.minPages ||
    options.maxPages ||
    options.minRating
  ) {
    url.searchParams.set("advsearch", "1");
  }
  if (options.requireTorrent) url.searchParams.set("f_sto", "on");
  if (options.includeExpunged) url.searchParams.set("f_sh", "on");
  if (options.minPages) url.searchParams.set("f_spf", options.minPages);
  if (options.maxPages) url.searchParams.set("f_spt", options.maxPages);
  if (options.minRating) url.searchParams.set("f_srdd", options.minRating);
  return url.toString();
}

function requireEhentaiSearchOptions(
  kwargs: Record<string, unknown>,
): EhentaiSearchOptions {
  const page = Number(kwargs.page ?? 0);
  if (!Number.isInteger(page) || page < 0) {
    throw new Error("ehentai page must be a non-negative integer.");
  }
  const minRating = str(kwargs.min_rating).trim();
  if (minRating && !["2", "3", "4", "5"].includes(minRating)) {
    throw new Error("ehentai min_rating must be one of 2, 3, 4, or 5.");
  }
  return {
    query: buildEhentaiSearchQuery(kwargs),
    page,
    cursor: str(kwargs.cursor).trim(),
    categoryMask: ehentaiCategoryMask(kwargs.category),
    requireTorrent: kwargs.require_torrent === true,
    includeExpunged: kwargs.include_expunged === true,
    minPages: str(kwargs.min_pages).trim(),
    maxPages: str(kwargs.max_pages).trim(),
    minRating,
  };
}

async function runEhentaiSearch(
  kwargs: Record<string, unknown>,
): Promise<EhentaiSearchRow[]> {
  const limit = requireEhentaiLimit(kwargs.limit);
  const rows = parseEhentaiSearchHtml(
    await fetchText(ehentaiSearchUrl(requireEhentaiSearchOptions(kwargs))),
    limit,
  );
  if (rows.length === 0) throw new Error("No E-Hentai galleries found.");
  return rows;
}

const EHENTAI_SEARCH_COLUMNS = [
  "rank",
  "gid",
  "token",
  "title",
  "category",
  "published",
  "pages",
  "uploader",
  "torrent_available",
  "tags",
  "url",
];

const EHENTAI_SEARCH_FILTER_ARGS = [
  { name: "limit", type: "int" as const, default: 20 },
  { name: "page", type: "int" as const, default: 0 },
  {
    name: "cursor",
    type: "str" as const,
    description: "Next cursor GID from E-Hentai navigation URLs",
  },
  {
    name: "category",
    type: "str" as const,
    description:
      "Comma-separated categories: doujinshi,manga,artistcg,gamecg,cg,imageset,cosplay,asianporn,nonh,western,misc",
  },
  {
    name: "tags",
    type: "str" as const,
    description:
      "Comma-separated namespaced tags, for example artist:tony taka,language:chinese,other:full color",
  },
  { name: "artist", type: "str" as const },
  { name: "group", type: "str" as const },
  { name: "parody", type: "str" as const },
  { name: "character", type: "str" as const },
  { name: "language", type: "str" as const },
  { name: "female", type: "str" as const },
  { name: "male", type: "str" as const },
  { name: "mixed", type: "str" as const },
  { name: "other", type: "str" as const },
  { name: "exact_tags", type: "bool" as const, default: true },
  { name: "require_torrent", type: "bool" as const, default: false },
  { name: "include_expunged", type: "bool" as const, default: false },
  { name: "min_pages", type: "int" as const },
  { name: "max_pages", type: "int" as const },
  { name: "min_rating", type: "int" as const },
];

const EHENTAI_RESULT_FILTER_ARGS = EHENTAI_SEARCH_FILTER_ARGS.filter(
  (arg) =>
    ![
      "artist",
      "character",
      "female",
      "group",
      "language",
      "male",
      "mixed",
      "other",
      "parody",
      "tags",
    ].includes(arg.name),
);

function requireEhentaiTagNamespace(value: unknown): string {
  const namespace = str(value).trim().toLowerCase();
  if (!EHENTAI_TAG_NAMESPACES.has(namespace)) {
    throw new Error(
      `E-Hentai tag namespace must be one of ${[...EHENTAI_TAG_NAMESPACES].join(", ")}.`,
    );
  }
  return namespace;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": USER_AGENT,
    },
  });
  if (!response.ok) {
    throw new Error(`E-Hentai request failed with HTTP ${response.status}.`);
  }
  return response.text();
}

async function fetchGdata(
  identity: EhentaiGalleryIdentity,
): Promise<EhentaiMetadata> {
  const response = await fetch(EHENTAI_API, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      method: "gdata",
      gidlist: [[identity.gid, identity.token]],
      namespace: 1,
    }),
  });
  if (!response.ok) {
    throw new Error(`E-Hentai API returned HTTP ${response.status}.`);
  }
  const body = (await response.json()) as EhentaiGdataResponse;
  const metadata = body.gmetadata?.[0];
  if (!metadata || metadata.gid === undefined) {
    throw new Error("E-Hentai API returned no gallery metadata.");
  }
  return metadata;
}

function firstMatch(value: string, re: RegExp): string {
  const match = value.match(re);
  return match ? decodeEhentaiHtml(match[1]) : "";
}

function allMatches(value: string, re: RegExp): string[] {
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null)
    out.push(decodeEhentaiHtml(match[1]));
  return out;
}

export function parseEhentaiSearchHtml(
  html: string,
  limit: number,
): EhentaiSearchRow[] {
  const rows: EhentaiSearchRow[] = [];
  const chunks = html.split(/<tr><td class="gl1c/).slice(1);
  for (const chunk of chunks) {
    const section = `<tr><td class="gl1c${chunk}`;
    const gallery = section.match(
      /href="https:\/\/e-hentai\.org\/g\/(\d+)\/([0-9a-f]{10})\/"/i,
    );
    if (!gallery) continue;
    const title =
      firstMatch(section, /<div class="glink">([\s\S]*?)<\/div>/) ||
      firstMatch(section, /<img[^>]+alt="([^"]*)"/);
    if (!title) continue;
    const thumb =
      firstMatch(section, /\bdata-src="([^"]+)"/) ||
      firstMatch(section, /\bsrc="(https:\/\/[^"]+)"/);
    const tags = allMatches(section, /<div class="gt" title="([^"]+)">/g);
    rows.push({
      rank: rows.length + 1,
      gid: Number(gallery[1]),
      token: gallery[2],
      title,
      category: firstMatch(
        section,
        /<div class="cn [^"]*"[^>]*>([^<]+)<\/div>/,
      ),
      published: firstMatch(section, /id="posted(?:pop)?_\d+">([^<]+)<\/div>/),
      pages: firstMatch(section, /<div>(\d+\s+pages)<\/div>/),
      uploader: firstMatch(
        section,
        /<td class="gl4c[^"]*"><div><a(?:\s[^>]*)?>([^<]+)<\/a>/,
      ),
      thumb,
      torrent_available: /gallerytorrents\.php/.test(section),
      tags: tags.join(", "),
      url: `${EHENTAI_ORIGIN}/g/${gallery[1]}/${gallery[2]}/`,
    });
    if (rows.length >= limit) break;
  }
  return rows;
}

function metadataRow(metadata: EhentaiMetadata): Record<string, unknown> {
  const gid = Number(metadata.gid);
  const token = str(metadata.token);
  const tags = Array.isArray(metadata.tags) ? metadata.tags.map(String) : [];
  return {
    gid,
    token,
    title: str(metadata.title),
    title_jpn: str(metadata.title_jpn),
    category: str(metadata.category),
    uploader: str(metadata.uploader),
    posted: str(metadata.posted),
    filecount: str(metadata.filecount),
    filesize: metadata.filesize ?? "",
    expunged: Boolean(metadata.expunged),
    rating: str(metadata.rating),
    torrentcount: str(metadata.torrentcount),
    tags: tags.join(", "),
    thumb: str(metadata.thumb),
    url: `${EHENTAI_ORIGIN}/g/${gid}/${token}/`,
  };
}

export function mapEhentaiTorrents(
  metadata: EhentaiMetadata,
): Record<string, unknown>[] {
  const torrents = Array.isArray(metadata.torrents)
    ? (metadata.torrents as EhentaiTorrent[])
    : [];
  return torrents.map((torrent, index) => ({
    rank: index + 1,
    gid: Number(metadata.gid),
    title: str(metadata.title),
    hash: str(torrent.hash),
    added: str(torrent.added),
    name: str(torrent.name),
    tsize: str(torrent.tsize),
    fsize: str(torrent.fsize),
  }));
}

export function parseEhentaiGalleryPages(
  html: string,
  gallery: EhentaiGalleryIdentity,
  limit: number,
): Record<string, unknown>[] {
  const title = firstMatch(html, /<h1 id="gn">([\s\S]*?)<\/h1>/);
  const out: Record<string, unknown>[] = [];
  const re =
    /<a href="(https:\/\/e-hentai\.org\/s\/[^"]+)"><div title="Page\s+(\d+):\s*([^"]*)"[\s\S]*?background:transparent url\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    out.push({
      page: Number(match[2]),
      gid: gallery.gid,
      title,
      filename: decodeEhentaiHtml(match[3]),
      page_url: decodeEhentaiHtml(match[1]),
      thumb_sprite_url: decodeEhentaiHtml(match[4]),
      gallery_url: gallery.url,
    });
    if (out.length >= limit) break;
  }
  return out;
}

cli({
  site: "ehentai",
  name: "search",
  description:
    "Search public E-Hentai galleries with category and structured tag filters",
  domain: "e-hentai.org",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    {
      name: "query",
      type: "str",
      positional: true,
      description:
        "Free text search. Can be omitted when structured tag filters are supplied.",
    },
    ...EHENTAI_SEARCH_FILTER_ARGS,
  ],
  columns: EHENTAI_SEARCH_COLUMNS,
  func: async (_page, kwargs) => runEhentaiSearch(kwargs),
});

cli({
  site: "ehentai",
  name: "artist",
  description: "Search public E-Hentai galleries by exact artist tag",
  domain: "e-hentai.org",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    {
      name: "artist",
      type: "str",
      required: true,
      positional: true,
      description: "Artist tag, for example tony taka",
    },
    ...EHENTAI_RESULT_FILTER_ARGS,
  ],
  columns: EHENTAI_SEARCH_COLUMNS,
  func: async (_page, kwargs) => runEhentaiSearch(kwargs),
});

cli({
  site: "ehentai",
  name: "tag",
  description:
    "Search public E-Hentai galleries by exact namespaced tag such as artist, group, parody, language, or character",
  domain: "e-hentai.org",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    {
      name: "namespace",
      type: "str",
      required: true,
      positional: true,
      description:
        "Tag namespace: artist, group, parody, character, language, female, male, mixed, or other",
    },
    {
      name: "name",
      type: "str",
      required: true,
      positional: true,
      description: "Tag value; spaces are normalized to underscores",
    },
    ...EHENTAI_RESULT_FILTER_ARGS,
  ],
  columns: EHENTAI_SEARCH_COLUMNS,
  func: async (_page, kwargs) =>
    runEhentaiSearch({
      ...kwargs,
      tags: `${requireEhentaiTagNamespace(kwargs.namespace)}:${str(kwargs.name)}`,
    }),
});

cli({
  site: "ehentai",
  name: "gallery",
  description: "Get E-Hentai gallery metadata through the official API",
  domain: "api.e-hentai.org",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    {
      name: "input",
      type: "str",
      required: true,
      positional: true,
      description: "Gallery URL or gid/token pair",
    },
  ],
  columns: [
    "gid",
    "token",
    "title",
    "title_jpn",
    "category",
    "uploader",
    "posted",
    "filecount",
    "filesize",
    "rating",
    "torrentcount",
    "tags",
    "thumb",
    "url",
  ],
  func: async (_page, kwargs) => [
    metadataRow(await fetchGdata(parseEhentaiGallery(kwargs.input))),
  ],
});

cli({
  site: "ehentai",
  name: "torrents",
  description: "List E-Hentai gallery torrent metadata from the official API",
  domain: "api.e-hentai.org",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    {
      name: "input",
      type: "str",
      required: true,
      positional: true,
      description: "Gallery URL or gid/token pair",
    },
  ],
  columns: ["rank", "gid", "title", "hash", "added", "name", "tsize", "fsize"],
  func: async (_page, kwargs) => {
    const rows = mapEhentaiTorrents(
      await fetchGdata(parseEhentaiGallery(kwargs.input)),
    );
    if (rows.length === 0) throw new Error("No torrents found for gallery.");
    return rows;
  },
});

cli({
  site: "ehentai",
  name: "pages",
  description:
    "List public E-Hentai gallery image page URLs and thumbnail sprites",
  domain: "e-hentai.org",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    {
      name: "input",
      type: "str",
      required: true,
      positional: true,
      description: "Gallery URL or gid/token pair",
    },
    { name: "limit", type: "int", default: 40 },
  ],
  columns: [
    "page",
    "gid",
    "title",
    "filename",
    "page_url",
    "thumb_sprite_url",
    "gallery_url",
  ],
  func: async (_page, kwargs) => {
    const gallery = parseEhentaiGallery(kwargs.input);
    const limit = requireEhentaiLimit(kwargs.limit, 40);
    const rows = parseEhentaiGalleryPages(
      await fetchText(gallery.url),
      gallery,
      limit,
    );
    if (rows.length === 0) throw new Error("No E-Hentai gallery pages found.");
    return rows;
  },
});
