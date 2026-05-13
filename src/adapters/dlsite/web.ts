/**
 * @owner   src/adapters/dlsite/web.ts
 * @does    Register DLsite public search and work detail commands for doujin games, manga, CG, voice, and video.
 * @needs   DLsite public search/detail HTML structure and stable product_id URLs.
 * @feeds   ACG market research, tag/type search, time/hot/rating sorted discovery.
 * @breaks  DLsite search-result card markup drift can hide works.
 */

import { USER_AGENT } from "../../constants.js";
import { cli, Strategy } from "../../registry.js";

const DLSITE_ORIGIN = "https://www.dlsite.com";
const DLSITE_SERVICE = "maniax";

interface DlsiteSearchRow {
  rank: number;
  product_id: string;
  title: string;
  maker: string;
  maker_id: string;
  work_type: string;
  age: string;
  price_jpy: string;
  sales: string;
  rating: string;
  reviews: string;
  thumb: string;
  url: string;
}

function str(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

export function decodeDlsiteHtml(value: unknown): string {
  return str(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function requireLimit(value: unknown, fallback = 20): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new Error("DLsite limit must be an integer in [1, 100].");
  }
  return n;
}

function requireQuery(value: unknown): string {
  const query = str(value).trim();
  if (!query) throw new Error("DLsite query cannot be empty.");
  return query;
}

function normalizeProductId(value: unknown): string {
  const raw = str(value).trim().toUpperCase();
  const match = raw.match(/[A-Z]{2}\d+/);
  if (!match) throw new Error("DLsite product id must look like RJ005751.");
  return match[0];
}

function normalizeService(value: unknown): string {
  const service = str(value || DLSITE_SERVICE)
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(service)) {
    throw new Error("DLsite service must be a simple path segment.");
  }
  return service;
}

function normalizeMakerId(value: unknown): string {
  const raw = str(value).trim().toUpperCase();
  const match = raw.match(/[A-Z]{2}\d+/);
  if (!match) throw new Error("DLsite maker id must look like RG01012594.");
  return match[0];
}

function normalizeGenreId(value: unknown): string {
  const raw = str(value).trim();
  if (!/^\d{3}$/.test(raw)) {
    throw new Error("DLsite genre id must be a three-digit code like 001.");
  }
  return raw;
}

function normalizeSort(value: unknown): string {
  const key = str(value || "release")
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  const map: Record<string, string> = {
    release: "release",
    time: "release",
    newest: "release",
    hot: "dl_d",
    popular: "dl_d",
    sales: "dl_d",
    rating: "rate",
    rate: "rate",
    reviews: "review",
    review: "review",
    price: "price",
    title: "title_d",
  };
  const sort = map[key];
  if (!sort) {
    throw new Error(
      `Unsupported DLsite sort: ${value}. Supported: release, hot, rating, reviews, price, title.`,
    );
  }
  return sort;
}

function normalizeType(value: unknown): string {
  const key = str(value)
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  if (!key || key === "all") return "";
  const map: Record<string, string> = {
    manga: "MNG",
    comic: "MNG",
    cg: "ICG",
    illustration: "ICG",
    game: "ADV",
    adv: "ADV",
    novel: "DNV",
    digitalnovel: "DNV",
    voice: "SOU",
    audio: "SOU",
    video: "MOV",
    movie: "MOV",
  };
  const type = map[key];
  if (!type) {
    throw new Error(`Unsupported DLsite work type: ${value}.`);
  }
  return type;
}

export function dlsiteSearchUrl(kwargs: Record<string, unknown>): string {
  const query = encodeURIComponent(requireQuery(kwargs.query));
  const sort = normalizeSort(kwargs.sort);
  const page = Number(kwargs.page ?? 1);
  if (!Number.isInteger(page) || page < 1) {
    throw new Error("DLsite page must be a positive integer.");
  }
  const type = normalizeType(kwargs.type);
  const typePath = type ? `work_type/${type}/` : "";
  return `${DLSITE_ORIGIN}/${DLSITE_SERVICE}/fsr/=/${typePath}keyword/${query}/order/${sort}/page/${page}`;
}

