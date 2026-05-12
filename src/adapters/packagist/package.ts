/**
 * @owner   src/adapters/packagist/package.ts
 * @does    Register agent-facing Packagist single-package metadata command.
 * @needs   packagist.org package JSON API and stable-version selection.
 * @feeds   surface coverage ledger, PHP dependency inspection, registry command surface.
 * @breaks  Packagist envelope drift or unstable version picking hides Composer package state.
 */

import { cli, Strategy } from "../../registry.js";

const PACKAGIST_BASE = "https://packagist.org";

interface PackagistPackage {
  name?: unknown;
  description?: unknown;
  repository?: unknown;
  github_stars?: unknown;
  favers?: unknown;
  downloads?: {
    total?: unknown;
    monthly?: unknown;
    daily?: unknown;
  };
  versions?: Record<string, { time?: unknown; license?: unknown }>;
}

interface PackagistBody {
  package?: PackagistPackage;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function requirePackagistName(value: unknown): string {
  const name = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(name)) {
    throw new Error('packagist package name must be "<vendor>/<package>".');
  }
  return name;
}

export function pickStableVersion(
  versions: PackagistPackage["versions"],
): string {
  const keys = Object.keys(versions ?? {});
  return (
    keys.find(
      (version) =>
        /^v?\d+\.\d+\.\d+(?:\+\S+)?$/.test(version) &&
        !/dev|alpha|beta|rc/i.test(version),
    ) ??
    keys.find((version) => !/dev|alpha|beta|rc/i.test(version)) ??
    keys[0] ??
    ""
  );
}

export function mapPackagistPackageRow(
  body: PackagistBody,
  requested: string,
): Record<string, unknown> {
  const pkg = body.package;
  if (!pkg || typeof pkg !== "object") {
    throw new Error(`Packagist returned no package metadata for ${requested}.`);
  }
  const version = pickStableVersion(pkg.versions);
  const entry = version ? pkg.versions?.[version] : undefined;
  const license = Array.isArray(entry?.license)
    ? entry.license.map(stringField).filter(Boolean).join(", ")
    : "";
  const downloads = pkg.downloads ?? {};
  const name = stringField(pkg.name) || requested;
  return {
    package: name,
    version,
    releasedAt: stringField(entry?.time).slice(0, 10),
    license,
    description: stringField(pkg.description),
    repository: stringField(pkg.repository),
    githubStars: numberField(pkg.github_stars),
    favers: numberField(pkg.favers),
    downloads: numberField(downloads.total),
    monthlyDownloads: numberField(downloads.monthly),
    dailyDownloads: numberField(downloads.daily),
    url: `${PACKAGIST_BASE}/packages/${name}`,
  };
}

async function fetchPackagistJson(name: string): Promise<unknown> {
  const response = await fetch(`${PACKAGIST_BASE}/packages/${name}.json`, {
    headers: {
      "User-Agent": "unicli (https://github.com/olo-dot-io/Uni-CLI)",
      Accept: "application/json",
    },
  });
  if (response.status === 404)
    throw new Error(`packagist package ${name} returned no result.`);
  if (!response.ok)
    throw new Error(
      `packagist package ${name} returned HTTP ${response.status}.`,
    );
  return response.json();
}

cli({
  site: "packagist",
  name: "package",
  description: "Fetch Packagist package metadata",
  domain: "packagist.org",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "name",
      type: "str",
      required: true,
      positional: true,
      description: 'Composer package "<vendor>/<package>"',
    },
  ],
  columns: [
    "package",
    "version",
    "releasedAt",
    "license",
    "description",
    "repository",
    "githubStars",
    "favers",
    "downloads",
    "monthlyDownloads",
    "dailyDownloads",
    "url",
  ],
  func: async (_page, kwargs) => {
    const name = requirePackagistName(kwargs.name);
    const body = (await fetchPackagistJson(name)) as PackagistBody;
    return [mapPackagistPackageRow(body, name)];
  },
});
