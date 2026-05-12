/**
 * @owner   src/adapters/steam/app.ts
 * @does    Register agent-facing Steam app storefront detail command.
 * @needs   Steam appdetails API, strict app ids, storefront country code validation.
 * @feeds   surface coverage ledger, Steam app detail workflows, storefront metadata readers.
 * @breaks  Steam appdetails envelope drift or regional availability changes can hide app metadata.
 */

import { cli, Strategy } from "../../registry.js";

const STEAM_STORE = "https://store.steampowered.com";

interface SteamNamedEntry {
  description?: unknown;
  name?: unknown;
}

interface SteamAppData {
  steam_appid?: unknown;
  name?: unknown;
  type?: unknown;
  is_free?: unknown;
  release_date?: { date?: unknown };
  developers?: unknown;
  publishers?: unknown;
  price_overview?: {
    final?: unknown;
    currency?: unknown;
  };
  metacritic?: { score?: unknown };
  recommendations?: { total?: unknown };
  genres?: unknown;
  categories?: unknown;
  short_description?: unknown;
  website?: unknown;
}

interface SteamAppWrapper {
  success?: unknown;
  data?: SteamAppData;
}

type SteamAppEnvelope = Record<string, SteamAppWrapper | undefined>;

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
};

function stringField(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function numberOrNull(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function decodeSteamHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/g, (match) => {
      return HTML_ENTITIES[match] ?? match;
    });
}

export function requireSteamAppId(value: unknown): string {
  const id = String(value ?? "").trim();
  if (!/^\d+$/.test(id)) {
    throw new Error("steam app id must be a positive integer.");
  }
  return id;
}

export function requireSteamCountryCode(
  value: unknown,
  fallback = "us",
): string {
  const raw =
    value === undefined || value === null || value === "" ? fallback : value;
  const code = String(raw).trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(code)) {
    throw new Error(
      "steam currency must be a two-letter storefront country code.",
    );
  }
  return code;
}

export function steamPriceCents(value: unknown): number | null {
  const cents = numberOrNull(value);
  return cents === null ? null : Number((cents / 100).toFixed(2));
}

function joinSteamNames(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((entry: SteamNamedEntry | string) => {
      if (typeof entry === "string") return entry;
      return stringField(entry.description || entry.name);
    })
    .filter(Boolean)
    .join(", ");
}

export function mapSteamAppRow(
  appId: string,
  data: SteamAppData,
): Record<string, unknown> {
  const id = stringField(data.steam_appid || appId);
  const isFree = data.is_free === true;
  return {
    id,
    name: decodeSteamHtml(data.name),
    type: stringField(data.type),
    isFree,
    releaseDate: stringField(data.release_date?.date),
    developers: Array.isArray(data.developers)
      ? data.developers.join(", ")
      : "",
    publishers: Array.isArray(data.publishers)
      ? data.publishers.join(", ")
      : "",
    price: isFree ? 0 : steamPriceCents(data.price_overview?.final),
    currency: stringField(data.price_overview?.currency).toUpperCase(),
    metacritic: numberOrNull(data.metacritic?.score),
    recommendations: numberOrNull(data.recommendations?.total),
    genres: joinSteamNames(data.genres),
    categories: joinSteamNames(data.categories),
    shortDescription: decodeSteamHtml(data.short_description),
    website: stringField(data.website),
    url: `${STEAM_STORE}/app/${id}/`,
  };
}

async function fetchSteamApp(
  appId: string,
  countryCode: string,
): Promise<SteamAppData> {
  const url = new URL(`${STEAM_STORE}/api/appdetails`);
  url.searchParams.set("appids", appId);
  url.searchParams.set("l", "en");
  url.searchParams.set("cc", countryCode);
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "unicli-steam/1.0 (https://github.com/olo-dot-io/Uni-CLI)",
    },
  });
  if (!response.ok)
    throw new Error(`Steam app returned HTTP ${response.status}.`);
  const envelope = (await response.json()) as SteamAppEnvelope;
  const wrapper = envelope[appId];
  if (!wrapper || wrapper.success !== true || !wrapper.data) {
    throw new Error(`Steam app id ${appId} returned no data.`);
  }
  return wrapper.data;
}

cli({
  site: "steam",
  name: "app",
  description: "Steam storefront detail for a single app id",
  domain: "store.steampowered.com",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    {
      name: "id",
      type: "str",
      required: true,
      positional: true,
      description: "Numeric Steam app id",
    },
    {
      name: "currency",
      type: "str",
      default: "us",
      description: "Storefront country code",
    },
  ],
  columns: [
    "id",
    "name",
    "type",
    "isFree",
    "releaseDate",
    "developers",
    "publishers",
    "price",
    "currency",
    "metacritic",
    "recommendations",
    "genres",
    "categories",
    "shortDescription",
    "website",
    "url",
  ],
  func: async (_page, kwargs) => {
    const id = requireSteamAppId(kwargs.id);
    const countryCode = requireSteamCountryCode(kwargs.currency);
    return [mapSteamAppRow(id, await fetchSteamApp(id, countryCode))];
  },
});
