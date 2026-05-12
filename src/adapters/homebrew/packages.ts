/**
 * @owner   src/adapters/homebrew/packages.ts
 * @does    Register agent-facing Homebrew formula, cask, and popularity commands.
 * @needs   formulae.brew.sh public JSON APIs and bounded argument parsing.
 * @feeds   surface coverage ledger, package registry command surface, Homebrew package inspection.
 * @breaks  Homebrew API drift, weak token validation, or silent analytics empties hide package lookup failures.
 */

import { cli, Strategy } from "../../registry.js";

const BREW_BASE = "https://formulae.brew.sh/api";
const POPULAR_TYPES = ["formula", "cask"] as const;
const POPULAR_WINDOWS = ["30d", "90d", "365d"] as const;

type PopularType = (typeof POPULAR_TYPES)[number];
type PopularWindow = (typeof POPULAR_WINDOWS)[number];

interface HomebrewFormulaBody {
  name?: unknown;
  tap?: unknown;
  versions?: { stable?: unknown };
  license?: unknown;
  desc?: unknown;
  homepage?: unknown;
  dependencies?: unknown;
  deprecated?: unknown;
  disabled?: unknown;
  urls?: { stable?: { url?: unknown } };
}

interface HomebrewCaskBody {
  token?: unknown;
  tap?: unknown;
  name?: unknown;
  version?: unknown;
  desc?: unknown;
  homepage?: unknown;
  deprecated?: unknown;
  disabled?: unknown;
  url?: unknown;
}

interface HomebrewAnalyticsBody {
  items?: Array<Record<string, unknown>>;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function boolField(value: unknown): boolean {
  return value === true;
}

function numberField(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const n = Number(value.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function requireHomebrewToken(value: unknown, label: string): string {
  const token = String(value ?? "").trim();
  if (!token) throw new Error(`homebrew ${label} is required.`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._@+-]*$/.test(token)) {
    throw new Error(`homebrew ${label} "${String(value)}" is not valid.`);
  }
  return token;
}

export function requireHomebrewLimit(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 500) {
    throw new Error(
      `limit must be an integer in [1, 500]. Got: ${String(value)}`,
    );
  }
  return n;
}

export function requirePopularType(value: unknown): PopularType {
  const type = String(value ?? "formula")
    .trim()
    .toLowerCase();
  if (type !== "formula" && type !== "cask") {
    throw new Error("type must be formula or cask.");
  }
  return type;
}

export function requirePopularWindow(value: unknown): PopularWindow {
  const window = String(value ?? "30d").trim();
  if (window !== "30d" && window !== "90d" && window !== "365d") {
    throw new Error("window must be 30d, 90d, or 365d.");
  }
  return window;
}

async function fetchHomebrewJson(url: string, label: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "unicli (https://github.com/olo-dot-io/Uni-CLI)",
      Accept: "application/json",
    },
  });
  if (response.status === 404) throw new Error(`${label} returned no result.`);
  if (!response.ok)
    throw new Error(`${label} returned HTTP ${response.status}.`);
  return response.json();
}

export function mapFormulaRow(
  body: HomebrewFormulaBody,
  requested: string,
): Record<string, unknown> {
  const formula = stringField(body.name) || requested;
  const dependencies = Array.isArray(body.dependencies)
    ? body.dependencies.map(stringField).filter(Boolean).join(", ")
    : "";
  if (!formula) throw new Error(`Homebrew returned no formula metadata.`);
  return {
    formula,
    tap: stringField(body.tap),
    version: stringField(body.versions?.stable),
    license: stringField(body.license),
    description: stringField(body.desc),
    homepage: stringField(body.homepage),
    dependencies,
    deprecated: boolField(body.deprecated),
    disabled: boolField(body.disabled),
    source: stringField(body.urls?.stable?.url),
    url: `https://formulae.brew.sh/formula/${encodeURIComponent(formula)}`,
  };
}

