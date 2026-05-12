/**
 * @owner   src/adapters/defillama/protocols.ts
 * @does    Register agent-facing DefiLlama protocol list and detail commands.
 * @needs   DefiLlama public API, bounded result limits, validated protocol slugs.
 * @feeds   surface coverage ledger, DeFi protocol TVL rows, protocol metadata detail.
 * @breaks  DefiLlama API drift, weak slug validation, or silent empty rows hide DeFi data failures.
 */

import { cli, Strategy } from "../../registry.js";

const API_BASE = "https://api.llama.fi";
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;

export function requireDefillamaLimit(value: unknown): number {
  const raw =
    value === undefined || value === null || value === "" ? 30 : value;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("defillama limit must be an integer in [1, 500].");
  }
  return limit;
}

export function requireDefillamaSlug(value: unknown): string {
  const slug = String(value ?? "").trim();
  if (!slug) throw new Error("defillama slug cannot be empty.");
  if (!SLUG_RE.test(slug)) {
    throw new Error(`defillama slug "${String(value)}" is not valid.`);
  }
  return slug;
}

export function unixToDate(value: unknown): string | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n > 1e12 ? n : n * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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

function joinStrings(value: unknown): string {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim()).join(", ")
    : "";
}

function objectField(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export function mapDefillamaProtocolRows(
  rows: Array<Record<string, unknown>>,
  limit: number,
): Array<Record<string, unknown>> {
  return rows
    .filter((row) => (row.slug || row.name) && numberField(row.tvl) != null)
    .sort((a, b) => (numberField(b.tvl) ?? 0) - (numberField(a.tvl) ?? 0))
    .slice(0, limit)
    .map((row, index) => {
      const slug = stringField(row.slug);
      return {
        rank: index + 1,
        slug,
        name: stringField(row.name),
        category: stringField(row.category),
        tvl: numberField(row.tvl),
        mcap: numberField(row.mcap),
        change_1d: numberField(row.change_1d),
        change_7d: numberField(row.change_7d),
        chains: joinStrings(row.chains),
        listedAt: unixToDate(row.listedAt),
        url: slug ? `https://defillama.com/protocol/${slug}` : "",
      };
    });
}

export function mapDefillamaDetailRow(
  slug: string,
  detail: Record<string, unknown>,
  protocols: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const tvlSeries = Array.isArray(detail.tvl)
    ? (detail.tvl as Array<Record<string, unknown>>)
    : [];
  const lastPoint = tvlSeries[tvlSeries.length - 1] ?? {};
  const isParent = detail.isParentProtocol === true;
  const chains = new Set(
    Array.isArray(detail.chains) ? (detail.chains as Array<string>) : [],
  );
  let category = "";
  if (isParent) {
    for (const protocol of protocols) {
      if (
        protocol.parentProtocol === detail.id &&
        Array.isArray(protocol.chains)
      ) {
        for (const chain of protocol.chains) {
          if (typeof chain === "string") chains.add(chain);
        }
      }
    }
  } else {
    const match = protocols.find((protocol) => protocol.slug === slug);
    category = stringField(match?.category);
    if (Array.isArray(match?.chains)) {
      for (const chain of match.chains) {
        if (typeof chain === "string") chains.add(chain);
      }
    }
  }
  return {
    slug,
    name: stringField(detail.name),
    category,
    isParent,
    tvl: numberField(lastPoint.totalLiquidityUSD),
    tvlAt: unixToDate(lastPoint.date),
    mcap: numberField(detail.mcap),
    chains: [...chains].join(", "),
    twitter: stringField(detail.twitter),
    github: joinStrings(detail.github),
    audits: stringField(detail.audits),
    listedAt: unixToDate(detail.listedAt),
    description: stringField(detail.description),
    website: stringField(detail.url),
    url: `https://defillama.com/protocol/${slug}`,
  };
}

async function fetchJson(url: URL | string, label: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "unicli-defillama (https://github.com/olo-dot-io/Uni-CLI)",
    },
  });
  if (response.status === 404) throw new Error(`${label} returned no result.`);
  if (response.status === 400) throw new Error(`${label} returned HTTP 400.`);
  if (response.status === 429) throw new Error(`${label} returned HTTP 429.`);
  if (!response.ok)
    throw new Error(`${label} returned HTTP ${response.status}.`);
  return response.json();
}

cli({
  site: "defillama",
  name: "protocols",
  description: "Top DeFi protocols by current TVL",
  domain: "defillama.com",
  strategy: Strategy.PUBLIC,
  args: [{ name: "limit", type: "int", default: 30, description: "Max rows" }],
  columns: [
    "rank",
    "slug",
    "name",
    "category",
    "tvl",
    "mcap",
    "change_1d",
    "change_7d",
    "chains",
    "listedAt",
    "url",
  ],
  func: async (_page, kwargs) => {
    const limit = requireDefillamaLimit(kwargs.limit);
    const body = await fetchJson(
      `${API_BASE}/protocols`,
      "defillama protocols",
    );
    const rows = mapDefillamaProtocolRows(
      Array.isArray(body) ? (body as Array<Record<string, unknown>>) : [],
      limit,
    );
    if (rows.length === 0)
      throw new Error("defillama protocols returned no rows.");
    return rows;
  },
});

cli({
  site: "defillama",
  name: "protocol",
  description: "Fetch DefiLlama protocol detail by slug",
  domain: "defillama.com",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "slug",
      type: "str",
      required: true,
      positional: true,
      description: "Protocol slug",
    },
  ],
  columns: [
    "slug",
    "name",
    "category",
    "isParent",
    "tvl",
    "tvlAt",
    "mcap",
    "chains",
    "twitter",
    "github",
    "audits",
    "listedAt",
    "description",
    "website",
    "url",
  ],
  func: async (_page, kwargs) => {
    const slug = requireDefillamaSlug(kwargs.slug);
    const detail = objectField(
      await fetchJson(
        `${API_BASE}/protocol/${encodeURIComponent(slug)}`,
        "defillama protocol",
      ),
    );
    if (!detail.name)
      throw new Error(`defillama protocol returned no row for "${slug}".`);
    const protocols = await fetchJson(
      `${API_BASE}/protocols`,
      "defillama protocol list",
    );
    return [
      mapDefillamaDetailRow(
        slug,
        detail,
        Array.isArray(protocols)
          ? (protocols as Array<Record<string, unknown>>)
          : [],
      ),
    ];
  },
});
