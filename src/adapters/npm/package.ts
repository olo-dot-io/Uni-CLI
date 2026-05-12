/**
 * @owner   src/adapters/npm/package.ts
 * @does    Register agent-facing npm single-package metadata command.
 * @needs   registry.npmjs.org public package documents.
 * @feeds   surface coverage ledger, JavaScript package inspection, registry command surface.
 * @breaks  npm registry document drift or weak scoped-name parsing hides package metadata failures.
 */

import { cli, Strategy } from "../../registry.js";

const NPM_REGISTRY = "https://registry.npmjs.org";

interface NpmPackageVersion {
  description?: unknown;
  license?: unknown;
  homepage?: unknown;
  repository?: unknown;
  bugs?: unknown;
  keywords?: unknown;
}

interface NpmPackageBody {
  name?: unknown;
  description?: unknown;
  "dist-tags"?: { latest?: unknown };
  versions?: Record<string, NpmPackageVersion>;
  maintainers?: unknown;
  time?: { created?: unknown; modified?: unknown };
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function requireNpmPackageName(value: unknown): string {
  const name = String(value ?? "").trim();
  if (!name) throw new Error("npm package name is required.");
  if (
    !/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name) ||
    name.includes("..")
  ) {
    throw new Error(`npm package name "${String(value)}" is not valid.`);
  }
  return name;
}

function repoUrl(repo: unknown): string {
  if (typeof repo === "string")
    return repo.replace(/^git\+/, "").replace(/\.git$/, "");
  if (
    repo &&
    typeof repo === "object" &&
    typeof (repo as { url?: unknown }).url === "string"
  ) {
    return (repo as { url: string }).url
      .replace(/^git\+/, "")
      .replace(/\.git$/, "");
  }
  return "";
}

function bugUrl(bugs: unknown): string {
  if (typeof bugs === "string") return bugs;
  if (
    bugs &&
    typeof bugs === "object" &&
    typeof (bugs as { url?: unknown }).url === "string"
  ) {
    return (bugs as { url: string }).url;
  }
  return "";
}

function licenseText(license: unknown): string {
  if (typeof license === "string") return license.trim();
  if (
    license &&
    typeof license === "object" &&
    typeof (license as { type?: unknown }).type === "string"
  ) {
    return (license as { type: string }).type.trim();
  }
  return "";
}

export function mapNpmPackageRow(
  body: NpmPackageBody,
  requested: string,
): Record<string, unknown> {
  const latest = stringField(body["dist-tags"]?.latest);
  if (!latest) {
    throw new Error(`npm registry has no latest version for "${requested}".`);
  }
  const version = body.versions?.[latest] ?? {};
  const name = stringField(body.name) || requested;
  const maintainers = Array.isArray(body.maintainers)
    ? body.maintainers
        .map((item) => {
          if (item && typeof item === "object") {
            const rec = item as { name?: unknown; email?: unknown };
            return stringField(rec.name) || stringField(rec.email);
          }
          return String(item ?? "").trim();
        })
        .filter(Boolean)
        .join(", ")
    : "";
  const keywords = Array.isArray(version.keywords)
    ? version.keywords.map(stringField).filter(Boolean).join(", ")
    : "";
  return {
    name,
    latestVersion: latest,
    description:
      stringField(version.description) || stringField(body.description),
    license: licenseText(version.license),
    homepage: stringField(version.homepage),
    repository: repoUrl(version.repository),
    bugs: bugUrl(version.bugs),
    maintainers,
    keywords,
    created: stringField(body.time?.created).slice(0, 10),
    modified: stringField(body.time?.modified).slice(0, 10),
    url: `https://www.npmjs.com/package/${encodeURIComponent(name)}`,
  };
}

async function fetchNpmJson(name: string): Promise<unknown> {
  const path = name.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`${NPM_REGISTRY}/${path}`, {
    headers: {
      "User-Agent": "unicli (https://github.com/olo-dot-io/Uni-CLI)",
      Accept: "application/json",
    },
  });
  if (response.status === 404)
    throw new Error(`npm package ${name} returned no result.`);
  if (!response.ok)
    throw new Error(`npm package ${name} returned HTTP ${response.status}.`);
  return response.json();
}

cli({
  site: "npm",
  name: "package",
  description: "Single npm package metadata",
  domain: "registry.npmjs.org",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "name",
      type: "str",
      required: true,
      positional: true,
      description: "npm package name",
    },
  ],
  columns: [
    "name",
    "latestVersion",
    "description",
    "license",
    "homepage",
    "repository",
    "bugs",
    "maintainers",
    "keywords",
    "created",
    "modified",
    "url",
  ],
  func: async (_page, kwargs) => {
    const name = requireNpmPackageName(kwargs.name);
    const body = (await fetchNpmJson(name)) as NpmPackageBody;
    return [mapNpmPackageRow(body, name)];
  },
});