export function mapCaskRow(
  body: HomebrewCaskBody,
  requested: string,
): Record<string, unknown> {
  const cask = stringField(body.token) || requested;
  const name = Array.isArray(body.name)
    ? body.name.map(stringField).filter(Boolean).join(", ")
    : stringField(body.name);
  if (!cask) throw new Error(`Homebrew returned no cask metadata.`);
  return {
    cask,
    tap: stringField(body.tap),
    name,
    version: stringField(body.version),
    description: stringField(body.desc),
    homepage: stringField(body.homepage),
    deprecated: boolField(body.deprecated),
    disabled: boolField(body.disabled),
    download: stringField(body.url),
    url: `https://formulae.brew.sh/cask/${encodeURIComponent(cask)}`,
  };
}

export function mapPopularRows(
  body: HomebrewAnalyticsBody,
  type: PopularType,
  window: PopularWindow,
  limit: number,
): Array<Record<string, unknown>> {
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) {
    throw new Error(
      `Homebrew analytics returned no rows for ${type}/${window}.`,
    );
  }
  return items.slice(0, limit).map((row, index) => {
    const token = stringField(type === "cask" ? row.cask : row.formula);
    const detailPath = type === "cask" ? "cask" : "formula";
    return {
      rank: numberField(row.number) ?? index + 1,
      token,
      type,
      installs: numberField(row.count),
      percent: numberField(row.percent),
      window,
      url: token
        ? `https://formulae.brew.sh/${detailPath}/${encodeURIComponent(token)}`
        : "",
    };
  });
}

cli({
  site: "homebrew",
  name: "formula",
  description: "Fetch Homebrew formula metadata",
  domain: "formulae.brew.sh",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "name",
      type: "str",
      required: true,
      positional: true,
      description: "Formula name",
    },
  ],
  columns: [
    "formula",
    "tap",
    "version",
    "license",
    "description",
    "homepage",
    "dependencies",
    "deprecated",
    "disabled",
    "source",
    "url",
  ],
  func: async (_page, kwargs) => {
    const name = requireHomebrewToken(kwargs.name, "formula");
    const body = (await fetchHomebrewJson(
      `${BREW_BASE}/formula/${encodeURIComponent(name)}.json`,
      `homebrew formula ${name}`,
    )) as HomebrewFormulaBody;
    return [mapFormulaRow(body, name)];
  },
});

cli({
  site: "homebrew",
  name: "cask",
  description: "Fetch Homebrew cask metadata",
  domain: "formulae.brew.sh",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "token",
      type: "str",
      required: true,
      positional: true,
      description: "Cask token",
    },
  ],
  columns: [
    "cask",
    "tap",
    "name",
    "version",
    "description",
    "homepage",
    "deprecated",
    "disabled",
    "download",
    "url",
  ],
  func: async (_page, kwargs) => {
    const token = requireHomebrewToken(kwargs.token, "cask");
    const body = (await fetchHomebrewJson(
      `${BREW_BASE}/cask/${encodeURIComponent(token)}.json`,
      `homebrew cask ${token}`,
    )) as HomebrewCaskBody;
    return [mapCaskRow(body, token)];
  },
});

cli({
  site: "homebrew",
  name: "popular",
  description: "List most-installed Homebrew formulae or casks",
  domain: "formulae.brew.sh",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "type",
      type: "str",
      default: "formula",
      choices: ["formula", "cask"],
      description: "Package type",
    },
    {
      name: "window",
      type: "str",
      default: "30d",
      choices: ["30d", "90d", "365d"],
      description: "Homebrew analytics window",
    },
    {
      name: "limit",
      type: "int",
      default: 30,
      description: "Max rows",
    },
  ],
  columns: ["rank", "token", "type", "installs", "percent", "window", "url"],
  func: async (_page, kwargs) => {
    const type = requirePopularType(kwargs.type);
    const window = requirePopularWindow(kwargs.window);
    const limit = requireHomebrewLimit(kwargs.limit, 30);
    const path = type === "cask" ? "cask-install" : "install";
    const body = (await fetchHomebrewJson(
      `${BREW_BASE}/analytics/${path}/${window}.json`,
      `homebrew popular ${type}/${window}`,
    )) as HomebrewAnalyticsBody;
    return mapPopularRows(body, type, window, limit);
  },
});
