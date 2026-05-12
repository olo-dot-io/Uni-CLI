/**
 * @owner   src/adapters/coingecko/markets.ts
 * @does    Register agent-facing CoinGecko market, coin, exchange, derivative, category, and global commands.
 * @needs   Public CoinGecko API, TypeScript adapter loader, bounded market argument parsing.
 * @feeds   surface coverage ledger, crypto market command surface, agent-readable market rows.
 * @breaks  CoinGecko API drift, weak slug validation, or silent empty rows hide market data failures.
 */

import { cli, Strategy } from "../../registry.js";

const API_BASE = "https://api.coingecko.com/api/v3";
const CATEGORY_SORTS = new Set([
  "market_cap_desc",
  "market_cap_asc",
  "name_desc",
  "name_asc",
  "market_cap_change_24h_desc",
  "market_cap_change_24h_asc",
]);

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberField(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  return Number.isFinite(n) ? n : null;
}

function slug(value: unknown, label: string): string {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!text) throw new Error(`coingecko ${label} cannot be empty.`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(text)) {
    throw new Error(`coingecko ${label} must be a lowercase slug.`);
  }
  return text;
}

export function requireCoinGeckoCurrency(value: unknown): string {
  const currency = String(value ?? "usd")
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9-]{2,20}$/.test(currency)) {
    throw new Error(`coingecko currency must look like a currency slug.`);
  }
  return currency;
}

export function requireCoinGeckoLimit(
  value: unknown,
  fallback: number,
  max: number,
  label = "limit",
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new Error(
      `coingecko ${label} must be an integer in [1, ${max}]. Got: ${String(value)}`,
    );
  }
  return n;
}

function isoDate(value: unknown): string {
  return value ? String(value).slice(0, 10) : "";
}

function pickCurrency(map: unknown, currency: string): unknown {
  return map && typeof map === "object"
    ? (map as Record<string, unknown>)[currency]
    : null;
}

export function mapCoinRow(
  data: Record<string, unknown>,
  currency: string,
): Record<string, unknown> {
  const market = (data.market_data ?? {}) as Record<string, unknown>;
  const price = pickCurrency(market.current_price, currency);
  const marketCap = pickCurrency(market.market_cap, currency);
  const volume24h = pickCurrency(market.total_volume, currency);
  if (price == null && marketCap == null && volume24h == null) {
    throw new Error(
      `coingecko returned no market data for currency "${currency}".`,
    );
  }
  const homepage = Array.isArray(
    (data.links as { homepage?: unknown[] } | undefined)?.homepage,
  )
    ? ((data.links as { homepage?: unknown[] }).homepage ?? []).find(Boolean)
    : "";
  return {
    id: stringField(data.id),
    symbol: stringField(data.symbol).toUpperCase(),
    name: stringField(data.name),
    rank: numberField(data.market_cap_rank),
    price,
    marketCap,
    volume24h,
    change24hPct: numberField(market.price_change_percentage_24h),
    change7dPct: numberField(market.price_change_percentage_7d),
    change30dPct: numberField(market.price_change_percentage_30d),
    ath: pickCurrency(market.ath, currency),
    athDate: isoDate(pickCurrency(market.ath_date, currency)),
    atl: pickCurrency(market.atl, currency),
    atlDate: isoDate(pickCurrency(market.atl_date, currency)),
    circulatingSupply: numberField(market.circulating_supply),
    totalSupply: numberField(market.total_supply),
    maxSupply: numberField(market.max_supply),
    genesisDate: stringField(data.genesis_date),
    homepage: homepage ? String(homepage) : "",
  };
}

export function mapTopRows(
  rows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return rows.map((coin) => ({
    rank: numberField(coin.market_cap_rank),
    symbol: stringField(coin.symbol).toUpperCase(),
    name: stringField(coin.name),
    price: numberField(coin.current_price),
    change24hPct: numberField(coin.price_change_percentage_24h),
    marketCap: numberField(coin.market_cap),
    volume24h: numberField(coin.total_volume),
    high24h: numberField(coin.high_24h),
    low24h: numberField(coin.low_24h),
  }));
}

