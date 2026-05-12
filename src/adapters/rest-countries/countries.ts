/**
 * @owner   src/adapters/rest-countries/countries.ts
 * @does    Register agent-facing REST Countries country and region commands.
 * @needs   REST Countries v3.1 public API, bounded row limits, validated region names.
 * @feeds   surface coverage ledger, country metadata rows, public reference data search.
 * @breaks  REST Countries API drift, unbounded queries, or silent empty rows hide lookup failures.
 */

import { cli, Strategy } from "../../registry.js";

const API_BASE = "https://restcountries.com/v3.1";
const COUNTRY_FIELDS = [
  "name",
  "cca2",
  "cca3",
  "ccn3",
  "capital",
  "region",
  "subregion",
  "population",
  "area",
  "languages",
  "currencies",
  "flag",
  "latlng",
  "timezones",
  "independent",
  "unMember",
  "landlocked",
].join(",");
const REGIONS = new Set([
  "africa",
  "americas",
  "asia",
  "europe",
  "oceania",
  "antarctic",
]);
const COLUMNS = [
  "rank",
  "commonName",
  "officialName",
  "cca2",
  "cca3",
  "ccn3",
  "capital",
  "region",
  "subregion",
  "population",
  "area",
  "languages",
  "currencies",
  "latitude",
  "longitude",
  "timezones",
  "independent",
  "unMember",
  "landlocked",
  "flag",
  "url",
];

function nonEmptyString(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`rest-countries ${label} cannot be empty.`);
  return text;
}

export function requireRestCountriesLimit(
  value: unknown,
  fallback: number,
  max: number,
  label = "limit",
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new Error(
      `rest-countries ${label} must be an integer in [1, ${max}]. Got: ${String(value)}`,
    );
  }
  return n;
}

export function requireRestCountriesRegion(value: unknown): string {
  const region = nonEmptyString(value, "region").toLowerCase();
  if (!REGIONS.has(region)) {
    throw new Error(
      `rest-countries region "${String(value)}" is not supported. Allowed: ${[...REGIONS].join(", ")}.`,
    );
  }
  return region;
}

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

function booleanField(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function joinStringArray(value: unknown): string {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim()).join(", ")
    : "";
}

export function joinCountryCurrencies(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  return Object.entries(value as Record<string, { name?: unknown }>)
    .map(([code, info]) => {
      const name =
        info && typeof info.name === "string" && info.name.trim()
          ? info.name.trim()
          : "";
      return name ? `${code} (${name})` : code;
    })
    .join(", ");
}

export function joinCountryLanguages(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  return Object.values(value as Record<string, unknown>)
    .filter(
      (item): item is string =>
        typeof item === "string" && item.trim().length > 0,
    )
    .join(", ");
}

export function mapCountryRow(
  country: Record<string, unknown>,
): Record<string, unknown> {
  const name = (country.name ?? {}) as Record<string, unknown>;
  const latlng = Array.isArray(country.latlng) ? country.latlng : [];
  const cca3 = stringField(country.cca3);
  return {
    commonName: stringField(name.common),
    officialName: stringField(name.official),
    cca2: stringField(country.cca2),
    cca3,
    ccn3: stringField(country.ccn3),
    capital: joinStringArray(country.capital),
    region: stringField(country.region),
    subregion: stringField(country.subregion),
    population: numberField(country.population),
    area: numberField(country.area),
    languages: joinCountryLanguages(country.languages),
    currencies: joinCountryCurrencies(country.currencies),
    latitude: numberField(latlng[0]),
    longitude: numberField(latlng[1]),
    timezones: joinStringArray(country.timezones),
    independent: booleanField(country.independent),
    unMember: booleanField(country.unMember),
    landlocked: booleanField(country.landlocked),
    flag: stringField(country.flag),
    url: cca3
      ? `https://restcountries.com/v3.1/alpha/${cca3.toLowerCase()}`
      : "",
  };
}

export function mapCountryRows(
  rows: Array<Record<string, unknown>>,
  limit: number,
): Array<Record<string, unknown>> {
  const sorted = [...rows].sort(
    (a, b) =>
      (numberField(b.population) ?? 0) - (numberField(a.population) ?? 0),
  );
  return sorted.slice(0, limit).map((country, index) => ({
    rank: index + 1,
    ...mapCountryRow(country),
  }));
}

async function fetchJson(url: URL | string, label: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent":
        "unicli-rest-countries (https://github.com/olo-dot-io/Uni-CLI)",
    },
  });
  if (response.status === 404) throw new Error(`${label} returned no result.`);
  if (response.status === 429) throw new Error(`${label} returned HTTP 429.`);
  if (!response.ok)
    throw new Error(`${label} returned HTTP ${response.status}.`);
  return response.json();
}

cli({
  site: "rest-countries",
  name: "country",
  description: "Look up countries by common or official name",
  domain: "restcountries.com",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "name",
      type: "str",
      required: true,
      positional: true,
      description: "Country name",
    },
    { name: "limit", type: "int", default: 25, description: "Max rows" },
  ],
  columns: COLUMNS,
  func: async (_page, kwargs) => {
    const name = nonEmptyString(kwargs.name, "name");
    const limit = requireRestCountriesLimit(kwargs.limit, 25, 250);
    const url = new URL(`${API_BASE}/name/${encodeURIComponent(name)}`);
    url.searchParams.set("fields", COUNTRY_FIELDS);
    const body = await fetchJson(url, "rest-countries country");
    const rows = mapCountryRows(
      Array.isArray(body) ? (body as Array<Record<string, unknown>>) : [],
      limit,
    );
    if (rows.length === 0) {
      throw new Error(`rest-countries country returned no rows for "${name}".`);
    }
    return rows;
  },
});

cli({
  site: "rest-countries",
  name: "region",
  description: "List countries in a REST Countries region",
  domain: "restcountries.com",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "region",
      type: "str",
      required: true,
      positional: true,
      description: "Region name",
    },
    { name: "limit", type: "int", default: 250, description: "Max rows" },
  ],
  columns: COLUMNS,
  func: async (_page, kwargs) => {
    const region = requireRestCountriesRegion(kwargs.region);
    const limit = requireRestCountriesLimit(kwargs.limit, 250, 250);
    const url = new URL(`${API_BASE}/region/${encodeURIComponent(region)}`);
    url.searchParams.set("fields", COUNTRY_FIELDS);
    const body = await fetchJson(url, "rest-countries region");
    const rows = mapCountryRows(
      Array.isArray(body) ? (body as Array<Record<string, unknown>>) : [],
      limit,
    );
    if (rows.length === 0) {
      throw new Error(
        `rest-countries region returned no rows for "${region}".`,
      );
    }
    return rows;
  },
});
