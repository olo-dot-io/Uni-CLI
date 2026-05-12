/**
 * @owner   src/adapters/oeis/sequences.ts
 * @does    Register agent-facing OEIS sequence search and detail commands.
 * @needs   OEIS public JSON search endpoint, bounded pagination, sequence id validation.
 * @feeds   surface coverage ledger, integer sequence search rows, OEIS detail summaries.
 * @breaks  OEIS API drift, weak A-number parsing, or silent empty rows hide sequence lookup failures.
 */

import { cli, Strategy } from "../../registry.js";

const API_BASE = "https://oeis.org";
const SEQUENCE_ID_RE = /^A\d{1,7}$/;

function requireNonEmpty(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`oeis ${label} cannot be empty.`);
  return text;
}

export function requireOeisLimit(value: unknown): number {
  const raw =
    value === undefined || value === null || value === "" ? 10 : value;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("oeis limit must be an integer in [1, 100].");
  }
  return limit;
}

export function requireOeisSequenceId(value: unknown): string {
  const raw = String(value ?? "")
    .trim()
    .toUpperCase();
  if (!raw) throw new Error("oeis sequence id cannot be empty.");
  const id = raw
    .replace(/^HTTPS?:\/\/(?:WWW\.)?OEIS\.ORG\//i, "")
    .replace(/\/.*$/, "");
  if (!SEQUENCE_ID_RE.test(id)) {
    throw new Error(
      `oeis sequence id "${String(value)}" is not a valid A-number.`,
    );
  }
  return id;
}

export function formatOeisId(value: unknown): string {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) return "";
  return `A${String(number).padStart(6, "0")}`;
}

export function previewOeisTerms(value: unknown, max = 12): string {
  if (typeof value !== "string") return "";
  const terms = value
    .split(",")
    .map((term) => term.trim())
    .filter(Boolean);
  return terms.length > max
    ? [...terms.slice(0, max), `(+${terms.length - max})`].join(", ")
    : terms.join(", ");
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberField(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  return Number.isFinite(n) ? n : null;
}

function countArray(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

export function mapOeisSearchRows(
  rows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return rows.map((row, index) => {
    const id = formatOeisId(row.number);
    return {
      rank: index + 1,
      id,
      name: stringField(row.name),
      keywords: stringField(row.keyword),
      preview: previewOeisTerms(row.data),
      author: stringField(row.author),
      created: stringField(row.created),
      url: id ? `${API_BASE}/${id}` : "",
    };
  });
}

export function mapOeisSequenceRow(
  row: Record<string, unknown>,
  fallbackId: string,
): Record<string, unknown> {
  const id = formatOeisId(row.number) || fallbackId;
  const data = stringField(row.data);
  const termCount = data ? data.split(",").filter(Boolean).length : 0;
  return {
    id,
    name: stringField(row.name),
    keywords: stringField(row.keyword),
    preview: previewOeisTerms(data),
    termCount,
    offset: stringField(row.offset),
    author: stringField(row.author),
    created: stringField(row.created),
    revision: numberField(row.revision),
    commentCount: countArray(row.comment),
    formulaCount: countArray(row.formula),
    referenceCount: countArray(row.reference),
    xrefCount: countArray(row.xref),
    linkCount: countArray(row.link),
    url: `${API_BASE}/${id}`,
  };
}

async function fetchJson(url: URL | string, label: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "unicli-oeis (https://github.com/olo-dot-io/Uni-CLI)",
    },
  });
  if (response.status === 404) throw new Error(`${label} returned no result.`);
  if (response.status === 429) throw new Error(`${label} returned HTTP 429.`);
  if (!response.ok)
    throw new Error(`${label} returned HTTP ${response.status}.`);
  return response.json();
}

cli({
  site: "oeis",
  name: "search",
  description: "Search OEIS sequences by keyword or numeric pattern",
  domain: "oeis.org",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "query",
      type: "str",
      required: true,
      positional: true,
      description: "Keyword or comma-separated terms",
    },
    { name: "limit", type: "int", default: 10, description: "Max rows" },
  ],
  columns: [
    "rank",
    "id",
    "name",
    "keywords",
    "preview",
    "author",
    "created",
    "url",
  ],
  func: async (_page, kwargs) => {
    const query = requireNonEmpty(kwargs.query, "query");
    const limit = requireOeisLimit(kwargs.limit);
    const collected: Array<Record<string, unknown>> = [];
    for (let start = 0; collected.length < limit; start += 10) {
      const url = new URL(`${API_BASE}/search`);
      url.searchParams.set("q", query);
      url.searchParams.set("fmt", "json");
      url.searchParams.set("start", String(start));
      const body = await fetchJson(url, "oeis search");
      const page = Array.isArray(body)
        ? (body as Array<Record<string, unknown>>)
        : [];
      if (page.length === 0) break;
      collected.push(...page.slice(0, limit - collected.length));
      if (page.length < 10) break;
    }
    const rows = mapOeisSearchRows(collected);
    if (rows.length === 0)
      throw new Error(`oeis search returned no rows for "${query}".`);
    return rows;
  },
});

cli({
  site: "oeis",
  name: "sequence",
  description: "Fetch OEIS sequence detail by A-number",
  domain: "oeis.org",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "id",
      type: "str",
      required: true,
      positional: true,
      description: "OEIS A-number",
    },
  ],
  columns: [
    "id",
    "name",
    "keywords",
    "preview",
    "termCount",
    "offset",
    "author",
    "created",
    "revision",
    "commentCount",
    "formulaCount",
    "referenceCount",
    "xrefCount",
    "linkCount",
    "url",
  ],
  func: async (_page, kwargs) => {
    const id = requireOeisSequenceId(kwargs.id);
    const url = new URL(`${API_BASE}/search`);
    url.searchParams.set("q", `id:${id}`);
    url.searchParams.set("fmt", "json");
    const body = await fetchJson(url, "oeis sequence");
    const list = Array.isArray(body)
      ? (body as Array<Record<string, unknown>>)
      : [];
    if (list.length === 0)
      throw new Error(`oeis sequence returned no row for "${id}".`);
    return [mapOeisSequenceRow(list[0] ?? {}, id)];
  },
});
