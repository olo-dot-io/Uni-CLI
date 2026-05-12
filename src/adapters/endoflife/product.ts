/**
 * @owner   src/adapters/endoflife/product.ts
 * @does    Register agent-facing endoflife.date product lifecycle command.
 * @needs   endoflife.date public API, product slug validation, date/flag normalization.
 * @feeds   surface coverage ledger, product support lifecycle rows, version planning data.
 * @breaks  endoflife.date API drift, weak slug validation, or silent empty rows hide lifecycle data failures.
 */

import { cli, Strategy } from "../../registry.js";

const API_BASE = "https://endoflife.date/api";
const PRODUCT_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;

export function requireEndoflifeProduct(value: unknown): string {
  const product = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!product) throw new Error("endoflife product cannot be empty.");
  if (!PRODUCT_RE.test(product)) {
    throw new Error(
      `endoflife product "${String(value)}" is not a valid slug.`,
    );
  }
  return product;
}

export function normalizeEndoflifeDateOrFlag(value: unknown): string | null {
  if (value === true) return "ongoing";
  if (value === false || value == null) return null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function mapEndoflifeRows(
  product: string,
  cycles: Array<Record<string, unknown>>,
  today: string,
): Array<Record<string, unknown>> {
  return cycles.map((cycle) => {
    const eol = normalizeEndoflifeDateOrFlag(cycle.eol);
    const eolStatus =
      eol === "ongoing"
        ? "ongoing"
        : typeof eol === "string" && eol >= today
          ? "active"
          : typeof eol === "string"
            ? "eol"
            : null;
    return {
      product,
      cycle: stringField(cycle.cycle),
      releaseDate: stringField(cycle.releaseDate),
      latest: stringField(cycle.latest),
      latestReleaseDate: stringField(cycle.latestReleaseDate),
      lts: normalizeEndoflifeDateOrFlag(cycle.lts),
      support: normalizeEndoflifeDateOrFlag(cycle.support),
      eol,
      extendedSupport: normalizeEndoflifeDateOrFlag(cycle.extendedSupport),
      eolStatus,
      url: `https://endoflife.date/${product}`,
    };
  });
}

async function fetchJson(url: URL | string, label: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "unicli-endoflife (https://github.com/olo-dot-io/Uni-CLI)",
    },
  });
  if (response.status === 404) throw new Error(`${label} returned no result.`);
  if (response.status === 429) throw new Error(`${label} returned HTTP 429.`);
  if (!response.ok)
    throw new Error(`${label} returned HTTP ${response.status}.`);
  return response.json();
}

cli({
  site: "endoflife",
  name: "product",
  description: "Release cycles and support dates for an endoflife.date product",
  domain: "endoflife.date",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "product",
      type: "str",
      required: true,
      positional: true,
      description: "endoflife.date product slug",
    },
  ],
  columns: [
    "product",
    "cycle",
    "releaseDate",
    "latest",
    "latestReleaseDate",
    "lts",
    "support",
    "eol",
    "extendedSupport",
    "eolStatus",
    "url",
  ],
  func: async (_page, kwargs) => {
    const product = requireEndoflifeProduct(kwargs.product);
    const body = await fetchJson(
      `${API_BASE}/${encodeURIComponent(product)}.json`,
      "endoflife product",
    );
    const rows = mapEndoflifeRows(
      product,
      Array.isArray(body) ? (body as Array<Record<string, unknown>>) : [],
      new Date().toISOString().slice(0, 10),
    );
    if (rows.length === 0) {
      throw new Error(`endoflife product returned no cycles for "${product}".`);
    }
    return rows;
  },
});
