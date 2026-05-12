/**
 * @owner   src/adapters/pypi/package.ts
 * @does    Register agent-facing PyPI package metadata and download-stat commands.
 * @needs   Public PyPI JSON API, public pypistats JSON API, TypeScript adapter loader.
 * @feeds   surface coverage ledger, Python package registry command surface, agent-readable package rows.
 * @breaks  PyPI/pypistats API drift, weak distribution-name parsing, or silent empty rows hide package lookup failures.
 */

import { cli, Strategy } from "../../registry.js";

const PYPI_BASE = "https://pypi.org";
const PYPISTATS_BASE = "https://pypistats.org";
const PACKAGE_NAME_RE = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;

interface PyPiInfo {
  name?: unknown;
  version?: unknown;
  summary?: unknown;
  author?: unknown;
  author_email?: unknown;
  license_expression?: unknown;
  license?: unknown;
  home_page?: unknown;
  project_urls?: Record<string, unknown> | null;
  requires_python?: unknown;
  keywords?: unknown;
  package_url?: unknown;
}

interface PyPiPackageBody {
  info?: PyPiInfo;
  releases?: Record<string, Array<{ upload_time?: unknown }>>;
}

interface PyPiDownloadsBody {
  package?: unknown;
  data?: unknown;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function requirePyPiPackageName(value: unknown): string {
  const name = String(value ?? "").trim();
  if (!name) throw new Error("pypi package name is required.");
  if (!PACKAGE_NAME_RE.test(name)) {
    throw new Error(
      `pypi package name "${String(value)}" is not a valid distribution name.`,
    );
  }
  return name;
}

export function requirePyPiDownloadsPeriod(
  value: unknown,
): "recent" | "overall" {
  const period = String(value ?? "recent")
    .trim()
    .toLowerCase();
  if (period !== "recent" && period !== "overall") {
    throw new Error("period must be recent or overall.");
  }
  return period;
}

function pickProjectUrl(info: PyPiInfo, keys: string[]): string {
  const urls = info.project_urls;
  if (!urls || typeof urls !== "object") return "";
  for (const key of keys) {
    const value = urls[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

function pickHomepage(info: PyPiInfo): string {
  return (
    stringField(info.home_page) ||
    pickProjectUrl(info, [
      "Homepage",
      "homepage",
      "Documentation",
      "Source",
      "Source Code",
    ])
  );
}

function pickRepository(info: PyPiInfo): string {
  return pickProjectUrl(info, [
    "Source",
    "Source Code",
    "Repository",
    "repository",
  ]);
}

async function fetchJson(url: string, label: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "unicli (https://github.com/olo-dot-io/Uni-CLI)",
      Accept: "application/json",
    },
  });
  if (response.status === 404) throw new Error(`${label} returned no result.`);
  if (response.status === 429) throw new Error(`${label} returned HTTP 429.`);
  if (!response.ok)
    throw new Error(`${label} returned HTTP ${response.status}.`);
  return response.json();
}

export function mapPyPiPackageRow(
  body: PyPiPackageBody,
  requestedName: string,
): Record<string, unknown> {
  const info = body.info;
  if (!info?.name) {
    throw new Error(`PyPI returned no metadata for "${requestedName}".`);
  }
  const releases = body.releases ?? {};
  const releaseVersions = Object.keys(releases).filter(
    (version) =>
      Array.isArray(releases[version]) && releases[version].length > 0,
  );
  let firstReleased = "";
  let lastReleased = "";
  for (const version of releaseVersions) {
    for (const file of releases[version] ?? []) {
      const date = stringField(file.upload_time).slice(0, 10);
      if (!date) continue;
      if (!firstReleased || date < firstReleased) firstReleased = date;
      if (!lastReleased || date > lastReleased) lastReleased = date;
    }
  }
  const name = stringField(info.name);
  return {
    name,
    latestVersion: stringField(info.version),
    summary: stringField(info.summary),
    author: stringField(info.author) || stringField(info.author_email),
    license: stringField(info.license_expression) || stringField(info.license),
    homepage: pickHomepage(info),
    repository: pickRepository(info),
    requiresPython: stringField(info.requires_python),
    keywords: stringField(info.keywords),
    releases: releaseVersions.length,
    firstReleased,
    lastReleased,
    url: stringField(info.package_url) || `${PYPI_BASE}/project/${name}/`,
  };
}

export function mapRecentDownloadRows(
  body: PyPiDownloadsBody,
  requestedName: string,
): Array<Record<string, unknown>> {
  const data = body.data as Record<string, unknown> | undefined;
  if (
    !data ||
    (data.last_day == null && data.last_week == null && data.last_month == null)
  ) {
    throw new Error(
      `pypistats has no recent download data for "${requestedName}".`,
    );
  }
  const name = stringField(body.package) || requestedName;
  return [
    {
      rank: 1,
      package: name,
      period: "last_day",
      date: "",
      downloads: numberField(data.last_day),
    },
    {
      rank: 2,
      package: name,
      period: "last_week",
      date: "",
      downloads: numberField(data.last_week),
    },
    {
      rank: 3,
      package: name,
      period: "last_month",
      date: "",
      downloads: numberField(data.last_month),
    },
  ];
}

export function mapOverallDownloadRows(
  body: PyPiDownloadsBody,
  requestedName: string,
): Array<Record<string, unknown>> {
  const days = Array.isArray(body.data)
    ? (body.data as Array<Record<string, unknown>>)
    : [];
  if (days.length === 0) {
    throw new Error(
      `pypistats has no overall download history for "${requestedName}".`,
    );
  }
  const name = stringField(body.package) || requestedName;
  return days.map((row, index) => ({
    rank: index + 1,
    package: name,
    period: "daily",
    date: stringField(row.date),
    downloads: numberField(row.downloads),
  }));
}

cli({
  site: "pypi",
  name: "package",
  description: "Single PyPI package metadata",
  domain: "pypi.org",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "name",
      type: "str",
      required: true,
      positional: true,
      description: "PyPI package name",
    },
  ],
  columns: [
    "name",
    "latestVersion",
    "summary",
    "author",
    "license",
    "homepage",
    "repository",
    "requiresPython",
    "keywords",
    "releases",
    "firstReleased",
    "lastReleased",
    "url",
  ],
  func: async (_page, kwargs) => {
    const name = requirePyPiPackageName(kwargs.name);
    const body = (await fetchJson(
      `${PYPI_BASE}/pypi/${encodeURIComponent(name)}/json`,
      `pypi package ${name}`,
    )) as PyPiPackageBody;
    return [mapPyPiPackageRow(body, name)];
  },
});

cli({
  site: "pypi",
  name: "downloads",
  description: "PyPI download stats for a package",
  domain: "pypistats.org",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "name",
      type: "str",
      required: true,
      positional: true,
      description: "PyPI package name",
    },
    {
      name: "period",
      type: "str",
      default: "recent",
      choices: ["recent", "overall"],
      description: "recent totals or overall daily history",
    },
  ],
  columns: ["rank", "package", "period", "date", "downloads"],
  func: async (_page, kwargs) => {
    const name = requirePyPiPackageName(kwargs.name);
    const period = requirePyPiDownloadsPeriod(kwargs.period);
    const url =
      period === "recent"
        ? `${PYPISTATS_BASE}/api/packages/${encodeURIComponent(name)}/recent`
        : `${PYPISTATS_BASE}/api/packages/${encodeURIComponent(name)}/overall?mirrors=false`;
    const body = (await fetchJson(
      url,
      `pypi downloads ${name}`,
    )) as PyPiDownloadsBody;
    return period === "recent"
      ? mapRecentDownloadRows(body, name)
      : mapOverallDownloadRows(body, name);
  },
});
