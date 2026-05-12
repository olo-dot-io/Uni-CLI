/**
 * @owner   src/adapters/crates/registry.ts
 * @does    Register agent-facing crates.io search and crate metadata commands.
 * @needs   Public crates.io API, TypeScript adapter loader, bounded argument parsing.
 * @feeds   surface coverage ledger, package registry command surface, agent-readable registry rows.
 * @breaks  crates.io API envelope drift, weak query validation, or silent empty results hide registry lookup failures.
 */

import { cli, Strategy } from "../../registry.js";

const CRATES_BASE = "https://crates.io";

interface CratesSearchItem {
  id?: unknown;
  name?: unknown;
  newest_version?: unknown;
  max_stable_version?: unknown;
  max_version?: unknown;
  description?: unknown;
  downloads?: unknown;
  recent_downloads?: unknown;
  repository?: unknown;
  homepage?: unknown;
  updated_at?: unknown;
}

interface CratesDetailBody {
  crate?: CratesSearchItem & {
    num_versions?: unknown;
    created_at?: unknown;
  };
  versions?: Array<{
    num?: unknown;
    license?: unknown;
  }>;
  keywords?: Array<{
    keyword?: unknown;
    id?: unknown;
  }>;
  categories?: Array<{
    category?: unknown;
    slug?: unknown;
  }>;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function requireRegistryString(value: unknown, name: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} is required.`);
  return text;
}

export function requireRegistryLimit(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new Error(
      `limit must be an integer in [1, 100]. Got: ${String(value)}`,
    );
  }
  return n;
}

async function fetchCratesJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "unicli (https://github.com/olo-dot-io/Uni-CLI)",
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`crates.io request failed: HTTP ${response.status}`);
  }
  return response.json();
}

export function mapCratesSearchRows(
  items: CratesSearchItem[],
  limit: number,
): Array<Record<string, unknown>> {
  return items.slice(0, limit).map((crate, index) => {
    const name = stringField(crate.name) || stringField(crate.id);
    return {
      rank: index + 1,
      name,
      latestVersion:
        stringField(crate.newest_version) ||
        stringField(crate.max_stable_version) ||
        stringField(crate.max_version),
      description: stringField(crate.description).trim(),
      downloads: numberField(crate.downloads),
      recentDownloads: numberField(crate.recent_downloads),
      repository: stringField(crate.repository) || stringField(crate.homepage),
      updated: stringField(crate.updated_at).slice(0, 10),
      url: name ? `${CRATES_BASE}/crates/${name}` : "",
    };
  });
}

export function mapCratesDetailRow(
  body: CratesDetailBody,
): Record<string, unknown> {
  const crate = body.crate;
  if (!crate || !(stringField(crate.name) || stringField(crate.id))) {
    throw new Error("crates.io returned no crate metadata.");
  }
  const versions = Array.isArray(body.versions) ? body.versions : [];
  const latestVersion =
    stringField(crate.newest_version) ||
    stringField(crate.max_stable_version) ||
    stringField(crate.max_version);
  const latestRow =
    versions.find((version) => stringField(version.num) === latestVersion) ??
    versions[0] ??
    {};
  const name = stringField(crate.name) || stringField(crate.id);
  const keywords = Array.isArray(body.keywords)
    ? body.keywords
        .map((item) => stringField(item.keyword) || stringField(item.id))
        .filter(Boolean)
        .join(", ")
    : "";
  const categories = Array.isArray(body.categories)
    ? body.categories
        .map((item) => stringField(item.category) || stringField(item.slug))
        .filter(Boolean)
        .join(", ")
    : "";

  return {
    name,
    latestVersion,
    description: stringField(crate.description).trim(),
    downloads: numberField(crate.downloads),
    recentDownloads: numberField(crate.recent_downloads),
    versions: numberField(crate.num_versions) ?? versions.length,
    license: stringField(latestRow.license),
    homepage: stringField(crate.homepage),
    documentation: stringField(
      (crate as { documentation?: unknown }).documentation,
    ),
    repository: stringField(crate.repository),
    keywords,
    categories,
    created: stringField(crate.created_at).slice(0, 10),
    updated: stringField(crate.updated_at).slice(0, 10),
    url: `${CRATES_BASE}/crates/${name}`,
  };
}

cli({
  site: "crates",
  name: "search",
  description: "Search the public crates.io registry by keyword",
  domain: "crates.io",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "query",
      type: "str",
      required: true,
      positional: true,
      description: "Search keyword",
    },
    {
      name: "limit",
      type: "int",
      default: 20,
      description: "Max results",
    },
  ],
  columns: [
    "rank",
    "name",
    "latestVersion",
    "description",
    "downloads",
    "recentDownloads",
    "repository",
    "updated",
    "url",
  ],
  func: async (_page, kwargs) => {
    const query = requireRegistryString(kwargs.query, "query");
    const limit = requireRegistryLimit(kwargs.limit, 20);
    const url = `${CRATES_BASE}/api/v1/crates?q=${encodeURIComponent(query)}&per_page=${limit}`;
    const body = (await fetchCratesJson(url)) as {
      crates?: CratesSearchItem[];
    };
    const rows = mapCratesSearchRows(
      Array.isArray(body.crates) ? body.crates : [],
      limit,
    );
    if (rows.length === 0) {
      throw new Error(`No crates.io results matched "${query}".`);
    }
    return rows;
  },
});

cli({
  site: "crates",
  name: "crate",
  description: "Single crates.io crate metadata",
  domain: "crates.io",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "name",
      type: "str",
      required: true,
      positional: true,
      description: "crates.io crate name",
    },
  ],
  columns: [
    "name",
    "latestVersion",
    "description",
    "downloads",
    "recentDownloads",
    "versions",
    "license",
    "homepage",
    "documentation",
    "repository",
    "keywords",
    "categories",
    "created",
    "updated",
    "url",
  ],
  func: async (_page, kwargs) => {
    const name = requireRegistryString(kwargs.name, "name");
    const body = (await fetchCratesJson(
      `${CRATES_BASE}/api/v1/crates/${encodeURIComponent(name)}`,
    )) as CratesDetailBody;
    return [mapCratesDetailRow(body)];
  },
});
