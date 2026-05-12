/**
 * @owner   src/adapters/openfda/records.ts
 * @does    Register agent-facing openFDA drug label and food recall commands.
 * @needs   openFDA public API, bounded limits, explicit query encoding.
 * @feeds   surface coverage ledger, FDA drug label rows, FDA food recall rows.
 * @breaks  openFDA API drift, malformed Lucene filters, or silent empty rows hide FDA records.
 */

import { cli, Strategy } from "../../registry.js";

const API_BASE = "https://api.fda.gov";

function requireNonEmpty(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`openfda ${label} cannot be empty.`);
  return text;
}

export function requireOpenfdaLimit(
  value: unknown,
  fallback: number,
  max: number,
): number {
  const raw =
    value === undefined || value === null || value === "" ? fallback : value;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > max) {
    throw new Error(`openfda limit must be an integer in [1, ${max}].`);
  }
  return limit;
}

export function firstOpenfdaValue(value: unknown): unknown {
  if (!Array.isArray(value) || value.length === 0) return null;
  const first = value[0];
  return typeof first === "string" ? first.trim() || null : (first ?? null);
}

export function joinOpenfdaValues(value: unknown, max = 5): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.slice(0, max).map(String).join(", ");
}

function objectField(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function buildFoodRecallSearch(filters: {
  classification?: unknown;
  query?: unknown;
  status?: unknown;
}): string {
  const parts: string[] = [];
  if (filters.query) parts.push(String(filters.query).trim());
  if (filters.status) parts.push(`status:"${String(filters.status).trim()}"`);
  if (filters.classification) {
    parts.push(`classification:"${String(filters.classification).trim()}"`);
  }
  return parts.map((part) => encodeURIComponent(part)).join("+AND+");
}

export function mapDrugLabelRows(
  rows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return rows.map((row, index) => {
    const openfda = objectField(row.openfda);
    const pharmClass =
      firstOpenfdaValue(openfda.pharm_class_epc) ??
      firstOpenfdaValue(openfda.pharm_class_moa) ??
      firstOpenfdaValue(openfda.pharm_class_cs) ??
      firstOpenfdaValue(openfda.pharm_class_pe);
    return {
      rank: index + 1,
      id: stringOrNull(row.id),
      brandName: firstOpenfdaValue(openfda.brand_name),
      genericName: firstOpenfdaValue(openfda.generic_name),
      manufacturer: firstOpenfdaValue(openfda.manufacturer_name),
      productType: firstOpenfdaValue(openfda.product_type),
      route: joinOpenfdaValues(openfda.route),
      productNdc: firstOpenfdaValue(openfda.product_ndc),
      pharmClass,
      purpose: firstOpenfdaValue(row.purpose),
      indications: firstOpenfdaValue(row.indications_and_usage),
      warnings: firstOpenfdaValue(row.warnings),
      dosage: firstOpenfdaValue(row.dosage_and_administration),
      effectiveTime: stringOrNull(row.effective_time),
    };
  });
}

export function mapFoodRecallRows(
  rows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return rows.map((row, index) => ({
    rank: index + 1,
    recallNumber: stringOrNull(row.recall_number),
    status: stringOrNull(row.status),
    classification: stringOrNull(row.classification),
    voluntary: stringOrNull(row.voluntary_mandated),
    recallingFirm: stringOrNull(row.recalling_firm),
    city: stringOrNull(row.city),
    state: stringOrNull(row.state),
    country: stringOrNull(row.country),
    productDescription: stringOrNull(row.product_description),
    reasonForRecall: stringOrNull(row.reason_for_recall),
    productQuantity: stringOrNull(row.product_quantity),
    distributionPattern: stringOrNull(row.distribution_pattern),
    reportDate: stringOrNull(row.report_date),
    recallInitiationDate: stringOrNull(row.recall_initiation_date),
    terminationDate: stringOrNull(row.termination_date),
  }));
}

async function fetchJson(url: URL | string, label: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "unicli-openfda (https://github.com/olo-dot-io/Uni-CLI)",
    },
  });
  if (response.status === 404) throw new Error(`${label} returned no result.`);
  if (response.status === 429) throw new Error(`${label} returned HTTP 429.`);
  if (!response.ok)
    throw new Error(`${label} returned HTTP ${response.status}.`);
  return response.json();
}

cli({
  site: "openfda",
  name: "drug-label",
  description: "Search FDA drug labels by brand or generic name",
  domain: "fda.gov",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "query",
      type: "str",
      required: true,
      positional: true,
      description: "Brand or generic drug name",
    },
    { name: "limit", type: "int", default: 5, description: "Max rows" },
  ],
  columns: [
    "rank",
    "id",
    "brandName",
    "genericName",
    "manufacturer",
    "productType",
    "route",
    "productNdc",
    "pharmClass",
    "purpose",
    "indications",
    "warnings",
    "dosage",
    "effectiveTime",
  ],
  func: async (_page, kwargs) => {
    const query = requireNonEmpty(kwargs.query, "query");
    const limit = requireOpenfdaLimit(kwargs.limit, 5, 25);
    const brand = encodeURIComponent(`openfda.brand_name:"${query}"`);
    const generic = encodeURIComponent(`openfda.generic_name:"${query}"`);
    const body = (await fetchJson(
      `${API_BASE}/drug/label.json?search=${brand}+OR+${generic}&limit=${limit}`,
      "openfda drug-label",
    )) as { results?: unknown };
    const rows = mapDrugLabelRows(
      Array.isArray(body.results)
        ? (body.results as Array<Record<string, unknown>>)
        : [],
    );
    if (rows.length === 0) {
      throw new Error(`openfda drug-label returned no rows for "${query}".`);
    }
    return rows;
  },
});

cli({
  site: "openfda",
  name: "food-recall",
  description: "Search FDA food recall and enforcement actions",
  domain: "fda.gov",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "query", type: "str", description: "Free-text Lucene query" },
    { name: "status", type: "str", description: "Recall status" },
    {
      name: "classification",
      type: "str",
      description: "Recall classification",
    },
    { name: "limit", type: "int", default: 10, description: "Max rows" },
  ],
  columns: [
    "rank",
    "recallNumber",
    "status",
    "classification",
    "voluntary",
    "recallingFirm",
    "city",
    "state",
    "country",
    "productDescription",
    "reasonForRecall",
    "productQuantity",
    "distributionPattern",
    "reportDate",
    "recallInitiationDate",
    "terminationDate",
  ],
  func: async (_page, kwargs) => {
    const limit = requireOpenfdaLimit(kwargs.limit, 10, 100);
    const search = buildFoodRecallSearch(kwargs);
    const qs = search ? `search=${search}&limit=${limit}` : `limit=${limit}`;
    const body = (await fetchJson(
      `${API_BASE}/food/enforcement.json?${qs}`,
      "openfda food-recall",
    )) as { results?: unknown };
    const rows = mapFoodRecallRows(
      Array.isArray(body.results)
        ? (body.results as Array<Record<string, unknown>>)
        : [],
    );
    if (rows.length === 0) {
      throw new Error("openfda food-recall returned no rows for the filter.");
    }
    return rows;
  },
});