export function mapTrendingRows(
  coins: Array<{ item?: Record<string, unknown> }>,
): Array<Record<string, unknown>> {
  return coins.map((entry, index) => {
    const coin = entry.item ?? {};
    return {
      rank: index + 1,
      id: stringField(coin.id),
      symbol: stringField(coin.symbol).toUpperCase(),
      name: stringField(coin.name),
      marketCapRank: numberField(coin.market_cap_rank),
      priceBtc: numberField(coin.price_btc),
      thumb:
        stringField(coin.thumb) ||
        stringField(coin.small) ||
        stringField(coin.large),
    };
  });
}

export function mapCategoryRows(
  rows: Array<Record<string, unknown>>,
  limit: number,
): Array<Record<string, unknown>> {
  return rows.slice(0, limit).map((category, index) => ({
    rank: index + 1,
    id: stringField(category.id),
    name: stringField(category.name),
    marketCap: numberField(category.market_cap),
    volume24h: numberField(category.volume_24h),
    marketCapChange24hPct: numberField(category.market_cap_change_24h),
    top3Coins: Array.isArray(category.top_3_coins_id)
      ? category.top_3_coins_id.join(", ")
      : "",
  }));
}

export function mapExchangeRows(
  rows: Array<Record<string, unknown>>,
  page: number,
  limit: number,
): Array<Record<string, unknown>> {
  return rows.map((exchange, index) => ({
    rank: (page - 1) * limit + index + 1,
    id: stringField(exchange.id),
    name: stringField(exchange.name),
    trustScore: numberField(exchange.trust_score),
    volume24hBtc: numberField(exchange.trade_volume_24h_btc),
    country: stringField(exchange.country),
    yearEstablished: numberField(exchange.year_established),
    url: stringField(exchange.url),
  }));
}

export function mapDerivativeRows(
  rows: Array<Record<string, unknown>>,
  limit: number,
  symbolFilter = "",
): Array<Record<string, unknown>> {
  const filter = symbolFilter.trim().toUpperCase();
  const filtered = filter
    ? rows.filter(
        (row) =>
          stringField(row.symbol).toUpperCase().includes(filter) ||
          stringField(row.index_id).toUpperCase().includes(filter),
      )
    : rows;
  if (filtered.length === 0) {
    throw new Error(`No derivative tickers matched symbol="${filter}".`);
  }
  return filtered.slice(0, limit).map((row, index) => ({
    rank: index + 1,
    market: stringField(row.market),
    symbol: stringField(row.symbol),
    indexId: stringField(row.index_id),
    contractType: stringField(row.contract_type),
    price: numberField(row.price),
    change24hPct: numberField(row.price_percentage_change_24h),
    fundingRate: numberField(row.funding_rate),
    openInterestUsd: numberField(row.open_interest),
    volume24hUsd: numberField(row.volume_24h),
    expired: row.expired_at ? String(row.expired_at) : "",
  }));
}

export function mapGlobalRow(
  body: Record<string, unknown>,
  currency: string,
): Record<string, unknown> {
  const data = (body.data ?? {}) as Record<string, unknown>;
  const totalMarketCap = pickCurrency(data.total_market_cap, currency);
  const totalVolume = pickCurrency(data.total_volume, currency);
  if (totalMarketCap == null && totalVolume == null) {
    throw new Error(
      `coingecko has no market totals for currency "${currency}".`,
    );
  }
  const dominance = (data.market_cap_percentage ?? {}) as Record<
    string,
    unknown
  >;
  return {
    currency: currency.toUpperCase(),
    totalMarketCap: numberField(totalMarketCap),
    totalVolume24h: numberField(totalVolume),
    marketCapChange24hPct: numberField(
      data.market_cap_change_percentage_24h_usd,
    ),
    btcDominancePct: numberField(dominance.btc),
    ethDominancePct: numberField(dominance.eth),
    activeCryptocurrencies: numberField(data.active_cryptocurrencies),
    markets: numberField(data.markets),
    ongoingIcos: numberField(data.ongoing_icos),
    updatedAt: data.updated_at
      ? new Date(Number(data.updated_at) * 1000).toISOString()
      : "",
  };
}

