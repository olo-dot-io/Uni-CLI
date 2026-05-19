/**
 * @owner       src::adapters::pmlr::proceedings
 * @does        Registers Proceedings of Machine Learning Research volume search using official citeproc.yaml metadata.
 * @needs       proceedings.mlr.press citeproc.yaml files, js-yaml, src/registry.ts
 * @feeds       src/commands/scholar.ts via scholar.search, scholar.get, scholar.pdf, and scholar.venue
 * @breaks      Missing volume metadata or citeproc drift surfaces as explicit adapter errors.
 * @invariants  Volume is explicit; rows are filtered locally from official YAML metadata, not scraped from rendered cards.
 * @side-effects HTTPS egress to proceedings.mlr.press only
 * @perf        O(N) over one proceedings volume
 * @concurrency safe
 * @test        tests/unit/adapters/scholar-sources.test.ts
 * @stability   experimental
 * @since       2026-05-19
 */

import yaml from "js-yaml";
import { cli, Strategy } from "../../registry.js";
import type { ScholarlyWorkRecord } from "../../types/scholarly.js";

interface PmlrEntry {
  title?: unknown;
  abstract?: unknown;
  URL?: unknown;
  PDF?: unknown;
  "container-title"?: unknown;
  author?: Array<{ given?: unknown; family?: unknown }>;
  id?: unknown;
  issued?: { "date-parts"?: unknown[] };
  volume?: unknown;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function authors(value: PmlrEntry["author"]): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .map((person) =>
      [person.given, person.family].map(str).filter(Boolean).join(" "),
    )
    .filter(Boolean);
  return out.length > 0 ? out : undefined;
}

function issuedYear(entry: PmlrEntry): number | undefined {
  const first = entry.issued?.["date-parts"]?.[0];
  return typeof first === "number" && Number.isFinite(first)
    ? first
    : undefined;
}

export function parsePmlrCiteproc(text: string): PmlrEntry[] {
  const parsed = yaml.load(text);
  return Array.isArray(parsed) ? (parsed as PmlrEntry[]) : [];
}

export function mapPmlrEntry(
  entry: PmlrEntry,
  source: string,
): ScholarlyWorkRecord {
  const id = str(entry.id);
  if (!id) throw new Error("PMLR entry did not include id.");
  return {
    id,
    title: str(entry.title),
    abstract: str(entry.abstract) || undefined,
    authors: authors(entry.author),
    year: issuedYear(entry),
    venue: str(entry["container-title"]) || undefined,
    type: entry.volume ? `pmlr:${String(entry.volume)}` : "pmlr",
    pdf_url: str(entry.PDF) || undefined,
    source_adapter: source,
    source_url: str(entry.URL) || undefined,
    retrieved_at: new Date().toISOString(),
  };
}

function requireVolume(value: unknown): string {
  const raw = String(value ?? "")
    .trim()
    .replace(/^v/i, "");
  if (!/^\d+$/.test(raw))
    throw new Error(`pmlr volume "${String(value)}" is not valid.`);
  return raw;
}

async function fetchVolume(volume: string): Promise<PmlrEntry[]> {
  const response = await fetch(
    `https://proceedings.mlr.press/v${volume}/assets/bib/citeproc.yaml`,
    {
      headers: {
        Accept: "application/x-yaml,text/yaml,text/plain",
        "User-Agent": "unicli-pmlr/1.0 (https://github.com/olo-dot-io/Uni-CLI)",
      },
    },
  );
  if (response.status === 404)
    throw new Error(`PMLR volume v${volume} returned no metadata.`);
  if (!response.ok)
    throw new Error(`PMLR volume v${volume} returned HTTP ${response.status}.`);
  return parsePmlrCiteproc(await response.text());
}

cli({
  site: "pmlr",
  name: "search",
  description: "Search a PMLR proceedings volume (e.g. v235 for ICML 2024)",
  domain: "proceedings.mlr.press",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "query", type: "str", required: true, positional: true },
    { name: "volume", type: "str", default: "235" },
    { name: "limit", type: "int", default: 20 },
  ],
  columns: ["id", "title", "authors", "year", "venue", "pdf_url", "source_url"],
  capabilities: [
    "http.fetch",
    "scholar.search",
    "scholar.venue",
    "scholar.pdf",
  ],
  func: async (_page, kwargs) => {
    const query = String(kwargs.query ?? "")
      .trim()
      .toLowerCase();
    if (!query) throw new Error("pmlr search query cannot be empty.");
    const volume = requireVolume(kwargs.volume);
    const limit = Math.min(Math.max(Number(kwargs.limit ?? 20), 1), 200);
    const rows = (await fetchVolume(volume))
      .map((entry) => mapPmlrEntry(entry, "pmlr"))
      .filter((row) =>
        `${row.title} ${row.abstract ?? ""} ${row.authors?.join(" ") ?? ""}`
          .toLowerCase()
          .includes(query),
      )
      .slice(0, limit);
    if (rows.length === 0)
      throw new Error(`No PMLR v${volume} papers matched "${query}".`);
    return rows;
  },
});

cli({
  site: "pmlr",
  name: "paper",
  description: "Fetch a PMLR paper by id inside a proceedings volume",
  domain: "proceedings.mlr.press",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "id", type: "str", required: true, positional: true },
    { name: "volume", type: "str", default: "235" },
  ],
  columns: ["id", "title", "authors", "year", "venue", "pdf_url", "source_url"],
  capabilities: ["http.fetch", "scholar.get", "scholar.pdf"],
  func: async (_page, kwargs) => {
    const id = String(kwargs.id ?? kwargs.ref ?? "").trim();
    if (!id) throw new Error("pmlr paper id is required.");
    const volume = requireVolume(kwargs.volume);
    const row = (await fetchVolume(volume))
      .map((entry) => mapPmlrEntry(entry, "pmlr"))
      .find((entry) => entry.id === id);
    if (!row)
      throw new Error(`No PMLR v${volume} paper found with id "${id}".`);
    return [row];
  },
});
