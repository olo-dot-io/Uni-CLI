/**
 * @owner   src/adapters/rfc/rfc.ts
 * @does    Register agent-facing IETF RFC metadata command.
 * @needs   IETF datatracker public API, strict RFC number validation, date normalization.
 * @feeds   surface coverage ledger, RFC metadata rows, standards cross-reference URLs.
 * @breaks  Datatracker API drift, weak number parsing, or silent empty rows hide RFC metadata failures.
 */

import { cli, Strategy } from "../../registry.js";

const API_BASE = "https://datatracker.ietf.org";

export function requireRfcNumber(value: unknown): number {
  const text = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^rfc/, "");
  if (!text) throw new Error("rfc number cannot be empty.");
  if (!/^\d+$/.test(text))
    throw new Error(`rfc number "${String(value)}" is not valid.`);
  const number = Number(text);
  if (!Number.isInteger(number) || number < 1 || number > 999_999) {
    throw new Error("rfc number must be an integer in [1, 999999].");
  }
  return number;
}

export function trimRfcDate(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
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

function objectField(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export function mapRfcRow(
  number: number,
  doc: Record<string, unknown>,
): Record<string, unknown> {
  const authors = Array.isArray(doc.authors)
    ? doc.authors
        .map((author) => stringField(objectField(author).name))
        .filter(Boolean)
        .join(", ")
    : "";
  const group = objectField(doc.group);
  const name = `rfc${number}`;
  return {
    rfc: number,
    title: stringField(doc.title),
    state: stringField(doc.state),
    stdLevel: stringField(doc.std_level),
    group: stringField(group.name),
    groupType: stringField(group.type),
    pages: numberField(doc.pages),
    published: trimRfcDate(doc.time),
    authors,
    abstract: stringField(doc.abstract),
    rfcEditorUrl: `https://www.rfc-editor.org/rfc/rfc${number}`,
    url: `${API_BASE}/doc/${name}/`,
  };
}

async function fetchJson(url: URL | string, label: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "unicli-rfc (https://github.com/olo-dot-io/Uni-CLI)",
    },
  });
  if (response.status === 404) throw new Error(`${label} returned no result.`);
  if (response.status === 429) throw new Error(`${label} returned HTTP 429.`);
  if (!response.ok)
    throw new Error(`${label} returned HTTP ${response.status}.`);
  return response.json();
}

cli({
  site: "rfc",
  name: "rfc",
  description: "Fetch IETF RFC metadata by RFC number",
  domain: "datatracker.ietf.org",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "number",
      type: "int",
      required: true,
      positional: true,
      description: "RFC number",
    },
  ],
  columns: [
    "rfc",
    "title",
    "state",
    "stdLevel",
    "group",
    "groupType",
    "pages",
    "published",
    "authors",
    "abstract",
    "rfcEditorUrl",
    "url",
  ],
  func: async (_page, kwargs) => {
    const number = requireRfcNumber(kwargs.number);
    const doc = objectField(
      await fetchJson(`${API_BASE}/doc/rfc${number}/doc.json`, "rfc rfc"),
    );
    if (!doc.name)
      throw new Error(`rfc rfc returned no metadata for RFC ${number}.`);
    return [mapRfcRow(number, doc)];
  },
});
