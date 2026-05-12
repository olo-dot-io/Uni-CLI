/**
 * @owner   src/adapters/osv/security.ts
 * @does    Register agent-facing OSV.dev package query and vulnerability detail commands.
 * @needs   Public OSV.dev API, TypeScript adapter loader, bounded argument parsing.
 * @feeds   surface coverage ledger, vulnerability intelligence command surface, agent-readable OSV rows.
 * @breaks  OSV API envelope drift, weak ecosystem/id validation, or silent empty rows hide vulnerability lookup failures.
 */

import { cli, Strategy } from "../../registry.js";

const OSV_BASE = "https://api.osv.dev";
const VULN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const OSV_ECOSYSTEMS = new Set([
  "npm",
  "PyPI",
  "Go",
  "Maven",
  "NuGet",
  "RubyGems",
  "crates.io",
  "Packagist",
  "Pub",
  "Hex",
  "Hackage",
  "CRAN",
  "Bitnami",
  "GitHub Actions",
  "SwiftURL",
]);

interface OsvVulnerability {
  id?: unknown;
  summary?: unknown;
  aliases?: unknown[];
  published?: unknown;
  modified?: unknown;
  database_specific?: {
    severity?: unknown;
    cwe_ids?: unknown[];
  };
  severity?: Array<{
    score?: unknown;
  }>;
  affected?: Array<{
    package?: {
      ecosystem?: unknown;
      name?: unknown;
    };
  }>;
  references?: unknown[];
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

export function requireOsvString(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`osv ${label} cannot be empty.`);
  return text;
}

export function requireOsvVulnerabilityId(value: unknown): string {
  const id = String(value ?? "").trim();
  if (!id) throw new Error("osv vulnerability id is required.");
  if (!VULN_ID_RE.test(id)) {
    throw new Error(`osv vulnerability id "${String(value)}" is not valid.`);
  }
  return id;
}

export function requireOsvEcosystem(value: unknown): string {
  const ecosystem = String(value ?? "").trim();
  if (!ecosystem) throw new Error("osv ecosystem is required.");
  if (!OSV_ECOSYSTEMS.has(ecosystem)) {
    throw new Error(`osv ecosystem "${String(value)}" is not recognised.`);
  }
  return ecosystem;
}

export function requireOsvLimit(value: unknown, fallback = 30): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 200) {
    throw new Error(
      `osv limit must be an integer in [1, 200]. Got: ${String(value)}`,
    );
  }
  return n;
}

function severityLabel(vuln: OsvVulnerability): string | null {
  const dbSeverity = vuln.database_specific?.severity;
  if (typeof dbSeverity === "string" && dbSeverity.trim())
    return dbSeverity.trim();
  for (const entry of Array.isArray(vuln.severity) ? vuln.severity : []) {
    const score = stringField(entry.score).trim();
    if (score) return score;
  }
  return null;
}

function aliases(vuln: OsvVulnerability): string {
  return Array.isArray(vuln.aliases)
    ? vuln.aliases.map(stringField).filter(Boolean).join(", ")
    : "";
}

function affectedPackages(vuln: OsvVulnerability): string {
  return (Array.isArray(vuln.affected) ? vuln.affected : [])
    .map((item) => {
      const ecosystem = stringField(item.package?.ecosystem);
      const name = stringField(item.package?.name);
      return ecosystem && name ? `${ecosystem}:${name}` : "";
    })
    .filter(Boolean)
    .join(", ");
}

export function mapOsvQueryRows(
  vulns: OsvVulnerability[],
  limit: number,
): Array<Record<string, unknown>> {
  const sorted = vulns
    .slice()
    .sort((a, b) =>
      stringField(b.published).localeCompare(stringField(a.published)),
    )
    .slice(0, limit);
  return sorted.map((vuln, index) => ({
    rank: index + 1,
    id: stringField(vuln.id),
    summary: stringField(vuln.summary).trim(),
    severity: severityLabel(vuln),
    aliases: aliases(vuln),
    published: trimDate(vuln.published),
    modified: trimDate(vuln.modified),
    affectedPackages: affectedPackages(vuln),
    url: vuln.id ? `https://osv.dev/vulnerability/${String(vuln.id)}` : "",
  }));
}

