/**
 * @owner   src/adapters/dockerhub/registry.ts
 * @does    Register agent-facing Docker Hub search and image metadata commands.
 * @needs   Public Docker Hub API, TypeScript adapter loader, bounded argument parsing.
 * @feeds   surface coverage ledger, container registry command surface, agent-readable image rows.
 * @breaks  Docker Hub API envelope drift, weak image parsing, or silent empty results hide registry lookup failures.
 */

import { cli, Strategy } from "../../registry.js";

const HUB_BASE = "https://hub.docker.com/v2";

interface DockerHubSearchItem {
  repo_owner?: unknown;
  repo_name?: unknown;
  is_official?: unknown;
  star_count?: unknown;
  pull_count?: unknown;
  short_description?: unknown;
}

interface DockerHubImageBody {
  namespace?: unknown;
  name?: unknown;
  star_count?: unknown;
  pull_count?: unknown;
  description?: unknown;
  last_updated?: unknown;
  last_modified?: unknown;
  date_registered?: unknown;
  status_description?: unknown;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function requireDockerHubString(value: unknown, name: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} is required.`);
  return text;
}

export function requireDockerHubLimit(
  value: unknown,
  fallback: number,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new Error(
      `limit must be an integer in [1, 100]. Got: ${String(value)}`,
    );
  }
  return n;
}

export function parseDockerHubImage(value: unknown): {
  owner: string;
  name: string;
} {
  const raw = requireDockerHubString(value, "image");
  const parts = raw.split("/").filter(Boolean);
  if (parts.length === 1) return { owner: "library", name: parts[0] };
  if (parts.length === 2) return { owner: parts[0], name: parts[1] };
  throw new Error(
    "image must be a Docker Hub image name like nginx or bitnami/redis.",
  );
}

function trimDate(value: unknown): string | null {
  const text = stringField(value).trim();
  if (!text) return null;
  const noFraction = text.replace(/\.\d+/, "");
  return noFraction.endsWith("Z") ? noFraction : `${noFraction}Z`;
}

async function fetchDockerHubJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Docker Hub request failed: HTTP ${response.status}`);
  }
  return response.json();
}

export function mapDockerHubSearchRows(
  items: DockerHubSearchItem[],
  limit: number,
): Array<Record<string, unknown>> {
  return items.slice(0, limit).map((item, index) => {
    const owner = stringField(item.repo_owner).trim();
    const name = stringField(item.repo_name).trim();
    const official = Boolean(item.is_official);
    const image = owner
      ? `${owner}/${name}`
      : official
        ? `library/${name}`
        : name;
    return {
      rank: index + 1,
      image,
      official,
      stars: numberField(item.star_count),
      pulls: numberField(item.pull_count),
      description: stringField(item.short_description).trim(),
      url: image ? `https://hub.docker.com/r/${image}` : "",
    };
  });
}

export function mapDockerHubImageRow(
  body: DockerHubImageBody,
  fallbackOwner: string,
  fallbackName: string,
): Record<string, unknown> {
  const namespace = stringField(body.namespace).trim() || fallbackOwner;
  const name = stringField(body.name).trim() || fallbackName;
  if (!name) throw new Error("Docker Hub returned no image metadata.");
  const official = namespace === "library" || namespace === "_";
  const image = official ? `library/${name}` : `${namespace}/${name}`;
  return {
    image,
    official,
    stars: numberField(body.star_count),
    pulls: numberField(body.pull_count),
    description: stringField(body.description).trim(),
    lastUpdated: trimDate(body.last_updated),
    lastModified: trimDate(body.last_modified),
    registered: trimDate(body.date_registered),
    status: stringField(body.status_description).trim(),
    url: `https://hub.docker.com/r/${image}`,
  };
}

cli({
  site: "dockerhub",
  name: "search",
  description: "Search Docker Hub repositories by keyword",
  domain: "hub.docker.com",
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
      default: 25,
      description: "Max repositories",
    },
  ],
  columns: [
    "rank",
    "image",
    "official",
    "stars",
    "pulls",
    "description",
    "url",
  ],
  func: async (_page, kwargs) => {
    const query = requireDockerHubString(kwargs.query, "query");
    const limit = requireDockerHubLimit(kwargs.limit, 25);
    const url = `${HUB_BASE}/search/repositories/?query=${encodeURIComponent(query)}&page_size=${limit}`;
    const body = (await fetchDockerHubJson(url)) as {
      results?: DockerHubSearchItem[];
    };
    const rows = mapDockerHubSearchRows(
      Array.isArray(body.results) ? body.results : [],
      limit,
    );
    if (rows.length === 0) {
      throw new Error(`No Docker Hub repositories matched "${query}".`);
    }
    return rows;
  },
});

cli({
  site: "dockerhub",
  name: "image",
  description: "Fetch a Docker Hub repository's public metadata",
  domain: "hub.docker.com",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "image",
      type: "str",
      required: true,
      positional: true,
      description: "Image name, e.g. nginx or bitnami/redis",
    },
  ],
  columns: [
    "image",
    "official",
    "stars",
    "pulls",
    "description",
    "lastUpdated",
    "lastModified",
    "registered",
    "status",
    "url",
  ],
  func: async (_page, kwargs) => {
    const { owner, name } = parseDockerHubImage(kwargs.image);
    const body = (await fetchDockerHubJson(
      `${HUB_BASE}/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/`,
    )) as DockerHubImageBody;
    return [mapDockerHubImageRow(body, owner, name)];
  },
});
