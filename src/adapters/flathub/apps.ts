/**
 * @owner   src/adapters/flathub/apps.ts
 * @does    Register agent-facing Flathub app search and detail commands.
 * @needs   Flathub public API, AppStream id validation, bounded search limits.
 * @feeds   surface coverage ledger, Linux app registry search rows, appstream metadata rows.
 * @breaks  Flathub API drift, weak app id validation, or silent empty rows hide app registry data.
 */

import { cli, Strategy } from "../../registry.js";

const API_BASE = "https://flathub.org/api/v2";
const APP_BASE = "https://flathub.org/apps";
const APP_ID_RE =
  /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_][A-Za-z0-9_-]*){1,}$/;

function requireNonEmpty(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`flathub ${label} cannot be empty.`);
  return text;
}

export function requireFlathubLimit(value: unknown): number {
  const raw =
    value === undefined || value === null || value === "" ? 25 : value;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("flathub limit must be an integer in [1, 100].");
  }
  return limit;
}

export function requireFlathubAppId(value: unknown): string {
  const id = String(value ?? "").trim();
  if (!id) throw new Error("flathub appId cannot be empty.");
  if (!APP_ID_RE.test(id)) {
    throw new Error(`flathub appId "${String(value)}" is not valid.`);
  }
  return id;
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

function objectField(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export function joinFlathubList(value: unknown, max = 10): string {
  if (!Array.isArray(value)) return "";
  const items = value.filter((item) => typeof item === "string" && item.trim());
  return items.length > max
    ? [...items.slice(0, max), `(+${items.length - max})`].join(", ")
    : items.join(", ");
}

function timestampToDate(value: unknown): string | null {
  const n = numberField(value);
  if (n == null || n <= 0) return null;
  const date = new Date(n * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

export function pickLatestFlathubRelease(value: unknown): {
  date: string | null;
  version: string | null;
} {
  if (!Array.isArray(value)) return { date: null, version: null };
  const releases = [...(value as Array<Record<string, unknown>>)].sort(
    (a, b) => (numberField(b.timestamp) ?? 0) - (numberField(a.timestamp) ?? 0),
  );
  const latest = releases[0];
  if (!latest) return { date: null, version: null };
  return {
    version: stringField(latest.version) || null,
    date: timestampToDate(latest.timestamp) ?? stringField(latest.date) ?? null,
  };
}

export function mapFlathubSearchRows(
  hits: Array<Record<string, unknown>>,
  limit: number,
): Array<Record<string, unknown>> {
  return hits.slice(0, limit).map((hit, index) => {
    const appId = stringField(hit.app_id);
    return {
      rank: index + 1,
      appId,
      name: stringField(hit.name),
      summary: stringField(hit.summary),
      developer: stringField(hit.developer_name),
      license: stringField(hit.project_license),
      isFreeLicense: hit.is_free_license === true,
      mainCategories:
        stringField(hit.main_categories) ||
        joinFlathubList(hit.main_categories),
      installsLastMonth: numberField(hit.installs_last_month),
      updatedAt: timestampToDate(hit.updated_at) ?? stringField(hit.updated_at),
      url: appId ? `${APP_BASE}/${appId}` : "",
    };
  });
}

export function mapFlathubAppRow(
  appId: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const urls = objectField(body.urls);
  const release = pickLatestFlathubRelease(body.releases);
  return {
    appId: stringField(body.id) || appId,
    name: stringField(body.name),
    summary: stringField(body.summary),
    developer: stringField(body.developer_name),
    license: stringField(body.project_license),
    isFreeLicense: body.is_free_license === true,
    isEol: body.is_eol === true,
    categories: joinFlathubList(body.categories),
    keywords: joinFlathubList(body.keywords, 8),
    latestVersion: release.version,
    latestReleaseDate: release.date,
    homepage: stringField(urls.homepage) || null,
    bugtracker: stringField(urls.bugtracker) || null,
    donation: stringField(urls.donation) || null,
    url: `${APP_BASE}/${appId}`,
  };
}

async function fetchJson(
  url: URL | string,
  label: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      "user-agent": "unicli-flathub (https://github.com/olo-dot-io/Uni-CLI)",
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  if (response.status === 404) throw new Error(`${label} returned no result.`);
  if (response.status === 429) throw new Error(`${label} returned HTTP 429.`);
  if (!response.ok)
    throw new Error(`${label} returned HTTP ${response.status}.`);
  return response.json();
}

cli({
  site: "flathub",
  name: "search",
  description: "Search Flathub apps by keyword",
  domain: "flathub.org",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "query",
      type: "str",
      required: true,
      positional: true,
      description: "Search keyword",
    },
    { name: "limit", type: "int", default: 25, description: "Max rows" },
  ],
  columns: [
    "rank",
    "appId",
    "name",
    "summary",
    "developer",
    "license",
    "isFreeLicense",
    "mainCategories",
    "installsLastMonth",
    "updatedAt",
    "url",
  ],
  func: async (_page, kwargs) => {
    const query = requireNonEmpty(kwargs.query, "query");
    const limit = requireFlathubLimit(kwargs.limit);
    const body = (await fetchJson(`${API_BASE}/search`, "flathub search", {
      body: JSON.stringify({ hitsPerPage: limit, page: 1, query }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })) as { hits?: unknown };
    const rows = mapFlathubSearchRows(
      Array.isArray(body.hits)
        ? (body.hits as Array<Record<string, unknown>>)
        : [],
      limit,
    );
    if (rows.length === 0)
      throw new Error(`flathub search returned no rows for "${query}".`);
    return rows;
  },
});

cli({
  site: "flathub",
  name: "app",
  description: "Fetch full Flathub appstream metadata by app id",
  domain: "flathub.org",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "appId",
      type: "str",
      required: true,
      positional: true,
      description: "AppStream id",
    },
  ],
  columns: [
    "appId",
    "name",
    "summary",
    "developer",
    "license",
    "isFreeLicense",
    "isEol",
    "categories",
    "keywords",
    "latestVersion",
    "latestReleaseDate",
    "homepage",
    "bugtracker",
    "donation",
    "url",
  ],
  func: async (_page, kwargs) => {
    const appId = requireFlathubAppId(kwargs.appId);
    const body = objectField(
      await fetchJson(
        `${API_BASE}/appstream/${encodeURIComponent(appId)}`,
        "flathub app",
      ),
    );
    if (!body.id)
      throw new Error(`flathub app returned no row for "${appId}".`);
    return [mapFlathubAppRow(appId, body)];
  },
});