export function mapOsvVulnerabilityRow(
  vuln: OsvVulnerability,
): Record<string, unknown> {
  if (!vuln.id) throw new Error("OSV.dev returned no vulnerability record.");
  const cwes = Array.isArray(vuln.database_specific?.cwe_ids)
    ? vuln.database_specific.cwe_ids.map(stringField).filter(Boolean).join(", ")
    : "";
  return {
    id: stringField(vuln.id),
    summary: stringField(vuln.summary).trim(),
    severity: severityLabel(vuln),
    aliases: aliases(vuln),
    published: trimDate(vuln.published),
    modified: trimDate(vuln.modified),
    affectedPackages: affectedPackages(vuln),
    cwes,
    referenceCount: Array.isArray(vuln.references) ? vuln.references.length : 0,
    url: `https://osv.dev/vulnerability/${String(vuln.id)}`,
  };
}

async function fetchOsvJson(
  url: string,
  label: string,
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "User-Agent": "unicli (https://github.com/olo-dot-io/Uni-CLI)",
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 404) throw new Error(`${label} returned no result.`);
  if (response.status === 429) throw new Error(`${label} returned HTTP 429.`);
  if (!response.ok)
    throw new Error(`${label} returned HTTP ${response.status}.`);
  return response.json();
}

cli({
  site: "osv",
  name: "query",
  description: "OSV.dev vulnerabilities affecting a package",
  domain: "osv.dev",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "package",
      type: "str",
      required: true,
      positional: true,
      description: "Package name",
    },
    {
      name: "ecosystem",
      type: "str",
      required: true,
      description: "OSV ecosystem",
    },
    {
      name: "version",
      type: "str",
      description: "Specific package version",
    },
    {
      name: "limit",
      type: "int",
      default: 30,
      description: "Max rows",
    },
  ],
  columns: [
    "rank",
    "id",
    "summary",
    "severity",
    "aliases",
    "published",
    "modified",
    "affectedPackages",
    "url",
  ],
  func: async (_page, kwargs) => {
    const name = requireOsvString(kwargs.package, "package");
    const ecosystem = requireOsvEcosystem(kwargs.ecosystem);
    const limit = requireOsvLimit(kwargs.limit);
    const payload: Record<string, unknown> = { package: { name, ecosystem } };
    const version = String(kwargs.version ?? "").trim();
    if (version) payload.version = version;
    const body = (await fetchOsvJson(
      `${OSV_BASE}/v1/query`,
      `osv query ${ecosystem}:${name}`,
      payload,
    )) as {
      vulns?: OsvVulnerability[];
    };
    const vulns = Array.isArray(body.vulns) ? body.vulns : [];
    if (vulns.length === 0) {
      throw new Error(
        `OSV.dev returned no vulnerabilities for ${ecosystem}:${name}.`,
      );
    }
    return mapOsvQueryRows(vulns, limit);
  },
});

cli({
  site: "osv",
  name: "vulnerability",
  description: "Single OSV.dev vulnerability detail",
  domain: "osv.dev",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "id",
      type: "str",
      required: true,
      positional: true,
      description: "OSV vulnerability id",
    },
  ],
  columns: [
    "id",
    "summary",
    "severity",
    "aliases",
    "published",
    "modified",
    "affectedPackages",
    "cwes",
    "referenceCount",
    "url",
  ],
  func: async (_page, kwargs) => {
    const id = requireOsvVulnerabilityId(kwargs.id);
    const vuln = (await fetchOsvJson(
      `${OSV_BASE}/v1/vulns/${encodeURIComponent(id)}`,
      `osv vulnerability ${id}`,
    )) as OsvVulnerability;
    return [mapOsvVulnerabilityRow(vuln)];
  },
});