async function fetchJson(url: URL | string, label: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { "User-Agent": "unicli (https://github.com/olo-dot-io/Uni-CLI)" },
  });
  if (response.status === 404) throw new Error(`${label} returned no result.`);
  if (response.status === 429) throw new Error(`${label} returned HTTP 429.`);
  if (!response.ok)
    throw new Error(`${label} returned HTTP ${response.status}.`);
  return response.json();
}

cli({
  site: "coingecko",
  name: "coin",
  description: "Fetch a single cryptocurrency's market data by CoinGecko id",
  domain: "api.coingecko.com",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "id",
      type: "str",
      required: true,
      positional: true,
      description: "CoinGecko coin id",
    },
    {
      name: "currency",
      type: "str",
      default: "usd",
      description: "Quote currency",
    },
  ],
  columns: [
    "id",
    "symbol",
    "name",
    "rank",
    "price",
    "marketCap",
    "volume24h",
    "change24hPct",
    "change7dPct",
    "change30dPct",
    "ath",
    "athDate",
    "atl",
    "atlDate",
    "circulatingSupply",
    "totalSupply",
    "maxSupply",
    "genesisDate",
    "homepage",
  ],
  func: async (_page, kwargs) => {
    const id = slug(kwargs.id, "coin id");
    const currency = requireCoinGeckoCurrency(kwargs.currency);
    const url = new URL(`${API_BASE}/coins/${id}`);
    url.searchParams.set("localization", "false");
    url.searchParams.set("tickers", "false");
    url.searchParams.set("market_data", "true");
    url.searchParams.set("community_data", "false");
    url.searchParams.set("developer_data", "false");
    url.searchParams.set("sparkline", "false");
    return [
      mapCoinRow(
        (await fetchJson(url, "coingecko coin")) as Record<string, unknown>,
        currency,
      ),
    ];
  },
});

cli({
  site: "coingecko",
  name: "top",
  description: "Top coins by market cap",
  domain: "api.coingecko.com",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "currency",
      type: "str",
      default: "usd",
      description: "Quote currency",
    },
    { name: "limit", type: "int", default: 10, description: "Number of coins" },
  ],
  columns: [
    "rank",
    "symbol",
    "name",
    "price",
    "change24hPct",
    "marketCap",
    "volume24h",
    "high24h",
    "low24h",
  ],
  func: async (_page, kwargs) => {
    const currency = requireCoinGeckoCurrency(kwargs.currency);
    const limit = requireCoinGeckoLimit(kwargs.limit, 10, 250);
    const url = new URL(`${API_BASE}/coins/markets`);
    url.searchParams.set("vs_currency", currency);
    url.searchParams.set("order", "market_cap_desc");
    url.searchParams.set("per_page", String(limit));
    url.searchParams.set("page", "1");
    url.searchParams.set("sparkline", "false");
    const rows = mapTopRows(
      (await fetchJson(url, "coingecko top")) as Array<Record<string, unknown>>,
    );
    if (rows.length === 0)
      throw new Error("coingecko returned no market data.");
    return rows;
  },
});

cli({
  site: "coingecko",
  name: "trending",
  description: "Top trending cryptocurrencies on CoinGecko",
  domain: "api.coingecko.com",
  strategy: Strategy.PUBLIC,
  args: [],
  columns: [
    "rank",
    "id",
    "symbol",
    "name",
    "marketCapRank",
    "priceBtc",
    "thumb",
  ],
  func: async () => {
    const body = (await fetchJson(
      `${API_BASE}/search/trending`,
      "coingecko trending",
    )) as {
      coins?: Array<{ item?: Record<string, unknown> }>;
    };
    const rows = mapTrendingRows(Array.isArray(body.coins) ? body.coins : []);
    if (rows.length === 0)
      throw new Error("coingecko returned no trending coins.");
    return rows;
  },
});

