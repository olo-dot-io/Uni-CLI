/**
 * @owner   src/adapters/rubygems/gem.ts
 * @does    Register agent-facing RubyGems single-gem metadata command.
 * @needs   rubygems.org public gem JSON API.
 * @feeds   surface coverage ledger, Ruby dependency inspection, registry command surface.
 * @breaks  RubyGems envelope drift or weak gem-name validation hides gem metadata.
 */

import { cli, Strategy } from "../../registry.js";

const GEMS_BASE = "https://rubygems.org/api/v1";

interface RubyGemBody {
  name?: unknown;
  version?: unknown;
  version_created_at?: unknown;
  downloads?: unknown;
  version_downloads?: unknown;
  licenses?: unknown;
  authors?: unknown;
  homepage_uri?: unknown;
  source_code_uri?: unknown;
  bug_tracker_uri?: unknown;
  metadata?: Record<string, unknown>;
  info?: unknown;
  project_uri?: unknown;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function requireGemName(value: unknown): string {
  const name = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error("gem name must be a non-empty RubyGems token.");
  }
  return name;
}

export function mapRubyGemRow(
  body: RubyGemBody,
  requested: string,
): Record<string, unknown> {
  const name = stringField(body.name) || requested;
  if (!name) throw new Error(`RubyGems returned no metadata for ${requested}.`);
  const licenses = Array.isArray(body.licenses)
    ? body.licenses.map(stringField).filter(Boolean).join(", ")
    : "";
  const metadata = body.metadata ?? {};
  return {
    gem: name,
    version: stringField(body.version),
    releasedAt: stringField(body.version_created_at).slice(0, 10),
    downloads: numberField(body.downloads),
    versionDownloads: numberField(body.version_downloads),
    license: licenses,
    authors: stringField(body.authors),
    homepage: stringField(body.homepage_uri),
    source:
      stringField(body.source_code_uri) ||
      stringField(metadata.source_code_uri),
    bugs:
      stringField(body.bug_tracker_uri) ||
      stringField(metadata.bug_tracker_uri),
    info: stringField(body.info),
    url: stringField(body.project_uri) || `https://rubygems.org/gems/${name}`,
  };
}

async function fetchGemJson(name: string): Promise<unknown> {
  const response = await fetch(
    `${GEMS_BASE}/gems/${encodeURIComponent(name)}.json`,
    {
      headers: {
        "User-Agent": "unicli (https://github.com/olo-dot-io/Uni-CLI)",
        Accept: "application/json",
      },
    },
  );
  if (response.status === 404)
    throw new Error(`rubygems gem ${name} returned no result.`);
  if (!response.ok)
    throw new Error(`rubygems gem ${name} returned HTTP ${response.status}.`);
  return response.json();
}

cli({
  site: "rubygems",
  name: "gem",
  description: "Fetch RubyGems gem metadata",
  domain: "rubygems.org",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "name",
      type: "str",
      required: true,
      positional: true,
      description: "Gem name",
    },
  ],
  columns: [
    "gem",
    "version",
    "releasedAt",
    "downloads",
    "versionDownloads",
    "license",
    "authors",
    "homepage",
    "source",
    "bugs",
    "info",
    "url",
  ],
  func: async (_page, kwargs) => {
    const name = requireGemName(kwargs.name);
    const body = (await fetchGemJson(name)) as RubyGemBody;
    return [mapRubyGemRow(body, name)];
  },
});