function dlsiteListingUrl(
  path: string,
  kwargs: Record<string, unknown>,
): string {
  const sort = normalizeSort(kwargs.sort);
  const page = Number(kwargs.page ?? 1);
  if (!Number.isInteger(page) || page < 1) {
    throw new Error("DLsite page must be a positive integer.");
  }
  return `${DLSITE_ORIGIN}/${DLSITE_SERVICE}/fsr/=/${path}/order/${sort}/page/${page}`;
}

export function dlsiteMakerUrl(kwargs: Record<string, unknown>): string {
  const sort = normalizeSort(kwargs.sort);
  const page = Number(kwargs.page ?? 1);
  if (!Number.isInteger(page) || page < 1) {
    throw new Error("DLsite page must be a positive integer.");
  }
  return `${DLSITE_ORIGIN}/${DLSITE_SERVICE}/circle/profile/=/page/${page}/maker_id/${normalizeMakerId(kwargs.maker_id)}.html/order/${sort}`;
}

export function dlsiteCreatorUrl(kwargs: Record<string, unknown>): string {
  const creator = requireQuery(kwargs.creator);
  return dlsiteListingUrl(
    `keyword_creater/${encodeURIComponent(`"${creator}"`)}/ana_flg/all`,
    kwargs,
  );
}

export function dlsiteGenreUrl(kwargs: Record<string, unknown>): string {
  return dlsiteListingUrl(`genre/${normalizeGenreId(kwargs.genre)}`, kwargs);
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": USER_AGENT,
    },
  });
  if (!response.ok) {
    throw new Error(`DLsite request failed with HTTP ${response.status}.`);
  }
  return response.text();
}

function firstMatch(value: string, re: RegExp): string {
  const match = value.match(re);
  return match ? decodeDlsiteHtml(match[1]) : "";
}

function rawMatch(value: string, re: RegExp): string {
  const match = value.match(re);
  return match ? match[1].replace(/&amp;/g, "&") : "";
}

function normalizeUrl(value: string): string {
  if (!value) return "";
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("/")) return `${DLSITE_ORIGIN}${value}`;
  return value;
}

export function parseDlsiteSearchHtml(
  html: string,
  limit: number,
): DlsiteSearchRow[] {
  const rows: DlsiteSearchRow[] = [];
  const starts = [
    ...html.matchAll(
      /<([a-z][a-z0-9-]*)\b(?=[^>]*\bdata-list_item_product_id="([^"]+)")[^>]*>/gi,
    ),
  ];
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    const productId = decodeDlsiteHtml(start[2]);
    const begin = start.index ?? 0;
    const end = starts[i + 1]?.index ?? html.length;
    const chunk = html.slice(begin, end);
    const title = firstMatch(
      chunk,
      /<dd class="work_name"[\s\S]*?<a[^>]+title="([^"]+)"/,
    );
    if (!productId || !title) continue;
    const maker = firstMatch(
      chunk,
      /<dd class="maker_name"[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/,
    );
    const makerId = rawMatch(chunk, /maker_id\/([A-Z]{2}\d+)\.html/i);
    const workType = firstMatch(
      chunk,
      /<div class="work_category[^"]*"[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/,
    );
    const age = firstMatch(chunk, /<span class="icon_[^"]+" title="([^"]+)"/);
    const price = firstMatch(
      chunk,
      /<span class="work_price_base">([^<]+)<\/span>/,
    );
    const sales = firstMatch(
      chunk,
      /<dd class="work_dl">[\s\S]*?<span[^>]*>([^<]+)<\/span>/,
    );
    const rating = firstMatch(chunk, /<div class="star_rating\s+([^"\s]+)/);
    const reviews = firstMatch(
      chunk,
      /<div class="star_rating[^"]*"[^>]*>\(([^)]+)\)/,
    );
    const thumb = normalizeUrl(
      rawMatch(chunk, /thumb-candidates="\['([^']+)'/) ||
        rawMatch(chunk, /\bdata-src="([^"]+)"/),
    );
    const url = normalizeUrl(rawMatch(chunk, /\blink="([^"]+)"/));
    rows.push({
      rank: rows.length + 1,
      product_id: productId,
      title,
      maker,
      maker_id: makerId.toUpperCase(),
      work_type: workType,
      age,
      price_jpy: price,
      sales,
      rating,
      reviews,
      thumb,
      url:
        url ||
        `${DLSITE_ORIGIN}/${DLSITE_SERVICE}/work/=/product_id/${productId}.html`,
    });
    if (rows.length >= limit) break;
  }
  return rows;
}

