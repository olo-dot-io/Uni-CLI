/**
 * @owner   src/adapters/nuget/package.ts
 * @does    Register agent-facing NuGet package version-history command.
 * @needs   api.nuget.org registration index and leaf-page pagination.
 * @feeds   surface coverage ledger, .NET dependency inspection, registry command surface.
 * @breaks  NuGet registration stubs or malformed catalog entries hide package release history.
 */

import { cli, Strategy } from "../../registry.js";

const NUGET_REGISTRATION_BASE =
  "https://api.nuget.org/v3/registration5-semver1";

interface NugetCatalogEntry {
  id?: unknown;
  version?: unknown;
  title?: unknown;
  authors?: unknown;
  tags?: unknown;
  language?: unknown;
  licenseExpression?: unknown;
  projectUrl?: unknown;
  published?: unknown;
  listed?: unknown;
}

interface NugetRegistrationItem {
  catalogEntry?: NugetCatalogEntry;
}

interface NugetRegistrationPage {
  "@id"?: unknown;
  items?: NugetRegistrationItem[];
}

interface NugetRegistrationBody {
  items?: NugetRegistrationPage[];
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function requireNugetPackageId(value: unknown): string {
  const id = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error("nuget package id must be a non-empty package token.");
  }
  return id;
}

function joinAuthors(value: unknown): string {
  return Array.isArray(value)
    ? value.map(stringField).filter(Boolean).join(", ")
    : stringField(value);
}

function joinTags(value: unknown): string {
  return Array.isArray(value)
    ? value.map(stringField).filter(Boolean).join(", ")
    : stringField(value);
}

export async function collectNugetEntries(
  body: NugetRegistrationBody,
  fetchLeaf: (url: string) => Promise<NugetRegistrationPage>,
): Promise<NugetRegistrationItem[]> {
  const pages = Array.isArray(body.items) ? body.items : [];
  const entries: NugetRegistrationItem[] = [];
  for (const [index, page] of pages.entries()) {
    let pageItems = Array.isArray(page.items) ? page.items : null;
    if (!pageItems) {
      const url = stringField(page["@id"]);
      if (!url) {
        throw new Error(
          `nuget package registration page ${index + 1} is missing @id.`,
        );
      }
      const leaf = await fetchLeaf(url);
      if (!Array.isArray(leaf.items)) {
        throw new Error(`nuget package registration leaf has no items array.`);
      }
      pageItems = leaf.items;
    }
    for (const item of pageItems) {
      if (!item?.catalogEntry || typeof item.catalogEntry !== "object") {
        throw new Error(
          `nuget package registration page ${index + 1} has a malformed version entry.`,
        );
      }
      entries.push(item);
    }
  }
  return entries;
}

export function mapNugetPackageRows(
  entries: NugetRegistrationItem[],
  requested: string,
): Array<Record<string, unknown>> {
  if (entries.length === 0) {
    throw new Error(
      `No published versions found for NuGet package "${requested}".`,
    );
  }
  const sorted = [...entries].sort((a, b) => {
    const ap = stringField(a.catalogEntry?.published);
    const bp = stringField(b.catalogEntry?.published);
    if (ap !== bp) return bp.localeCompare(ap);
    return stringField(b.catalogEntry?.version).localeCompare(
      stringField(a.catalogEntry?.version),
    );
  });
  return sorted.map((entry, index) => {
    const cat = entry.catalogEntry ?? {};
    const id = stringField(cat.id) || requested;
    const version = stringField(cat.version);
    return {
      rank: index + 1,
      id,
      version,
      title: stringField(cat.title),
      authors: joinAuthors(cat.authors),
      tags: joinTags(cat.tags),
      language: stringField(cat.language),
      licenseExpression: stringField(cat.licenseExpression),
      projectUrl: stringField(cat.projectUrl),
      published: stringField(cat.published),
      listed: typeof cat.listed === "boolean" ? cat.listed : null,
      url: version ? `https://www.nuget.org/packages/${id}/${version}` : "",
    };
  });
}

async function fetchNugetJson(url: string, label: string): Promise<unknown> {
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

cli({
  site: "nuget",
  name: "package",
  description: "Full NuGet package version history",
  domain: "api.nuget.org",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "id",
      type: "str",
      required: true,
      positional: true,
      description: "NuGet package id",
    },
  ],
  columns: [
    "rank",
    "id",
    "version",
    "title",
    "authors",
    "tags",
    "language",
    "licenseExpression",
    "projectUrl",
    "published",
    "listed",
    "url",
  ],
  func: async (_page, kwargs) => {
    const id = requireNugetPackageId(kwargs.id);
    const body = (await fetchNugetJson(
      `${NUGET_REGISTRATION_BASE}/${encodeURIComponent(id.toLowerCase())}/index.json`,
      `nuget package ${id}`,
    )) as NugetRegistrationBody;
    const entries = await collectNugetEntries(
      body,
      async (url) =>
        (await fetchNugetJson(
          url,
          "nuget package page",
        )) as NugetRegistrationPage,
    );
    return mapNugetPackageRows(entries, id);
  },
});
