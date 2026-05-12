/**
 * @owner   src/adapters/goproxy/module.ts
 * @does    Register agent-facing Go module proxy metadata and version commands.
 * @needs   Public proxy.golang.org GOPROXY protocol, TypeScript adapter loader, Go module path validation.
 * @feeds   surface coverage ledger, Go package registry command surface, agent-readable module rows.
 * @breaks  GOPROXY protocol drift, weak module path validation, or silent empty rows hide module lookup failures.
 */

import { cli, Strategy } from "../../registry.js";

const GOPROXY_BASE = "https://proxy.golang.org";
const MODULE_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const VERSION_TAG_RE = /^v[0-9]+(\.[0-9]+)*([-+][A-Za-z0-9._-]+)?$/;

interface GoProxyLatest {
  Version?: unknown;
  Time?: unknown;
  Origin?: {
    VCS?: unknown;
    URL?: unknown;
    Hash?: unknown;
    Ref?: unknown;
  };
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function trimDate(value: unknown): string | null {
  const text = stringField(value).trim();
  if (!text) return null;
  const noFraction = text.replace(/\.\d+/, "");
  return noFraction.endsWith("Z")
    ? noFraction
    : text.length >= 10
      ? text.slice(0, 10)
      : null;
}

export function requireGoModulePath(value: unknown): string {
  const modulePath = String(value ?? "").trim();
  if (!modulePath) throw new Error("goproxy module path is required.");
  if (!MODULE_PATH_RE.test(modulePath) || !modulePath.includes("/")) {
    throw new Error(
      `goproxy module path "${String(value)}" is not recognised.`,
    );
  }
  return modulePath;
}

export function requireGoProxyLimit(value: unknown, fallback = 30): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 200) {
    throw new Error(
      `goproxy limit must be an integer in [1, 200]. Got: ${String(value)}`,
    );
  }
  return n;
}

function encodeModulePath(modulePath: string): string {
  return modulePath.split("/").map(encodeURIComponent).join("/");
}

function parseSemver(tag: string): { numbers: number[]; pre: string } {
  const stripped = tag.replace(/^v/, "");
  const noBuild = stripped.split("+")[0] ?? stripped;
  const dash = noBuild.indexOf("-");
  const head = dash >= 0 ? noBuild.slice(0, dash) : noBuild;
  const pre = dash >= 0 ? noBuild.slice(dash + 1) : "";
  return {
    numbers: head.split(".").map((part) => {
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    }),
    pre,
  };
}

function comparePrerelease(left: string, right: string): number {
  const leftParts = left.split(".");
  const rightParts = right.split(".");
  const length = Math.max(leftParts.length, rightParts.length);
  for (let i = 0; i < length; i += 1) {
    const a = leftParts[i];
    const b = rightParts[i];
    if (a == null) return -1;
    if (b == null) return 1;
    const aNum = /^\d+$/.test(a);
    const bNum = /^\d+$/.test(b);
    if (aNum && bNum) {
      const diff = Number(a) - Number(b);
      if (diff !== 0) return diff;
      continue;
    }
    if (aNum !== bNum) return aNum ? -1 : 1;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  const length = Math.max(a.numbers.length, b.numbers.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (a.numbers[i] ?? 0) - (b.numbers[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (a.pre === "" && b.pre !== "") return 1;
  if (a.pre !== "" && b.pre === "") return -1;
  return comparePrerelease(a.pre, b.pre);
}

export function sortGoVersionsDescending(versions: string[]): string[] {
  return versions
    .filter((version) => VERSION_TAG_RE.test(version))
    .sort((a, b) => compareSemver(b, a));
}

export function mapGoProxyModuleRow(
  modulePath: string,
  detail: GoProxyLatest,
): Record<string, unknown> {
  if (!detail.Version) {
    throw new Error(
      `proxy.golang.org returned no @latest entry for "${modulePath}".`,
    );
  }
  const origin = detail.Origin ?? {};
  const encoded = encodeModulePath(modulePath);
  return {
    module: modulePath,
    version: stringField(detail.Version),
    publishedAt: trimDate(detail.Time),
    vcs: stringField(origin.VCS).trim(),
    repository: stringField(origin.URL).trim(),
    commit: stringField(origin.Hash).trim(),
    ref: stringField(origin.Ref).trim(),
    pkgGoDevUrl: `https://pkg.go.dev/${modulePath}`,
    url: `${GOPROXY_BASE}/${encoded}/@latest`,
  };
}

export function mapGoProxyVersionRows(
  modulePath: string,
  versions: string[],
  limit: number,
): Array<Record<string, unknown>> {
  const encoded = encodeModulePath(modulePath);
  const sorted = sortGoVersionsDescending(versions).slice(0, limit);
  if (sorted.length === 0) {
    throw new Error(
      `"${modulePath}" has no semver-shaped tags on proxy.golang.org.`,
    );
  }
  return sorted.map((version, index) => ({
    rank: index + 1,
    module: modulePath,
    version,
    publishedAt: null,
    url: `${GOPROXY_BASE}/${encoded}/@v/${encodeURIComponent(version)}.info`,
  }));
}

async function fetchGoProxy(url: string, label: string): Promise<Response> {
  const response = await fetch(url, {
    headers: { "User-Agent": "unicli (https://github.com/olo-dot-io/Uni-CLI)" },
  });
  if (response.status === 404 || response.status === 410)
    throw new Error(`${label} returned no result.`);
  if (response.status === 429) throw new Error(`${label} returned HTTP 429.`);
  if (!response.ok)
    throw new Error(`${label} returned HTTP ${response.status}.`);
  return response;
}

cli({
  site: "goproxy",
  name: "module",
  description: "Latest version and VCS origin metadata for a Go module",
  domain: "proxy.golang.org",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "module",
      type: "str",
      required: true,
      positional: true,
      description: "Go module path",
    },
  ],
  columns: [
    "module",
    "version",
    "publishedAt",
    "vcs",
    "repository",
    "commit",
    "ref",
    "pkgGoDevUrl",
    "url",
  ],
  func: async (_page, kwargs) => {
    const modulePath = requireGoModulePath(kwargs.module);
    const response = await fetchGoProxy(
      `${GOPROXY_BASE}/${encodeModulePath(modulePath)}/@latest`,
      `goproxy module ${modulePath}`,
    );
    return [
      mapGoProxyModuleRow(modulePath, (await response.json()) as GoProxyLatest),
    ];
  },
});

cli({
  site: "goproxy",
  name: "versions",
  description: "Published version tags for a Go module",
  domain: "proxy.golang.org",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "module",
      type: "str",
      required: true,
      positional: true,
      description: "Go module path",
    },
    {
      name: "limit",
      type: "int",
      default: 30,
      description: "Max rows",
    },
  ],
  columns: ["rank", "module", "version", "publishedAt", "url"],
  func: async (_page, kwargs) => {
    const modulePath = requireGoModulePath(kwargs.module);
    const limit = requireGoProxyLimit(kwargs.limit);
    const response = await fetchGoProxy(
      `${GOPROXY_BASE}/${encodeModulePath(modulePath)}/@v/list`,
      `goproxy versions ${modulePath}`,
    );
    const versions = (await response.text())
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (versions.length === 0) {
      throw new Error(
        `proxy.golang.org returned no published versions for "${modulePath}".`,
      );
    }
    return mapGoProxyVersionRows(modulePath, versions, limit);
  },
});