function outlineValue(html: string, label: string): string {
  const re = new RegExp(`<th>${label}</th>\\s*<td>([\\s\\S]*?)</td>`, "i");
  return firstMatch(html, re);
}

export function parseDlsiteDetailHtml(
  html: string,
  productId: string,
  service = DLSITE_SERVICE,
): Record<string, unknown> {
  const event = rawMatch(
    html,
    new RegExp(`<div hidden class="ga4_event_item_${productId}"([^>]*)>`, "i"),
  );
  const eventField = (name: string) =>
    firstMatch(event, new RegExp(`data-${name}="([^"]*)"`));
  return {
    product_id: productId,
    title:
      firstMatch(html, /<h1[^>]+id="work_name"[^>]*>([\s\S]*?)<\/h1>/) ||
      firstMatch(html, /<meta property="og:title" content="([^"]+)"/),
    maker:
      firstMatch(html, /class="maker_name"[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/) ||
      eventField("maker_id"),
    maker_id: eventField("maker_id"),
    work_type: eventField("work_type") || outlineValue(html, "作品形式"),
    release_date: outlineValue(html, "販売日"),
    age: outlineValue(html, "年齢指定"),
    file_format: outlineValue(html, "ファイル形式"),
    pages: outlineValue(html, "ページ数"),
    file_size: outlineValue(html, "ファイル容量"),
    price_jpy: eventField("price"),
    image: normalizeUrl(
      rawMatch(html, /<meta property="og:image" content="([^"]+)"/),
    ),
    description: firstMatch(
      html,
      /<div itemprop="description" class="work_parts_container">([\s\S]*?)<\/div>\s*<\/div>/,
    ).slice(0, 1000),
    url: `${DLSITE_ORIGIN}/${service}/work/=/product_id/${productId}.html`,
  };
}

async function runSearch(kwargs: Record<string, unknown>) {
  const rows = parseDlsiteSearchHtml(
    await fetchText(dlsiteSearchUrl(kwargs)),
    requireLimit(kwargs.limit),
  );
  if (rows.length === 0) throw new Error("No DLsite works found.");
  return rows;
}

async function runListing(url: string, kwargs: Record<string, unknown>) {
  const rows = parseDlsiteSearchHtml(
    await fetchText(url),
    requireLimit(kwargs.limit),
  );
  if (rows.length === 0) throw new Error("No DLsite works found.");
  return rows;
}

const SEARCH_ARGS = [
  { name: "query", type: "str" as const, required: true, positional: true },
  { name: "limit", type: "int" as const, default: 20 },
  { name: "page", type: "int" as const, default: 1 },
  {
    name: "sort",
    type: "str" as const,
    default: "release",
    choices: ["release", "hot", "rating", "reviews", "price", "title"],
    description: "release, hot, rating, reviews, price, title",
  },
  {
    name: "type",
    type: "str" as const,
    choices: ["all", "manga", "cg", "game", "novel", "voice", "video"],
    description: "all, manga, cg, game, novel, voice, video",
  },
];

const SEARCH_COLUMNS = [
  "rank",
  "product_id",
  "title",
  "maker",
  "maker_id",
  "work_type",
  "age",
  "price_jpy",
  "sales",
  "rating",
  "reviews",
  "url",
];

cli({
  site: "dlsite",
  name: "search",
  description: "Search DLsite doujin works by keyword, type, and sort order",
  domain: "www.dlsite.com",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: SEARCH_ARGS,
  columns: SEARCH_COLUMNS,
  func: async (_page, kwargs) => runSearch(kwargs),
});