cli({
  site: "coingecko",
  name: "categories",
  description: "Crypto categories ranked by aggregated market cap",
  domain: "api.coingecko.com",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "sort",
      type: "str",
      default: "market_cap_desc",
      description: "Sort order",
    },
    {
      name: "limit",
      type: "int",
      default: 20,
      description: "Number of categories",
    },
  ],
  columns: [
    "rank",
    "id",
    "name",
    "marketCap",
    "volume24h",
    "marketCapChange24hPct",
    "top3Coins",
  ],
  func: async (_page, kwargs) => {
    const sort = String(kwargs.sort ?? "market_cap_desc")
      .trim()
      .toLowerCase();
    if (!CATEGORY_SORTS.has(sort))
      throw new Error(
        `coingecko sort "${String(kwargs.sort)}" is not supported.`,
      );
    const limit = requireCoinGeckoLimit(kwargs.limit, 20, 100);
    const rows = mapCategoryRows(
      (await fetchJson(
        `${API_BASE}/coins/categories?order=${encodeURIComponent(sort)}`,
        "coingecko categories",
      )) as Array<Record<string, unknown>>,
      limit,
    );
    if (rows.length === 0)
      throw new Error("CoinGecko returned no category data.");
    return rows;
  },
});

cli({
  site: "coingecko",
  name: "exchanges",
  description: "Top crypto exchanges by 24h BTC trading volume",
  domain: "api.coingecko.com",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "limit",
      type: "int",
      default: 20,
      description: "Number of exchanges",
    },
    { name: "page", type: "int", default: 1, description: "Page number" },
  ],
  columns: [
    "rank",
    "id",
    "name",
    "trustScore",
    "volume24hBtc",
    "country",
    "yearEstablished",
    "url",
  ],
  func: async (_page, kwargs) => {
    const limit = requireCoinGeckoLimit(kwargs.limit, 20, 250);
    const page = requireCoinGeckoLimit(kwargs.page, 1, 10_000, "page");
    const url = new URL(`${API_BASE}/exchanges`);
    url.searchParams.set("per_page", String(limit));
    url.searchParams.set("page", String(page));
    const rows = mapExchangeRows(
      (await fetchJson(url, "coingecko exchanges")) as Array<
        Record<string, unknown>
      >,
      page,
      limit,
    );
    if (rows.length === 0)
      throw new Error("CoinGecko returned no exchange data.");
    return rows;
  },
});

cli({
  site: "coingecko",
  name: "derivatives",
  description: "Top crypto derivative markets by 24h volume",
  domain: "api.coingecko.com",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "limit", type: "int", default: 20, description: "Max rows" },
    {
      name: "symbol",
      type: "str",
      description: "Optional symbol substring filter",
    },
  ],
  columns: [
    "rank",
    "market",
    "symbol",
    "indexId",
    "contractType",
    "price",
    "change24hPct",
    "fundingRate",
    "openInterestUsd",
    "volume24hUsd",
    "expired",
  ],
  func: async (_page, kwargs) => {
    const limit = requireCoinGeckoLimit(kwargs.limit, 20, 500);
    return mapDerivativeRows(
      (await fetchJson(
        `${API_BASE}/derivatives`,
        "coingecko derivatives",
      )) as Array<Record<string, unknown>>,
      limit,
      String(kwargs.symbol ?? ""),
    );
  },
});

cli({
  site: "coingecko",
  name: "global",
  description: "Aggregate crypto market stats",
  domain: "api.coingecko.com",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "currency",
      type: "str",
      default: "usd",
      description: "Quote currency",
    },
  ],
  columns: [
    "currency",
    "totalMarketCap",
    "totalVolume24h",
    "marketCapChange24hPct",
    "btcDominancePct",
    "ethDominancePct",
    "activeCryptocurrencies",
    "markets",
    "ongoingIcos",
    "updatedAt",
  ],
  func: async (_page, kwargs) => [
    mapGlobalRow(
      (await fetchJson(`${API_BASE}/global`, "coingecko global")) as Record<
        string,
        unknown
      >,
      requireCoinGeckoCurrency(kwargs.currency),
    ),
  ],
});
