/**
 * @owner   src/adapters/nvd/cve.ts
 * @does    Register agent-facing NVD CVE lookup command.
 * @needs   Public NVD CVE API 2.0, TypeScript adapter loader, CVE id validation.
 * @feeds   surface coverage ledger, vulnerability intelligence command surface, agent-readable CVE rows.
 * @breaks  NVD API envelope drift, weak CVE parsing, or silent empty rows hide vulnerability lookup failures.
 */

import { cli, Strategy } from "../../registry.js";

const NVD_BASE = "https://services.nvd.nist.gov/rest/json/cves/2.0";
const CVE_ID_RE = /^CVE-\d{4}-\d{4,}$/i;

interface NvdDescription {
  lang?: unknown;
  value?: unknown;
}

interface NvdMetric {
  type?: unknown;
  baseSeverity?: unknown;
  cvssData?: {
    baseScore?: unknown;
    baseSeverity?: unknown;
    attackVector?: unknown;
  };
}

interface NvdCve {
  id?: unknown;
  published?: unknown;
  lastModified?: unknown;
  vulnStatus?: unknown;
  descriptions?: NvdDescription[];
  metrics?: {
    cvssMetricV31?: NvdMetric[];
    cvssMetricV30?: NvdMetric[];
    cvssMetricV2?: NvdMetric[];
  };
  weaknesses?: Array<{
    description?: Array<{
      value?: unknown;
    }>;
  }>;
  cisaExploitAdd?: unknown;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function requireCveId(value: unknown): string {
  const id = String(value ?? "")
    .trim()
    .toUpperCase();
  if (!id) throw new Error("nvd CVE id is required.");
  if (!CVE_ID_RE.test(id)) {
    throw new Error(
      `nvd CVE id "${String(value)}" is not a valid CVE identifier.`,
    );
  }
  return id;
}

function pickEnglishDescription(
  descriptions: NvdDescription[] | undefined,
): string {
  if (!Array.isArray(descriptions)) return "";
  const english = descriptions.find((description) => description.lang === "en");
  return stringField(english?.value ?? descriptions[0]?.value).trim();
}

function pickPrimaryCvss(metrics: NvdCve["metrics"]): NvdMetric | null {
  if (!metrics || typeof metrics !== "object") return null;
  const candidates = [
    ...(Array.isArray(metrics.cvssMetricV31) ? metrics.cvssMetricV31 : []),
    ...(Array.isArray(metrics.cvssMetricV30) ? metrics.cvssMetricV30 : []),
    ...(Array.isArray(metrics.cvssMetricV2) ? metrics.cvssMetricV2 : []),
  ];
  return (
    candidates.find((metric) => metric.type === "Primary") ??
    candidates[0] ??
    null
  );
}

function joinCwes(weaknesses: NvdCve["weaknesses"]): string {
  if (!Array.isArray(weaknesses)) return "";
  const ids = new Set<string>();
  for (const weakness of weaknesses) {
    for (const description of weakness.description ?? []) {
      const value = stringField(description.value);
      if (value) ids.add(value);
    }
  }
  return [...ids].join(", ");
}

export function mapNvdCveRow(
  cve: NvdCve,
  requestedId: string,
): Record<string, unknown> {
  if (!cve.id) throw new Error(`NVD has no record for "${requestedId}".`);
  const cvss = pickPrimaryCvss(cve.metrics);
  const cvssData = cvss?.cvssData ?? {};
  return {
    id: stringField(cve.id),
    published: stringField(cve.published).slice(0, 10),
    lastModified: stringField(cve.lastModified).slice(0, 10),
    vulnStatus: stringField(cve.vulnStatus),
    baseScore: numberField(cvssData.baseScore),
    severity:
      stringField(cvssData.baseSeverity) || stringField(cvss?.baseSeverity),
    attackVector: stringField(cvssData.attackVector),
    cwe: joinCwes(cve.weaknesses),
    kevAdded: cve.cisaExploitAdd
      ? stringField(cve.cisaExploitAdd).slice(0, 10)
      : "",
    description: pickEnglishDescription(cve.descriptions),
    url: `https://nvd.nist.gov/vuln/detail/${String(cve.id)}`,
  };
}

async function fetchNvdJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "unicli (https://github.com/olo-dot-io/Uni-CLI)",
      Accept: "application/json",
    },
  });
  if (response.status === 403) throw new Error("nvd cve returned HTTP 403.");
  if (response.status === 429) throw new Error("nvd cve returned HTTP 429.");
  if (!response.ok)
    throw new Error(`nvd cve returned HTTP ${response.status}.`);
  return response.json();
}

cli({
  site: "nvd",
  name: "cve",
  description: "NIST NVD CVE detail",
  domain: "services.nvd.nist.gov",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "id",
      type: "str",
      required: true,
      positional: true,
      description: "CVE identifier",
    },
  ],
  columns: [
    "id",
    "published",
    "lastModified",
    "vulnStatus",
    "baseScore",
    "severity",
    "attackVector",
    "cwe",
    "kevAdded",
    "description",
    "url",
  ],
  func: async (_page, kwargs) => {
    const id = requireCveId(kwargs.id);
    const body = (await fetchNvdJson(
      `${NVD_BASE}?cveId=${encodeURIComponent(id)}`,
    )) as {
      vulnerabilities?: Array<{ cve?: NvdCve }>;
    };
    const cve = Array.isArray(body.vulnerabilities)
      ? body.vulnerabilities[0]?.cve
      : undefined;
    return [mapNvdCveRow(cve ?? {}, id)];
  },
});