cli({
  site: "dlsite",
  name: "manga",
  description: "Search DLsite manga works",
  domain: "www.dlsite.com",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: SEARCH_ARGS.filter((arg) => arg.name !== "type"),
  columns: SEARCH_COLUMNS,
  func: async (_page, kwargs) => runSearch({ ...kwargs, type: "manga" }),
});

cli({
  site: "dlsite",
  name: "cg",
  description: "Search DLsite CG and illustration works",
  domain: "www.dlsite.com",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: SEARCH_ARGS.filter((arg) => arg.name !== "type"),
  columns: SEARCH_COLUMNS,
  func: async (_page, kwargs) => runSearch({ ...kwargs, type: "cg" }),
});

cli({
  site: "dlsite",
  name: "game",
  description: "Search DLsite game and ADV works",
  domain: "www.dlsite.com",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: SEARCH_ARGS.filter((arg) => arg.name !== "type"),
  columns: SEARCH_COLUMNS,
  func: async (_page, kwargs) => runSearch({ ...kwargs, type: "game" }),
});

cli({
  site: "dlsite",
  name: "maker",
  description:
    "Search DLsite works from a circle or maker id such as RG01012594 or VG02994",
  domain: "www.dlsite.com",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    {
      name: "maker_id",
      type: "str" as const,
      required: true,
      positional: true,
    },
    { name: "limit", type: "int" as const, default: 20 },
    { name: "page", type: "int" as const, default: 1 },
    {
      name: "sort",
      type: "str" as const,
      default: "release",
      choices: ["release", "hot", "rating", "reviews", "price", "title"],
      description: "release, hot, rating, reviews, price, title",
    },
  ],
  columns: SEARCH_COLUMNS,
  func: async (_page, kwargs) => runListing(dlsiteMakerUrl(kwargs), kwargs),
});

cli({
  site: "dlsite",
  name: "creator",
  description:
    "Search DLsite works by creator, author, illustrator, or voice actor name",
  domain: "www.dlsite.com",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: "creator", type: "str" as const, required: true, positional: true },
    { name: "limit", type: "int" as const, default: 20 },
    { name: "page", type: "int" as const, default: 1 },
    {
      name: "sort",
      type: "str" as const,
      default: "release",
      choices: ["release", "hot", "rating", "reviews", "price", "title"],
      description: "release, hot, rating, reviews, price, title",
    },
  ],
  columns: SEARCH_COLUMNS,
  func: async (_page, kwargs) => runListing(dlsiteCreatorUrl(kwargs), kwargs),
});

cli({
  site: "dlsite",
  name: "genre",
  description: "Search DLsite works by DLsite genre tag id",
  domain: "www.dlsite.com",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: "genre", type: "str" as const, required: true, positional: true },
    { name: "limit", type: "int" as const, default: 20 },
    { name: "page", type: "int" as const, default: 1 },
    {
      name: "sort",
      type: "str" as const,
      default: "release",
      choices: ["release", "hot", "rating", "reviews", "price", "title"],
      description: "release, hot, rating, reviews, price, title",
    },
  ],
  columns: SEARCH_COLUMNS,
  func: async (_page, kwargs) => runListing(dlsiteGenreUrl(kwargs), kwargs),
});

cli({
  site: "dlsite",
  name: "work",
  description: "Get DLsite public work detail by product id",
  domain: "www.dlsite.com",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: "id", type: "str", required: true, positional: true },
    {
      name: "service",
      type: "str",
      default: DLSITE_SERVICE,
      description: "DLsite service path, for example maniax or books",
    },
  ],
  columns: [
    "product_id",
    "title",
    "maker",
    "maker_id",
    "work_type",
    "release_date",
    "age",
    "file_format",
    "pages",
    "file_size",
    "price_jpy",
    "url",
  ],
  func: async (_page, kwargs) => {
    const productId = normalizeProductId(kwargs.id);
    const service = normalizeService(kwargs.service);
    return [
      parseDlsiteDetailHtml(
        await fetchText(
          `${DLSITE_ORIGIN}/${service}/work/=/product_id/${productId}.html`,
        ),
        productId,
        service,
      ),
    ];
  },
});
