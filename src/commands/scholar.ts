/**
 * @owner       src::commands::scholar
 * @does        Top-level `unicli scholar` meta-command for academic source discovery: searches, retrieves, non-destructive availability audits, agent workflow/runbook planning, evidence/citation-safety classification, reproducibility/install planning, source coverage comparison, peer-review audit retrieval, PDF availability, source-direct full text, PDF artifact download/read, code/dataset/model resource lookup, citation/reference traversal, and doctor output across adapters tagged with `scholar.*` capabilities.
 * @needs       src/registry.ts, src/types/scholarly.ts, src/engine/kernel/execute.ts, src/output/formatter.ts
 * @feeds       src/cli.ts, MCP/agent command discovery via list/search/do
 * @breaks      Missing capability tags make scholarly sources invisible; unfiltered internal ArgBags violate adapter schemas; weak reference routing can send DOI/arXiv/PMID/OpenReview lookups to the wrong first source; weak canonicalized availability can leave title-based Agent runbooks blocked on explicit source subsets; weak workflow/evidence classification can invite citation from metadata-only rows; weak reproducibility planning can encourage running uninspected remote code; weak review command selection can return search rows instead of review-thread evidence; missing fulltext/PDF artifact adapter blocks read; missing resource output fields hide linked code/data.
 * @invariants  --sources default is a conservative first-source set; coverage audits inspect registered capabilities without network I/O; workflow and evidence classification are derived from availability rows and never download, execute, or summarize claims; availability/evidence/source-audit/workflow/reproduce may use canonical lookup sources only to resolve an unknown title before rerunning the caller's requested source scope; reproducibility planning never executes clone/install/run commands and requires repository inspection before install; review retrieval prefers forum/thread commands over search commands; resource commands default to sources exposing the requested resource capability; availability audits fetch metadata/PDF/resource evidence without writing artifacts; source-direct fulltext is tried before PDF artifacts for `scholar read`; unknown artifact refs use every scholar.pdf source; --sources all is registry capability discovery; DOI is the primary dedupe key; internal fan-out passes only args declared by the target command.
 * @side-effects Executes adapter commands through the engine kernel; source-direct fulltext may fetch remote XML; artifact subcommands may write PDFs and execute pdftotext through scholar-artifacts.
 * @perf        Fan-out is sequential today, O(S * R), where S is source count and R is rows per source.
 * @concurrency safe — Commander handlers run one at a time per process
 * @test        tests/unit/commands/scholar.test.ts
 * @stability   experimental
 * @since       2026-05-19
 */

import type { Command } from "commander";

import {
  commandStrategy,
  getAllAdapters,
  resolveCommand,
} from "../registry.js";
import { resolveArgs } from "../engine/args.js";
import { buildInvocation, execute } from "../engine/kernel/execute.js";
import { makeCtx } from "../output/envelope.js";
import { detectFormat, format } from "../output/formatter.js";
import { ExitCode, Strategy } from "../types.js";
import type {
  AdapterCommand,
  AdapterManifest,
  OutputFormat,
} from "../types.js";
import type {
  ScholarlyReferenceRoute,
  ScholarlyWorkRecord,
} from "../types/scholarly.js";

export const DEFAULT_SCHOLAR_SOURCES = [
  "semantic-scholar",
  "openalex",
  "crossref",
  "arxiv",
  "dblp",
  "pubmed",
] as const;

const CANONICAL_REFERENCE_SOURCES = [
  "semantic-scholar",
  "openalex",
  "crossref",
  "arxiv",
  "pubmed",
  "openreview",
  "huggingface-papers",
  "hf",
  "biorxiv",
  "medrxiv",
] as const;

export const SCHOLAR_CAPABILITIES = [
  "scholar.search",
  "scholar.get",
  "scholar.pdf",
  "scholar.citations",
  "scholar.references",
  "scholar.venue",
  "scholar.author",
  "scholar.datasets",
  "scholar.code",
  "scholar.review",
  "scholar.fulltext",
] as const;

export type ScholarCapability = (typeof SCHOLAR_CAPABILITIES)[number];

const SINGLE_RECORD_ARG_NAMES = new Set([
  "id",
  "ref",
  "doi",
  "arxiv_id",
  "pmid",
  "key",
  "forum",
]);

function hasAnyScholarCapability(adapter: AdapterManifest): boolean {
  return Object.values(adapter.commands).some((command) =>
    (command.capabilities ?? []).some((cap) => cap.startsWith("scholar.")),
  );
}

function isSingleRecordScholarCommand(command: AdapterCommand): boolean {
  if ((command.capabilities ?? []).includes("scholar.get")) return true;
  return (command.adapterArgs ?? []).some(
    (arg) => arg.required === true && SINGLE_RECORD_ARG_NAMES.has(arg.name),
  );
}

function declaresAdapterArg(command: AdapterCommand, name: string): boolean {
  return (command.adapterArgs ?? []).some((arg) => arg.name === name);
}

export function listScholarAdapters(): AdapterManifest[] {
  return getAllAdapters()
    .filter(hasAnyScholarCapability)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveScholarSources(
  sourcesArg: string | undefined,
  fallback: readonly string[] = DEFAULT_SCHOLAR_SOURCES,
): string[] {
  if (!sourcesArg || sourcesArg.trim().length === 0) return [...fallback];
  if (sourcesArg.trim() === "all")
    return listScholarAdapters().map((a) => a.name);
  return sourcesArg
    .split(",")
    .map((source) => source.trim())
    .filter(Boolean);
}

export function findScholarCommandByCapability(
  adapter: AdapterManifest,
  capability: ScholarCapability,
): { name: string; command: AdapterCommand } | undefined {
  const matches = Object.entries(adapter.commands).filter(([, command]) =>
    (command.capabilities ?? []).includes(capability),
  );
  if (
    capability === "scholar.pdf" ||
    capability === "scholar.code" ||
    capability === "scholar.datasets"
  ) {
    const singleRecord = matches.find(([, command]) =>
      isSingleRecordScholarCommand(command),
    );
    if (singleRecord) {
      return { name: singleRecord[0], command: singleRecord[1] };
    }
  }
  const first = matches[0];
  if (first) return { name: first[0], command: first[1] };
  return undefined;
}

function findScholarSingleRecordCommandByCapability(
  adapter: AdapterManifest,
  capability: Extract<ScholarCapability, "scholar.code" | "scholar.datasets">,
): { name: string; command: AdapterCommand } | undefined {
  const match = Object.entries(adapter.commands).find(
    ([, command]) =>
      (command.capabilities ?? []).includes(capability) &&
      isSingleRecordScholarCommand(command),
  );
  return match ? { name: match[0], command: match[1] } : undefined;
}

export function findScholarResourceSearchCommandByCapability(
  adapter: AdapterManifest,
  capability: Extract<ScholarCapability, "scholar.code" | "scholar.datasets">,
): { name: string; command: AdapterCommand } | undefined {
  const match = Object.entries(adapter.commands).find(([, command]) => {
    const capabilities = command.capabilities ?? [];
    return (
      capabilities.includes("scholar.search") &&
      capabilities.includes(capability) &&
      declaresAdapterArg(command, "query")
    );
  });
  if (!match) return undefined;
  return { name: match[0], command: match[1] };
}

export function findScholarQueryableSearchCommand(
  adapter: AdapterManifest,
): { name: string; command: AdapterCommand } | undefined {
  const match = Object.entries(adapter.commands).find(([, command]) => {
    const capabilities = command.capabilities ?? [];
    return (
      capabilities.includes("scholar.search") &&
      declaresAdapterArg(command, "query")
    );
  });
  if (!match) return undefined;
  return { name: match[0], command: match[1] };
}

export function findScholarReviewThreadCommand(
  adapter: AdapterManifest,
): { name: string; command: AdapterCommand } | undefined {
  const matches = Object.entries(adapter.commands).filter(([, command]) =>
    (command.capabilities ?? []).includes("scholar.review"),
  );
  const forumCommand = matches.find(([, command]) =>
    (command.adapterArgs ?? []).some(
      (arg) => arg.required === true && arg.name === "forum",
    ),
  );
  if (forumCommand) {
    return { name: forumCommand[0], command: forumCommand[1] };
  }
  const namedReviewCommand = matches.find(([name]) => /reviews?/i.test(name));
  if (namedReviewCommand) {
    return { name: namedReviewCommand[0], command: namedReviewCommand[1] };
  }
  const first = matches[0];
  if (first) return { name: first[0], command: first[1] };
  return undefined;
}

export function listScholarSourcesByCapability(
  capability: ScholarCapability,
): string[] {
  return listScholarAdapters()
    .filter((adapter) => findScholarCommandByCapability(adapter, capability))
    .map((adapter) => adapter.name);
}

function listScholarReviewSources(): string[] {
  return listScholarAdapters()
    .filter((adapter) => findScholarReviewThreadCommand(adapter))
    .map((adapter) => adapter.name);
}

function listSingleRecordScholarSourcesByCapability(
  capability: Extract<ScholarCapability, "scholar.code" | "scholar.datasets">,
): string[] {
  return listScholarAdapters()
    .filter((adapter) =>
      Boolean(findScholarSingleRecordCommandByCapability(adapter, capability)),
    )
    .map((adapter) => adapter.name);
}

function listResourceSearchScholarSourcesByCapability(
  capability: Extract<ScholarCapability, "scholar.code" | "scholar.datasets">,
): string[] {
  return listScholarAdapters()
    .filter((adapter) =>
      Boolean(
        findScholarResourceSearchCommandByCapability(adapter, capability),
      ),
    )
    .map((adapter) => adapter.name);
}

function listResourceDetailSourcesForSearchFallback(
  capability: Extract<ScholarCapability, "scholar.code" | "scholar.datasets">,
  opts: { source?: string; sources?: string },
): string[] {
  const singleRecordSources =
    listSingleRecordScholarSourcesByCapability(capability);
  if (opts.source) {
    return singleRecordSources.includes(opts.source) ? [opts.source] : [];
  }
  if (opts.sources) {
    return resolveScholarSources(opts.sources).filter((source) =>
      singleRecordSources.includes(source),
    );
  }
  return singleRecordSources;
}

function bareDoi(value: string): string {
  return value
    .trim()
    .replace(/^doi:/i, "")
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
}

function bareArxiv(value: string): string {
  return value
    .trim()
    .replace(/^arxiv:/i, "")
    .replace(/^https?:\/\/arxiv\.org\/(?:abs|pdf)\//i, "")
    .replace(/\.pdf$/i, "")
    .replace(/v\d+$/i, "");
}

export function resolveScholarReference(ref: string): ScholarlyReferenceRoute {
  const raw = ref.trim();
  const doi = bareDoi(raw);
  if (/^10\.\S+\/\S+/i.test(doi)) {
    return {
      kind: "doi",
      value: doi,
      preferredSources: [
        "openalex",
        "crossref",
        "semantic-scholar",
        "unpaywall",
        "biorxiv",
        "medrxiv",
      ],
    };
  }

  if (
    /^(?:arxiv:|https?:\/\/arxiv\.org\/(?:abs|pdf)\/|\d{4}\.\d{4,5})/i.test(raw)
  ) {
    return {
      kind: "arxiv",
      value: bareArxiv(raw),
      preferredSources: ["arxiv", "semantic-scholar", "openalex"],
    };
  }

  const pmid = raw.match(/^pmid:\s*(\d+)$/i);
  if (pmid) {
    return {
      kind: "pmid",
      value: pmid[1],
      preferredSources: ["pubmed", "semantic-scholar", "openalex"],
    };
  }

  const openReview = raw.match(
    /^(?:openreview:\s*|https?:\/\/openreview\.net\/forum\?id=)([A-Za-z0-9_-]{6,20})/i,
  );
  if (openReview) {
    return {
      kind: "openreview",
      value: openReview[1],
      preferredSources: ["openreview", "semantic-scholar", "openalex"],
    };
  }

  const openAlex = raw.match(
    /^(?:https?:\/\/(?:api\.)?openalex\.org\/)?(?:works\/)?(W\d{4,})$/i,
  );
  if (openAlex) {
    return {
      kind: "openalex",
      value: openAlex[1].toUpperCase(),
      preferredSources: ["openalex", "semantic-scholar", "crossref"],
    };
  }

  if (/^[a-f0-9]{40}$/i.test(raw)) {
    return {
      kind: "semantic-scholar",
      value: raw,
      preferredSources: ["semantic-scholar", "openalex", "crossref"],
    };
  }

  if (/^[a-z]+(?:\/[A-Za-z0-9_.-]+)+$/.test(raw)) {
    return {
      kind: "dblp",
      value: raw,
      preferredSources: ["dblp", "semantic-scholar", "openalex"],
    };
  }

  return {
    kind: "unknown",
    value: raw,
    preferredSources: [...DEFAULT_SCHOLAR_SOURCES],
  };
}

function dedupeKey(record: ScholarlyWorkRecord): string {
  if (record.doi) return `doi:${record.doi.toLowerCase()}`;
  if (record.arxiv_id) return `arxiv:${record.arxiv_id.toLowerCase()}`;
  if (record.pmid) return `pmid:${record.pmid}`;
  return `${record.source_adapter}:${record.id}`;
}

export function reciprocalRankFusion(
  rankedLists: ScholarlyWorkRecord[][],
  options: { k?: number; topN?: number } = {},
): ScholarlyWorkRecord[] {
  const k = options.k ?? 60;
  type Bucket = {
    score: number;
    record: ScholarlyWorkRecord;
    firstSeen: number;
  };
  const buckets = new Map<string, Bucket>();
  let order = 0;

  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank += 1) {
      const record = list[rank];
      const key = dedupeKey(record);
      const increment = 1 / (k + rank + 1);
      const existing = buckets.get(key);
      if (existing) {
        existing.score += increment;
      } else {
        buckets.set(key, { score: increment, record, firstSeen: order });
        order += 1;
      }
    }
  }

  const fused = [...buckets.values()].sort(
    (a, b) => b.score - a.score || a.firstSeen - b.firstSeen,
  );
  return (options.topN ? fused.slice(0, options.topN) : fused).map(
    (bucket) => bucket.record,
  );
}

function numberOpt(
  raw: string | undefined,
  fallback: number,
  max: number,
): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new Error(`limit must be an integer in [1, ${max}].`);
  }
  return n;
}

function coerceStringArray(value: unknown): string[] | undefined {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\s*(?:,|;|\n)\s*/)
      : [];
  const out = raw.map((item) => String(item ?? "").trim()).filter(Boolean);
  return out.length > 0 ? out : undefined;
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export function coerceToScholarlyRecords(
  rows: unknown,
  source: string,
): ScholarlyWorkRecord[] {
  if (!Array.isArray(rows)) return [];
  const out: ScholarlyWorkRecord[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.title !== "string") {
      continue;
    }
    const sourceUrl =
      typeof record.source_url === "string" && record.source_url.length > 0
        ? record.source_url
        : typeof record.url === "string" && record.url.length > 0
          ? record.url
          : undefined;
    const pdfUrl =
      typeof record.pdf_url === "string" && record.pdf_url.length > 0
        ? record.pdf_url
        : typeof record.pdf === "string" && record.pdf.length > 0
          ? record.pdf
          : undefined;
    const recordDate =
      typeof record.date === "string" && record.date.length > 0
        ? record.date
        : typeof record.pdate === "string" && record.pdate.length > 0
          ? record.pdate
          : typeof record.published === "string" && record.published.length > 0
            ? record.published
            : typeof record.publishedAt === "string" &&
                record.publishedAt.length > 0
              ? record.publishedAt
              : undefined;
    const work: ScholarlyWorkRecord = {
      id: record.id,
      title: record.title,
      source_adapter:
        typeof record.source_adapter === "string"
          ? record.source_adapter
          : source,
      retrieved_at:
        typeof record.retrieved_at === "string" &&
        record.retrieved_at.length > 0
          ? record.retrieved_at
          : new Date().toISOString(),
    };
    const authors = coerceStringArray(record.authors);
    if (authors) work.authors = authors;
    const year = coerceNumber(record.year);
    if (year !== undefined) {
      work.year = year;
    } else if (recordDate) {
      const dateYear = Number(recordDate.slice(0, 4));
      if (Number.isInteger(dateYear)) work.year = dateYear;
    }
    if (recordDate) work.date = recordDate;
    if (sourceUrl) work.source_url = sourceUrl;
    if (pdfUrl) work.pdf_url = pdfUrl;
    for (const field of [
      "venue",
      "type",
      "abstract",
      "doi",
      "arxiv_id",
      "pmid",
      "pmc_id",
      "openalex_id",
      "semantic_scholar_id",
      "dblp_key",
      "openreview_id",
      "oa_status",
      "landing_url",
      "code_url",
      "project_url",
      "dataset_url",
      "model_urls",
      "dataset_urls",
      "space_urls",
    ] as const) {
      if (typeof record[field] === "string" && record[field].length > 0) {
        work[field] = record[field] as never;
      }
    }
    if (!work.openreview_id && source === "openreview") {
      work.openreview_id = work.id;
    }
    if (!work.arxiv_id) {
      const arxivId = work.id
        .replace(/^https?:\/\/arxiv\.org\/abs\//i, "")
        .replace(/v\d+$/i, "");
      if (/^\d{4}\.\d{4,5}/.test(arxivId)) work.arxiv_id = arxivId;
    }
    for (const [sourceField, targetField] of [
      ["cited_by_count", "cited_by_count"],
      ["references_count", "references_count"],
      ["github_stars", "github_stars"],
      ["num_models", "num_models"],
      ["num_datasets", "num_datasets"],
      ["num_spaces", "num_spaces"],
    ] as const) {
      const n = coerceNumber(record[sourceField]);
      if (n !== undefined) work[targetField] = n;
    }
    if (typeof record.is_open_access === "boolean") {
      work.is_open_access = record.is_open_access;
    }
    if (record.raw !== undefined) work.raw = record.raw;
    const matchedFields = coerceStringArray(record.matched_fields);
    if (matchedFields) work.matched_fields = matchedFields;
    for (const field of ["search_scope", "search_window"] as const) {
      if (typeof record[field] === "string" && record[field].length > 0) {
        work[field] = record[field];
      }
    }
    for (const [sourceField, targetField] of [
      ["search_scanned_records", "search_scanned_records"],
      ["search_total_records", "search_total_records"],
    ] as const) {
      const n = coerceNumber(record[sourceField]);
      if (n !== undefined) work[targetField] = n;
    }
    if (typeof record.search_exhaustive === "boolean") {
      work.search_exhaustive = record.search_exhaustive;
    }
    out.push(work);
  }
  return out;
}

function definedEntries(
  args: Record<string, unknown>,
): Array<[string, unknown]> {
  return Object.entries(args).filter(([, value]) => value !== undefined);
}

export function normalizeScholarCommandArgs(
  command: AdapterCommand,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const adapterArgs = command.adapterArgs ?? [];
  const declared = new Set(adapterArgs.map((arg) => arg.name));
  if (declared.size === 0) return Object.fromEntries(definedEntries(args));
  const filtered = Object.fromEntries(
    definedEntries(args).filter(([name]) => declared.has(name)),
  );
  const internalSchema = adapterArgs.map((arg) => ({
    ...arg,
    positional: false,
  }));
  const resolved = resolveArgs({
    opts: filtered,
    positionals: [],
    schema: internalSchema,
    stdinIsTTY: true,
  });
  return Object.fromEntries(
    definedEntries(resolved.args).filter(([name]) => declared.has(name)),
  );
}

function referenceArgs(
  route: ScholarlyReferenceRoute,
  opts: {
    unpaywallEmail?: string;
    venue?: string;
    year?: string;
    volume?: string;
  } = {},
): Record<string, unknown> {
  return {
    ref: route.value,
    id: route.value,
    doi: route.kind === "doi" ? route.value : undefined,
    arxiv_id: route.kind === "arxiv" ? route.value : undefined,
    pmid: route.kind === "pmid" ? route.value : undefined,
    key: route.kind === "dblp" ? route.value : undefined,
    forum: route.kind === "openreview" ? route.value : undefined,
    email: opts.unpaywallEmail,
    venue: opts.venue,
    year: opts.year,
    volume: opts.volume,
  };
}

export function resolveScholarArtifactSources(
  sourceArg: string | undefined,
  sourcesArg: string | undefined,
  route: ScholarlyReferenceRoute,
): string[] {
  if (sourceArg) return [sourceArg];
  if (sourcesArg) return resolveScholarSources(sourcesArg);
  if (route.kind === "unknown")
    return listScholarSourcesByCapability("scholar.pdf");
  return resolveScholarSources(undefined, route.preferredSources);
}

export function resolveScholarFulltextSources(
  sourceArg: string | undefined,
  sourcesArg: string | undefined,
  route: ScholarlyReferenceRoute,
): string[] {
  if (sourceArg) return [sourceArg];
  if (sourcesArg) return resolveScholarSources(sourcesArg);
  const candidates =
    route.kind === "unknown"
      ? listScholarSourcesByCapability("scholar.fulltext")
      : resolveScholarSources(undefined, route.preferredSources);
  return candidates.filter((source) => {
    const adapter = getAllAdapters().find(
      (candidate) => candidate.name === source,
    );
    return adapter
      ? findScholarCommandByCapability(adapter, "scholar.fulltext") !==
          undefined
      : false;
  });
}

interface FanoutOutcome {
  source: string;
  capability?: ScholarCapability;
  records: ScholarlyWorkRecord[];
  error?: { code: string; message: string; retryable?: boolean };
}

interface ReviewOutcome {
  source: string;
  rows: Record<string, unknown>[];
  error?: { code: string; message: string; retryable?: boolean };
}

interface SingleCollectResult {
  sourceList: string[];
  outcomes: FanoutOutcome[];
  records: ScholarlyWorkRecord[];
}

async function executeScholarAdapterCommand(
  source: string,
  found: { name: string; command: AdapterCommand },
  args: Record<string, unknown>,
  capability?: ScholarCapability,
): Promise<FanoutOutcome> {
  const invocation = buildInvocation(
    "cli",
    source,
    found.name,
    {
      args: normalizeScholarCommandArgs(found.command, args),
      source: "internal",
    },
    { approved: true },
  );
  if (!invocation) {
    return {
      source,
      capability,
      records: [],
      error: {
        code: "build_invocation_failed",
        message: `could not build invocation for ${source}.${found.name}`,
      },
    };
  }
  const result = await execute(invocation);
  if (result.error) {
    return {
      source,
      capability,
      records: [],
      error: {
        code: result.error.code ?? "execution_error",
        message: result.error.message ?? "adapter command failed",
        retryable: result.error.retryable,
      },
    };
  }
  return {
    source,
    capability,
    records: coerceToScholarlyRecords(result.results, source),
  };
}

async function executeScholarAdapterRows(
  source: string,
  found: { name: string; command: AdapterCommand },
  args: Record<string, unknown>,
): Promise<ReviewOutcome> {
  const invocation = buildInvocation(
    "cli",
    source,
    found.name,
    {
      args: normalizeScholarCommandArgs(found.command, args),
      source: "internal",
    },
    { approved: true },
  );
  if (!invocation) {
    return {
      source,
      rows: [],
      error: {
        code: "build_invocation_failed",
        message: `could not build invocation for ${source}.${found.name}`,
      },
    };
  }
  const result = await execute(invocation);
  if (result.error) {
    return {
      source,
      rows: [],
      error: {
        code: result.error.code ?? "execution_error",
        message: result.error.message ?? "adapter command failed",
        retryable: result.error.retryable,
      },
    };
  }
  const rows = Array.isArray(result.results)
    ? result.results
        .filter(
          (row): row is Record<string, unknown> =>
            typeof row === "object" && row !== null && !Array.isArray(row),
        )
        .map((row) => ({ source_adapter: source, ...row }))
    : [];
  return { source, rows };
}

async function runReviewAdapterCommand(
  source: string,
  args: Record<string, unknown>,
): Promise<ReviewOutcome> {
  const adapter = getAllAdapters().find(
    (candidate) => candidate.name === source,
  );
  if (!adapter) {
    return {
      source,
      rows: [],
      error: {
        code: "adapter_not_found",
        message: `unknown source: ${source}`,
      },
    };
  }
  const found = findScholarReviewThreadCommand(adapter);
  if (!found) {
    return {
      source,
      rows: [],
      error: {
        code: "capability_unsupported",
        message: `${source} does not expose scholar.review`,
      },
    };
  }
  return executeScholarAdapterRows(source, found, args);
}

async function runAdapterCommand(
  source: string,
  capability: ScholarCapability,
  args: Record<string, unknown>,
): Promise<FanoutOutcome> {
  const adapter = getAllAdapters().find(
    (candidate) => candidate.name === source,
  );
  if (!adapter) {
    return {
      source,
      records: [],
      error: {
        code: "adapter_not_found",
        message: `unknown source: ${source}`,
      },
    };
  }
  const found = findScholarCommandByCapability(adapter, capability);
  if (!found) {
    return {
      source,
      records: [],
      error: {
        code: "capability_unsupported",
        message: `${source} does not expose ${capability}`,
      },
    };
  }
  return executeScholarAdapterCommand(source, found, args, capability);
}

async function runSingleRecordResourceCommand(
  source: string,
  capability: Extract<ScholarCapability, "scholar.code" | "scholar.datasets">,
  args: Record<string, unknown>,
): Promise<FanoutOutcome> {
  const adapter = getAllAdapters().find(
    (candidate) => candidate.name === source,
  );
  if (!adapter) {
    return {
      source,
      records: [],
      error: {
        code: "adapter_not_found",
        message: `unknown source: ${source}`,
      },
    };
  }
  const found = findScholarSingleRecordCommandByCapability(adapter, capability);
  if (!found) {
    return {
      source,
      capability,
      records: [],
      error: {
        code: "capability_unsupported",
        message: `${source} does not expose single-record ${capability}`,
      },
    };
  }
  return executeScholarAdapterCommand(source, found, args, capability);
}

async function collectSingleRecords(
  capability: ScholarCapability,
  ref: string,
  opts: { source?: string; sources?: string; unpaywallEmail?: string },
  sourceFallback?: readonly string[],
): Promise<SingleCollectResult> {
  const route = resolveScholarReference(ref);
  const sourceList = opts.source
    ? [opts.source]
    : resolveScholarSources(
        opts.sources,
        sourceFallback ?? route.preferredSources,
      );
  const outcomes: FanoutOutcome[] = [];
  for (const source of sourceList) {
    outcomes.push(
      await runAdapterCommand(source, capability, {
        ...referenceArgs(route, opts),
      }),
    );
  }
  return {
    sourceList,
    outcomes,
    records: reciprocalRankFusion(
      outcomes.map((outcome) => outcome.records),
      { topN: capability === "scholar.pdf" ? 10 : 50 },
    ),
  };
}

async function collectResourceSearchRecords(
  capability: Extract<ScholarCapability, "scholar.code" | "scholar.datasets">,
  query: string,
  opts: { source?: string; sources?: string },
): Promise<SingleCollectResult> {
  const sourceList = opts.source
    ? [opts.source]
    : resolveScholarSources(
        opts.sources,
        listResourceSearchScholarSourcesByCapability(capability),
      );
  const outcomes: FanoutOutcome[] = [];
  for (const source of sourceList) {
    const adapter = getAllAdapters().find(
      (candidate) => candidate.name === source,
    );
    const found = adapter
      ? findScholarResourceSearchCommandByCapability(adapter, capability)
      : undefined;
    if (!adapter) {
      outcomes.push({
        source,
        records: [],
        error: {
          code: "adapter_not_found",
          message: `unknown source: ${source}`,
        },
      });
      continue;
    }
    if (!found) {
      outcomes.push({
        source,
        records: [],
        error: {
          code: "capability_unsupported",
          message: `${source} does not expose queryable ${capability}`,
        },
      });
      continue;
    }
    outcomes.push(
      await executeScholarAdapterCommand(
        source,
        found,
        {
          query,
          limit: "5",
        },
        capability,
      ),
    );
  }
  return {
    sourceList,
    outcomes,
    records: reciprocalRankFusion(
      outcomes.map((outcome) => outcome.records),
      { topN: 10 },
    ),
  };
}

async function collectResourceDetailRecordsFromSearch(
  capability: Extract<ScholarCapability, "scholar.code" | "scholar.datasets">,
  searchRecords: ScholarlyWorkRecord[],
  opts: { source?: string; sources?: string },
): Promise<SingleCollectResult> {
  const sourceList = listResourceDetailSourcesForSearchFallback(
    capability,
    opts,
  );
  const refs = [
    ...new Set(
      searchRecords
        .map((record) => record.arxiv_id ?? record.id)
        .filter((ref) => /^\d{4}\.\d{4,5}(?:v\d+)?$/i.test(ref)),
    ),
  ].slice(0, 3);
  const outcomes: FanoutOutcome[] = [];
  for (const ref of refs) {
    for (const source of sourceList) {
      outcomes.push(
        await runAdapterCommand(source, capability, {
          ...referenceArgs(resolveScholarReference(ref)),
        }),
      );
    }
  }
  return {
    sourceList,
    outcomes,
    records: reciprocalRankFusion(
      outcomes.map((outcome) => outcome.records),
      { topN: 10 },
    ),
  };
}

async function collectPdfCandidates(
  ref: string,
  opts: {
    source?: string;
    sources?: string;
    unpaywallEmail?: string;
    venue?: string;
    year?: string;
    volume?: string;
  },
): Promise<SingleCollectResult> {
  const route = resolveScholarReference(ref);
  const sourceList = resolveScholarArtifactSources(
    opts.source,
    opts.sources,
    route,
  );
  const outcomes: FanoutOutcome[] = [];
  for (const source of sourceList) {
    outcomes.push(
      await runAdapterCommand(source, "scholar.pdf", {
        ...referenceArgs(route, opts),
      }),
    );
  }

  if (
    route.kind === "unknown" ||
    outcomes.every((outcome) => outcome.records.length === 0)
  ) {
    for (const source of sourceList) {
      const adapter = getAllAdapters().find(
        (candidate) => candidate.name === source,
      );
      const found = adapter
        ? findScholarQueryableSearchCommand(adapter)
        : undefined;
      if (!adapter) {
        outcomes.push({
          source,
          records: [],
          error: {
            code: "adapter_not_found",
            message: `unknown source: ${source}`,
          },
        });
        continue;
      }
      if (!found) {
        outcomes.push({
          source,
          records: [],
          error: {
            code: "capability_unsupported",
            message: `${source} does not expose queryable scholar.search`,
          },
        });
        continue;
      }
      const outcome = await executeScholarAdapterCommand(
        source,
        found,
        {
          query: ref,
          limit: "5",
        },
        "scholar.pdf",
      );
      outcomes.push(
        route.kind === "unknown"
          ? onlyRelevantUnknownQueryRecords(outcome, ref)
          : outcome,
      );
    }
  }

  return {
    sourceList,
    outcomes,
    records: reciprocalRankFusion(
      outcomes.map((outcome) => outcome.records),
      { topN: 10 },
    ),
  };
}

function firstPdfRecord(
  records: ScholarlyWorkRecord[],
): ScholarlyWorkRecord | undefined {
  return records.find(
    (record) => typeof record.pdf_url === "string" && record.pdf_url.length > 0,
  );
}

function normalizedTitleKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function isScholarlyRecordRelevantToQuery(
  record: ScholarlyWorkRecord,
  query: string,
): boolean {
  const queryKey = normalizedTitleKey(query);
  if (!queryKey) return true;
  const titleKey = normalizedTitleKey(record.title);
  if (!titleKey) return false;
  if (titleKey === queryKey || titleKey.startsWith(`${queryKey} `)) {
    return true;
  }
  if (queryKey.length >= 12 && titleKey.includes(queryKey)) return true;
  const queryTokens = queryKey.split(" ").filter(Boolean);
  if (queryTokens.length <= 3) return false;
  const titleTokens = new Set(titleKey.split(" ").filter(Boolean));
  const matched = queryTokens.filter((token) => titleTokens.has(token)).length;
  return matched / queryTokens.length >= 0.8;
}

function onlyRelevantUnknownQueryRecords(
  outcome: FanoutOutcome,
  query: string,
): FanoutOutcome {
  return {
    ...outcome,
    records: outcome.records.filter((record) =>
      isScholarlyRecordRelevantToQuery(record, query),
    ),
  };
}

export function isScholarlyRecordRelevantToRef(
  record: ScholarlyWorkRecord,
  ref: string,
): boolean {
  const route = resolveScholarReference(ref);
  const candidates = [
    record.id,
    record.arxiv_id,
    record.doi,
    record.pmid,
    record.pmc_id,
    record.openreview_id,
    record.semantic_scholar_id,
    record.source_url,
    record.pdf_url,
  ];
  if (route.kind === "arxiv") {
    return candidates.some(
      (candidate) => canonicalArxivId(candidate) === route.value,
    );
  }
  if (route.kind === "doi") {
    return candidates.some(
      (candidate) => canonicalDoi(candidate) === route.value,
    );
  }
  const needle = route.value.toLowerCase();
  return candidates.some(
    (candidate) =>
      typeof candidate === "string" &&
      candidate.trim().toLowerCase().includes(needle),
  );
}

function onlyRelevantRefRecords(
  outcome: FanoutOutcome,
  ref: string,
): FanoutOutcome {
  return {
    ...outcome,
    records: outcome.records.filter((record) =>
      isScholarlyRecordRelevantToRef(record, ref),
    ),
  };
}

interface DirectFulltextOutcome {
  source: string;
  error?: { code: string; message: string; retryable?: boolean };
}

function isRetryableScholarError(
  error: { code?: string; retryable?: boolean } | undefined,
): boolean {
  return (
    error?.retryable === true ||
    error?.code === "rate_limit" ||
    error?.code === "rate_limited"
  );
}

function formatScholarOutcomeError(outcome: {
  source: string;
  error?: { code: string; message: string; retryable?: boolean };
}): string {
  const code = outcome.error?.code ?? "unknown_error";
  const message = outcome.error?.message?.trim();
  return message
    ? `${outcome.source}: ${code} (${message})`
    : `${outcome.source}: ${code}`;
}

function columns(detailed = false): string[] {
  return detailed
    ? [
        "id",
        "title",
        "authors",
        "year",
        "venue",
        "type",
        "doi",
        "arxiv_id",
        "pmid",
        "cited_by_count",
        "references_count",
        "is_open_access",
        "oa_status",
        "pdf_url",
        "code_url",
        "project_url",
        "dataset_url",
        "model_urls",
        "dataset_urls",
        "space_urls",
        "github_stars",
        "num_models",
        "num_datasets",
        "num_spaces",
        "source_adapter",
        "source_url",
        "search_scope",
        "search_window",
        "search_exhaustive",
      ]
    : ["id", "title", "year", "venue", "doi", "pdf_url", "source_adapter"];
}

function resourceColumns(detailed = false): string[] {
  const base = [
    "id",
    "title",
    "source_adapter",
    "source_url",
    "pdf_url",
    "code_url",
    "project_url",
    "dataset_url",
    "model_urls",
    "dataset_urls",
    "space_urls",
  ];
  return detailed
    ? [
        ...base,
        "authors",
        "year",
        "github_stars",
        "num_models",
        "num_datasets",
        "num_spaces",
        "retrieved_at",
      ]
    : base;
}

function columnsForCapability(
  capability: ScholarCapability,
  detailed = false,
): string[] {
  return capability === "scholar.code" || capability === "scholar.datasets"
    ? resourceColumns(detailed)
    : columns(detailed);
}

function reviewColumns(detailed = false): string[] {
  const base = [
    "source_adapter",
    "forum",
    "note_id",
    "type",
    "created_at",
    "source_url",
    "rating",
    "confidence",
    "text",
    "text_truncated",
  ];
  return detailed ? [...base, "author", "invitation", "text_chars"] : base;
}

async function runSearch(
  program: Command,
  query: string,
  opts: { sources?: string; limit?: string; detailed?: boolean },
): Promise<void> {
  const startedAt = Date.now();
  const fmt = detectFormat(program.opts().format as OutputFormat | undefined);
  const ctx = makeCtx("scholar.search", startedAt);
  const limit = numberOpt(opts.limit, 20, 100);
  const sources = resolveScholarSources(opts.sources);
  const outcomes: FanoutOutcome[] = [];
  for (const source of sources) {
    outcomes.push(
      await runAdapterCommand(source, "scholar.search", { query, limit }),
    );
  }
  const fused = reciprocalRankFusion(
    outcomes.map((outcome) => outcome.records),
    { topN: limit },
  );
  ctx.duration_ms = Date.now() - startedAt;
  ctx.surface = "web";
  if (fused.length === 0) {
    const errors = outcomes.filter((outcome) => outcome.error);
    ctx.error = {
      code: "SCHOLAR_NOT_FOUND",
      message: `no scholarly works returned for "${query}" across [${sources.join(", ")}]`,
      suggestion:
        errors.length > 0
          ? `Per-source errors: ${errors.map(formatScholarOutcomeError).join("; ")}`
          : "Try --sources all or a more specific query.",
      retryable: errors.some((outcome) =>
        isRetryableScholarError(outcome.error),
      ),
    };
    console.error(format(null, undefined, fmt, ctx));
    process.exit(ExitCode.EMPTY_RESULT);
  }
  console.log(format(fused, columns(opts.detailed), fmt, ctx));
}

async function runSingle(
  program: Command,
  capability: ScholarCapability,
  ref: string,
  opts: {
    source?: string;
    sources?: string;
    detailed?: boolean;
    unpaywallEmail?: string;
  },
): Promise<void> {
  const startedAt = Date.now();
  const fmt = detectFormat(program.opts().format as OutputFormat | undefined);
  const ctx = makeCtx(capability, startedAt);
  const lookupRef = await resolveGraphLookupRef(capability, ref, opts);
  const { sourceList, outcomes, records } = await collectSingleRecords(
    capability,
    lookupRef,
    opts,
  );
  ctx.duration_ms = Date.now() - startedAt;
  ctx.surface = "web";
  if (records.length === 0) {
    const errors = outcomes.filter((outcome) => outcome.error);
    ctx.error = {
      code: "SCHOLAR_NOT_FOUND",
      message: `no scholarly records returned for "${ref}" across [${sourceList.join(", ")}]`,
      suggestion:
        errors.length > 0
          ? `Per-source errors: ${errors.map(formatScholarOutcomeError).join("; ")}`
          : "Run `unicli scholar doctor` to inspect available scholarly sources.",
      retryable: errors.some((outcome) =>
        isRetryableScholarError(outcome.error),
      ),
    };
    console.error(format(null, undefined, fmt, ctx));
    process.exit(ExitCode.EMPTY_RESULT);
  }
  console.log(
    format(records, columnsForCapability(capability, opts.detailed), fmt, ctx),
  );
}

async function runReviews(
  program: Command,
  ref: string,
  opts: {
    source?: string;
    sources?: string;
    detailed?: boolean;
    maxLength?: string;
  },
): Promise<void> {
  const startedAt = Date.now();
  const fmt = detectFormat(program.opts().format as OutputFormat | undefined);
  const ctx = makeCtx("scholar.reviews", startedAt);
  const route = resolveScholarReference(ref);
  const sourceList = opts.source
    ? [opts.source]
    : resolveScholarSources(
        opts.sources,
        route.kind === "openreview"
          ? route.preferredSources
          : listScholarReviewSources(),
      );
  const outcomes: ReviewOutcome[] = [];
  for (const source of sourceList) {
    const maxLength =
      opts.maxLength === undefined ? undefined : Number(opts.maxLength);
    outcomes.push(
      await runReviewAdapterCommand(source, {
        ...referenceArgs(route),
        forum: route.value,
        "max-length": maxLength,
      }),
    );
  }
  const rows = outcomes.flatMap((outcome) => outcome.rows);
  ctx.duration_ms = Date.now() - startedAt;
  ctx.surface = "web";
  if (rows.length === 0) {
    const errors = outcomes.filter((outcome) => outcome.error);
    ctx.error = {
      code: "SCHOLAR_REVIEWS_NOT_FOUND",
      message: `no scholarly review rows returned for "${ref}" across [${sourceList.join(", ")}]`,
      suggestion:
        errors.length > 0
          ? `Per-source errors: ${errors.map(formatScholarOutcomeError).join("; ")}`
          : "Use an OpenReview forum id or URL, or run `unicli scholar search <query> --sources openreview` before requesting reviews.",
      retryable: errors.some((outcome) =>
        isRetryableScholarError(outcome.error),
      ),
    };
    console.error(format(null, undefined, fmt, ctx));
    process.exit(ExitCode.EMPTY_RESULT);
  }
  console.log(format(rows, reviewColumns(opts.detailed), fmt, ctx));
}

function nonEmptyResourceField(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveResourceCount(value: number | undefined): boolean {
  return value !== undefined && value > 0;
}

export function hasResourceForCapability(
  record: ScholarlyWorkRecord,
  capability: Extract<ScholarCapability, "scholar.code" | "scholar.datasets">,
): boolean {
  if (capability === "scholar.code") {
    return (
      nonEmptyResourceField(record.code_url) ||
      nonEmptyResourceField(record.project_url)
    );
  }
  return (
    nonEmptyResourceField(record.dataset_url) ||
    nonEmptyResourceField(record.dataset_urls) ||
    nonEmptyResourceField(record.model_urls) ||
    nonEmptyResourceField(record.space_urls) ||
    positiveResourceCount(record.num_datasets) ||
    positiveResourceCount(record.num_models) ||
    positiveResourceCount(record.num_spaces)
  );
}

function hasCodeResource(record: ScholarlyWorkRecord): boolean {
  return (
    nonEmptyResourceField(record.code_url) ||
    nonEmptyResourceField(record.project_url)
  );
}

function hasDatasetResource(record: ScholarlyWorkRecord): boolean {
  return (
    nonEmptyResourceField(record.dataset_url) ||
    nonEmptyResourceField(record.dataset_urls) ||
    positiveResourceCount(record.num_datasets)
  );
}

function hasModelResource(record: ScholarlyWorkRecord): boolean {
  return (
    nonEmptyResourceField(record.model_urls) ||
    positiveResourceCount(record.num_models)
  );
}

function hasSpaceResource(record: ScholarlyWorkRecord): boolean {
  return (
    nonEmptyResourceField(record.space_urls) ||
    positiveResourceCount(record.num_spaces)
  );
}

async function collectResourceRecords(
  capability: Extract<ScholarCapability, "scholar.code" | "scholar.datasets">,
  ref: string,
  opts: { source?: string; sources?: string },
): Promise<SingleCollectResult> {
  const route = resolveScholarReference(ref);
  let sourceList =
    route.kind === "unknown"
      ? []
      : opts.source
        ? [opts.source]
        : resolveScholarSources(
            opts.sources,
            listSingleRecordScholarSourcesByCapability(capability),
          );
  let outcomes: FanoutOutcome[] = [];
  if (route.kind !== "unknown") {
    for (const source of sourceList) {
      outcomes.push(
        await runSingleRecordResourceCommand(source, capability, {
          ...referenceArgs(route),
        }),
      );
    }
  }
  let resourceRecords = reciprocalRankFusion(
    outcomes.map((outcome) => outcome.records),
    { topN: 10 },
  ).filter((record) => hasResourceForCapability(record, capability));
  if (resourceRecords.length === 0 && route.kind !== "unknown") {
    const searched = await collectResourceSearchRecords(capability, ref, opts);
    const searchOutcomes = searched.outcomes.map((outcome) =>
      onlyRelevantRefRecords(outcome, ref),
    );
    const searchedSources = new Set(
      searchOutcomes
        .filter((outcome) => !outcome.error)
        .map((outcome) => outcome.source),
    );
    sourceList = uniqueStrings([...sourceList, ...searched.sourceList]);
    outcomes = [
      ...outcomes.filter(
        (outcome) =>
          outcome.error?.code !== "capability_unsupported" ||
          !searchedSources.has(outcome.source),
      ),
      ...searchOutcomes,
    ];
    resourceRecords = reciprocalRankFusion(
      outcomes.map((outcome) => outcome.records),
      { topN: 10 },
    ).filter((record) => hasResourceForCapability(record, capability));
  }
  if (resourceRecords.length === 0 && route.kind === "unknown") {
    const searched = await collectResourceSearchRecords(capability, ref, opts);
    const searchOutcomes = searched.outcomes.map((outcome) =>
      onlyRelevantUnknownQueryRecords(outcome, ref),
    );
    const searchRecords = reciprocalRankFusion(
      searchOutcomes.map((outcome) => outcome.records),
      { topN: 10 },
    );
    const enriched = await collectResourceDetailRecordsFromSearch(
      capability,
      searchRecords,
      opts,
    );
    sourceList = [...sourceList, ...searched.sourceList];
    if (enriched.sourceList.length > 0) {
      sourceList = [...sourceList, ...enriched.sourceList];
    }
    outcomes = [...outcomes, ...searchOutcomes, ...enriched.outcomes];
    resourceRecords = reciprocalRankFusion([enriched.records, searchRecords], {
      topN: 10,
    }).filter((record) => hasResourceForCapability(record, capability));
  }
  return { sourceList, outcomes, records: resourceRecords };
}

async function runResources(
  program: Command,
  capability: Extract<ScholarCapability, "scholar.code" | "scholar.datasets">,
  ref: string,
  opts: { source?: string; sources?: string; detailed?: boolean },
): Promise<void> {
  const startedAt = Date.now();
  const fmt = detectFormat(program.opts().format as OutputFormat | undefined);
  const ctx = makeCtx(capability, startedAt);
  const {
    sourceList,
    outcomes,
    records: resourceRecords,
  } = await collectResourceRecords(capability, ref, opts);
  ctx.duration_ms = Date.now() - startedAt;
  ctx.surface = "web";
  if (resourceRecords.length === 0) {
    const errors = outcomes.filter((outcome) => outcome.error);
    const label = capability === "scholar.code" ? "code" : "dataset/model";
    ctx.error = {
      code: "SCHOLAR_RESOURCE_NOT_FOUND",
      message: `no scholarly ${label} resources returned for "${ref}" across [${sourceList.join(", ")}]`,
      suggestion:
        errors.length > 0
          ? `Per-source errors: ${errors.map(formatScholarOutcomeError).join("; ")}`
          : "Try --source hf for Hugging Face paper resources, or run `unicli scholar doctor` to inspect resource-capable sources.",
      retryable: errors.some((outcome) =>
        isRetryableScholarError(outcome.error),
      ),
    };
    console.error(format(null, undefined, fmt, ctx));
    process.exit(ExitCode.EMPTY_RESULT);
  }
  console.log(
    format(resourceRecords, resourceColumns(opts.detailed), fmt, ctx),
  );
}

interface ScholarAvailabilityInputs {
  ref: string;
  route: ScholarlyReferenceRoute;
  metadataRecords: ScholarlyWorkRecord[];
  pdfRecords: ScholarlyWorkRecord[];
  codeRecords: ScholarlyWorkRecord[];
  datasetRecords: ScholarlyWorkRecord[];
  fulltextCandidateSources: string[];
  citationCandidateSources: string[];
  referenceCandidateSources: string[];
  reviewCandidateSources: string[];
  sourceErrors: string[];
  opts: {
    source?: string;
    sources?: string;
    unpaywallEmail?: string;
  };
}

type ScholarAvailabilityRow = Record<string, unknown>;
export type ScholarSourceAuditRow = Record<string, unknown>;
export type ScholarWorkflowRow = Record<string, unknown>;
export type ScholarEvidenceRow = Record<string, unknown>;
export type ScholarReproducibilityRow = Record<string, unknown>;
export type ScholarCoverageRow = Record<string, unknown>;

interface ScholarAvailabilityCollect {
  row: ScholarAvailabilityRow;
  outcomes: FanoutOutcome[];
}

interface ScholarWorkflowStep {
  order: number;
  step: string;
  status: string;
  command?: string;
  commands?: string[];
  done_when: string;
  guard: string;
}

function uniqueStrings(values: Iterable<string | undefined>): string[] {
  return [...new Set([...values].filter(Boolean) as string[])];
}

function sourcesForRecords(
  records: ScholarlyWorkRecord[],
  predicate: (record: ScholarlyWorkRecord) => boolean = () => true,
): string[] {
  return uniqueStrings(
    records
      .filter(predicate)
      .map((record) => record.source_adapter)
      .filter(Boolean),
  );
}

function quoteCliArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function scholarCommand(
  subcommand: string,
  ref: string,
  opts: {
    source?: string;
    sources?: string;
    unpaywallEmail?: string;
  },
): string {
  const flags = [
    opts.source ? `--source ${quoteCliArg(opts.source)}` : undefined,
    opts.sources ? `--sources ${quoteCliArg(opts.sources)}` : undefined,
    opts.unpaywallEmail
      ? `--unpaywall-email ${quoteCliArg(opts.unpaywallEmail)}`
      : undefined,
  ].filter(Boolean);
  return [`unicli scholar ${subcommand}`, quoteCliArg(ref), ...flags].join(" ");
}

function canonicalArxivId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(
    /(?:arxiv(?:\.org\/(?:abs|pdf)\/|:)|^)(\d{4}\.\d{4,5})(?:v\d+)?/i,
  );
  return match?.[1];
}

function canonicalDoi(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const doi = bareDoi(value);
  return /^10\.\S+\/\S+$/i.test(doi) ? doi : undefined;
}

function firstRecordValue(
  records: ScholarlyWorkRecord[],
  pick: (record: ScholarlyWorkRecord) => string | undefined,
): string | undefined {
  for (const record of records) {
    const value = pick(record);
    if (value) return value;
  }
  return undefined;
}

function canonicalScholarReference(
  route: ScholarlyReferenceRoute,
  records: ScholarlyWorkRecord[],
): { kind: string; ref: string } | undefined {
  const arxivId = firstRecordValue(
    records,
    (record) =>
      canonicalArxivId(record.arxiv_id) ??
      canonicalArxivId(record.id) ??
      canonicalArxivId(record.source_url) ??
      canonicalArxivId(record.pdf_url),
  );
  if (arxivId) return { kind: "arxiv", ref: arxivId };

  const doi = firstRecordValue(
    records,
    (record) => canonicalDoi(record.doi) ?? canonicalDoi(record.id),
  );
  if (doi) return { kind: "doi", ref: doi };

  const pmid = firstRecordValue(records, (record) =>
    typeof record.pmid === "string" && record.pmid.trim().length > 0
      ? record.pmid.trim()
      : undefined,
  );
  if (pmid) return { kind: "pmid", ref: pmid };

  const openreviewId = firstRecordValue(records, (record) =>
    typeof record.openreview_id === "string" &&
    record.openreview_id.trim().length > 0
      ? `openreview:${record.openreview_id.trim()}`
      : undefined,
  );
  if (openreviewId) return { kind: "openreview", ref: openreviewId };

  const semanticScholarId = firstRecordValue(records, (record) =>
    typeof record.semantic_scholar_id === "string" &&
    record.semantic_scholar_id.trim().length > 0
      ? record.semantic_scholar_id.trim()
      : undefined,
  );
  if (semanticScholarId)
    return { kind: "semantic-scholar", ref: semanticScholarId };

  return route.kind === "unknown"
    ? undefined
    : { kind: route.kind, ref: route.value };
}

function sourceCommand(
  source: string,
  command: string | undefined,
  placeholder?: string,
): string | undefined {
  if (!command) return undefined;
  return [`unicli ${source} ${command}`, placeholder].filter(Boolean).join(" ");
}

function capabilitySet(adapter: AdapterManifest): Set<ScholarCapability> {
  const capabilities = new Set<ScholarCapability>();
  for (const command of Object.values(adapter.commands)) {
    for (const capability of command.capabilities ?? []) {
      if ((SCHOLAR_CAPABILITIES as readonly string[]).includes(capability)) {
        capabilities.add(capability as ScholarCapability);
      }
    }
  }
  return capabilities;
}

function sourceCommandByCapability(
  adapter: AdapterManifest,
  capability: ScholarCapability,
): string | undefined {
  if (capability === "scholar.code" || capability === "scholar.datasets") {
    return (
      findScholarSingleRecordCommandByCapability(adapter, capability)?.name ??
      findScholarResourceSearchCommandByCapability(adapter, capability)?.name
    );
  }
  return findScholarCommandByCapability(adapter, capability)?.name;
}

function adapterSupportsSourceScopedAvailability(
  adapter: AdapterManifest,
  capabilities: Set<ScholarCapability> = capabilitySet(adapter),
): boolean {
  return (
    capabilities.has("scholar.get") ||
    capabilities.has("scholar.pdf") ||
    sourceCommandByCapability(adapter, "scholar.code") !== undefined ||
    sourceCommandByCapability(adapter, "scholar.datasets") !== undefined
  );
}

function sourceReviewCommand(adapter: AdapterManifest): string | undefined {
  return findScholarReviewThreadCommand(adapter)?.name;
}

function coverageCommandByCapability(
  adapter: AdapterManifest,
  capability: ScholarCapability,
): string | undefined {
  return capability === "scholar.review"
    ? sourceReviewCommand(adapter)
    : sourceCommandByCapability(adapter, capability);
}

function sourceSearchCommand(adapter: AdapterManifest): string | undefined {
  const queryable = findScholarQueryableSearchCommand(adapter);
  if (queryable) return sourceCommand(adapter.name, queryable.name, "<query>");
  return sourceCommand(
    adapter.name,
    sourceCommandByCapability(adapter, "scholar.search"),
  );
}

function recommendedUses(capabilities: Set<ScholarCapability>): string[] {
  const uses: string[] = [];
  if (capabilities.has("scholar.search")) uses.push("discovery");
  if (capabilities.has("scholar.get")) uses.push("metadata");
  if (capabilities.has("scholar.pdf")) uses.push("pdf-download/read");
  if (capabilities.has("scholar.fulltext")) uses.push("source-fulltext");
  if (capabilities.has("scholar.code")) uses.push("code/project");
  if (capabilities.has("scholar.datasets")) uses.push("datasets/models/spaces");
  if (
    capabilities.has("scholar.citations") ||
    capabilities.has("scholar.references")
  ) {
    uses.push("citation-graph");
  }
  if (capabilities.has("scholar.review")) uses.push("peer-review-audit");
  if (capabilities.has("scholar.venue") || capabilities.has("scholar.author"))
    uses.push("venue/author-browse");
  return uses;
}

function sourceRole(capabilities: Set<ScholarCapability>): string {
  if (
    capabilities.has("scholar.review") &&
    capabilities.has("scholar.fulltext")
  )
    return "review-fulltext-source";
  if (capabilities.has("scholar.code") || capabilities.has("scholar.datasets"))
    return "resource-source";
  if (capabilities.has("scholar.pdf") && capabilities.has("scholar.get"))
    return "artifact-source";
  if (capabilities.has("scholar.fulltext")) return "fulltext-source";
  if (
    capabilities.has("scholar.citations") ||
    capabilities.has("scholar.references")
  ) {
    return "graph-source";
  }
  if (capabilities.has("scholar.search")) return "discovery-source";
  return "metadata-source";
}

function readStrategy(capabilities: Set<ScholarCapability>): string {
  const hasPdf = capabilities.has("scholar.pdf");
  const hasFulltext = capabilities.has("scholar.fulltext");
  if (hasFulltext && hasPdf) return "source-fulltext-then-pdf";
  if (hasFulltext) return "source-fulltext";
  if (hasPdf) return "pdf-download";
  if (capabilities.has("scholar.get")) return "metadata-only";
  return "discovery-only";
}

function supportsSourceScopedAvailability(
  capabilities: Set<ScholarCapability>,
): boolean {
  return (
    capabilities.has("scholar.get") ||
    capabilities.has("scholar.pdf") ||
    capabilities.has("scholar.code") ||
    capabilities.has("scholar.datasets")
  );
}

function coverageHandoffStrategy(
  capabilities: Set<ScholarCapability>,
  adapter?: AdapterManifest,
): string {
  if (
    adapter
      ? adapterSupportsSourceScopedAvailability(adapter, capabilities)
      : supportsSourceScopedAvailability(capabilities)
  ) {
    return "source-scoped-evidence";
  }
  if (capabilities.has("scholar.search")) {
    return "discovery-result-to-canonical-workflow";
  }
  if (
    capabilities.has("scholar.citations") ||
    capabilities.has("scholar.references") ||
    capabilities.has("scholar.review") ||
    capabilities.has("scholar.fulltext")
  ) {
    return "identifier-required";
  }
  return "metadata-only";
}

function missingClosedLoopCapabilities(
  capabilities: Set<ScholarCapability>,
): string[] {
  const missing: string[] = [];
  if (!capabilities.has("scholar.search")) missing.push("search");
  if (!capabilities.has("scholar.get")) missing.push("metadata-get");
  if (
    !capabilities.has("scholar.pdf") &&
    !capabilities.has("scholar.fulltext")
  ) {
    missing.push("readable-text");
  }
  if (!capabilities.has("scholar.pdf")) missing.push("pdf-download");
  if (!capabilities.has("scholar.fulltext")) missing.push("source-fulltext");
  if (!capabilities.has("scholar.code")) missing.push("code/project");
  if (!capabilities.has("scholar.datasets"))
    missing.push("datasets/models/spaces");
  if (
    !capabilities.has("scholar.citations") &&
    !capabilities.has("scholar.references")
  ) {
    missing.push("citation/reference-graph");
  }
  if (!capabilities.has("scholar.review")) missing.push("peer-review-audit");
  return missing;
}

export function buildScholarCoverageRows(
  adapters: readonly AdapterManifest[] = listScholarAdapters(),
): ScholarCoverageRow[] {
  return [...adapters]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((adapter) => {
      const capabilities = capabilitySet(adapter);
      const get = sourceCommandByCapability(adapter, "scholar.get");
      const pdf = sourceCommandByCapability(adapter, "scholar.pdf");
      const fulltext = sourceCommandByCapability(adapter, "scholar.fulltext");
      const code = sourceCommandByCapability(adapter, "scholar.code");
      const datasets = sourceCommandByCapability(adapter, "scholar.datasets");
      const citations = sourceCommandByCapability(adapter, "scholar.citations");
      const references = sourceCommandByCapability(
        adapter,
        "scholar.references",
      );
      const review = sourceReviewCommand(adapter);
      const author = sourceCommandByCapability(adapter, "scholar.author");
      const venue = sourceCommandByCapability(adapter, "scholar.venue");
      const missing = missingClosedLoopCapabilities(capabilities);
      const hasSourceScopedAvailability =
        adapterSupportsSourceScopedAvailability(adapter, capabilities);

      return {
        source: adapter.name,
        role: sourceRole(capabilities),
        recommended_for: recommendedUses(capabilities),
        read_strategy: readStrategy(capabilities),
        handoff_strategy: coverageHandoffStrategy(capabilities, adapter),
        coverage_score: capabilities.size,
        coverage_total: SCHOLAR_CAPABILITIES.length,
        missing_closed_loop: missing,
        has_search: capabilities.has("scholar.search"),
        has_get: capabilities.has("scholar.get"),
        has_pdf: capabilities.has("scholar.pdf"),
        has_fulltext: capabilities.has("scholar.fulltext"),
        has_code: capabilities.has("scholar.code"),
        has_datasets: capabilities.has("scholar.datasets"),
        has_citations: capabilities.has("scholar.citations"),
        has_references: capabilities.has("scholar.references"),
        has_review: capabilities.has("scholar.review"),
        has_author: capabilities.has("scholar.author"),
        has_venue: capabilities.has("scholar.venue"),
        next_availability: hasSourceScopedAvailability
          ? `unicli scholar availability <ref> --source ${adapter.name}`
          : undefined,
        next_read:
          capabilities.has("scholar.pdf") ||
          capabilities.has("scholar.fulltext")
            ? `unicli scholar read <ref> --source ${adapter.name}`
            : undefined,
        next_search: sourceSearchCommand(adapter),
        next_workflow_from_result: capabilities.has("scholar.search")
          ? "unicli scholar workflow <title-or-id>"
          : undefined,
        next_sources_from_result: capabilities.has("scholar.search")
          ? "unicli scholar sources <title-or-id>"
          : undefined,
        next_read_from_result: capabilities.has("scholar.search")
          ? "unicli scholar read <title-or-id>"
          : undefined,
        next_get: sourceCommand(adapter.name, get, "<id-or-ref>"),
        next_pdf: sourceCommand(adapter.name, pdf, "<id-or-ref>"),
        next_fulltext: sourceCommand(adapter.name, fulltext, "<id-or-ref>"),
        next_code: sourceCommand(adapter.name, code, "<id-or-ref>"),
        next_datasets: sourceCommand(adapter.name, datasets, "<id-or-ref>"),
        next_citations: sourceCommand(adapter.name, citations, "<id-or-ref>"),
        next_references: sourceCommand(adapter.name, references, "<id-or-ref>"),
        next_review: sourceCommand(adapter.name, review, "<id-or-ref>"),
        next_author: sourceCommand(adapter.name, author, "<author>"),
        next_venue: sourceCommand(adapter.name, venue, "<venue>"),
        capabilities: [...capabilities].sort(),
        commands: Object.fromEntries(
          SCHOLAR_CAPABILITIES.map((capability) => [
            capability.replace(/^scholar\./, ""),
            coverageCommandByCapability(adapter, capability),
          ]).filter(([, command]) => command !== undefined),
        ),
      };
    });
}

function coverageColumns(detailed = false): string[] {
  const base = [
    "source",
    "role",
    "recommended_for",
    "read_strategy",
    "handoff_strategy",
    "coverage_score",
    "coverage_total",
    "missing_closed_loop",
    "has_search",
    "has_get",
    "has_pdf",
    "has_fulltext",
    "has_code",
    "has_datasets",
    "has_citations",
    "has_references",
    "has_review",
    "next_availability",
    "next_read",
    "next_search",
    "next_workflow_from_result",
    "next_sources_from_result",
    "next_read_from_result",
  ];
  return detailed
    ? [
        ...base,
        "has_author",
        "has_venue",
        "next_get",
        "next_pdf",
        "next_fulltext",
        "next_code",
        "next_datasets",
        "next_citations",
        "next_references",
        "next_review",
        "next_author",
        "next_venue",
        "capabilities",
        "commands",
      ]
    : base;
}

function sourceFilter(opts: { source?: string; sources?: string }): {
  explicit: boolean;
  sources: string[];
} {
  if (opts.source) return { explicit: true, sources: [opts.source] };
  if (opts.sources)
    return { explicit: true, sources: resolveScholarSources(opts.sources) };
  return { explicit: false, sources: [] };
}

function resolveAvailabilityCapabilitySources(
  capability: ScholarCapability,
  route: ScholarlyReferenceRoute,
  opts: { source?: string; sources?: string },
): string[] {
  const filter = sourceFilter(opts);
  const selected = filter.explicit
    ? filter.sources
    : route.kind === "unknown"
      ? listScholarSourcesByCapability(capability)
      : route.preferredSources;
  return selected.filter((source) => {
    const adapter = getAllAdapters().find(
      (candidate) => candidate.name === source,
    );
    return adapter
      ? findScholarCommandByCapability(adapter, capability) !== undefined
      : false;
  });
}

function collectSourceErrors(outcomes: FanoutOutcome[]): string[] {
  const sourcesWithRecords = new Set(
    outcomes
      .filter((outcome) => outcome.records.length > 0)
      .map((outcome) => outcome.source),
  );
  const unresolvedErrors = outcomes.filter(
    (outcome) => outcome.error && !sourcesWithRecords.has(outcome.source),
  );
  const sourcesWithSpecificErrors = new Set(
    unresolvedErrors
      .filter((outcome) => outcome.error?.code !== "capability_unsupported")
      .map((outcome) => outcome.source),
  );
  return uniqueStrings(
    unresolvedErrors
      .filter(
        (outcome) =>
          outcome.error?.code !== "capability_unsupported" ||
          !sourcesWithSpecificErrors.has(outcome.source),
      )
      .map(formatScholarOutcomeError),
  ).slice(0, 16);
}

export function buildScholarAvailabilityRow(
  input: ScholarAvailabilityInputs,
): ScholarAvailabilityRow {
  const allRecords = reciprocalRankFusion(
    [
      input.metadataRecords,
      input.pdfRecords,
      input.codeRecords,
      input.datasetRecords,
    ],
    { topN: 10 },
  );
  const representative = allRecords[0];
  const firstPdf = firstPdfRecord(input.pdfRecords);
  const codeRecord = input.codeRecords.find(hasCodeResource);
  const datasetRecord = input.datasetRecords.find(hasDatasetResource);
  const modelRecord = input.datasetRecords.find(hasModelResource);
  const spaceRecord = input.datasetRecords.find(hasSpaceResource);
  const hasRecord = representative !== undefined;
  const hasPdf = firstPdf !== undefined;
  const hasCode = codeRecord !== undefined;
  const hasDataset = datasetRecord !== undefined;
  const hasModel = modelRecord !== undefined;
  const hasSpace = spaceRecord !== undefined;
  const hasProject =
    (codeRecord !== undefined &&
      nonEmptyResourceField(codeRecord.project_url)) ||
    (representative !== undefined &&
      nonEmptyResourceField(representative.project_url));
  const codeCandidateSources = resolveAvailabilityCapabilitySources(
    "scholar.code",
    input.route,
    input.opts,
  );
  const datasetCandidateSources = resolveAvailabilityCapabilitySources(
    "scholar.datasets",
    input.route,
    input.opts,
  );
  const canonical = canonicalScholarReference(input.route, allRecords);
  const commandRef = canonical?.ref ?? input.ref;
  const reviewRef =
    canonical?.kind === "openreview" ? canonical.ref : input.ref;

  return {
    ref: input.ref,
    route_kind: input.route.kind,
    route_value: input.route.value,
    canonical_ref: canonical?.ref,
    canonical_ref_kind: canonical?.kind,
    record_found: hasRecord,
    id: representative?.id,
    title: representative?.title,
    year: representative?.year,
    doi: representative?.doi,
    arxiv_id: representative?.arxiv_id,
    pmid: representative?.pmid,
    pmc_id: representative?.pmc_id,
    openreview_id: representative?.openreview_id,
    source_adapter: representative?.source_adapter,
    source_url: representative?.source_url,
    pdf_url: firstPdf?.pdf_url,
    code_url: codeRecord?.code_url,
    project_url: codeRecord?.project_url ?? representative?.project_url,
    dataset_url: datasetRecord?.dataset_url,
    model_urls: modelRecord?.model_urls,
    dataset_urls: datasetRecord?.dataset_urls,
    space_urls: spaceRecord?.space_urls,
    has_pdf: hasPdf,
    has_fulltext_candidate: input.fulltextCandidateSources.length > 0,
    has_code: hasCode,
    has_project: hasProject,
    has_datasets: hasDataset,
    has_models: hasModel,
    has_spaces: hasSpace,
    metadata_sources: sourcesForRecords(input.metadataRecords),
    pdf_sources: sourcesForRecords(
      input.pdfRecords,
      (record) => firstPdfRecord([record]) !== undefined,
    ),
    fulltext_candidate_sources: input.fulltextCandidateSources,
    code_sources: sourcesForRecords(input.codeRecords, hasCodeResource),
    dataset_sources: sourcesForRecords(
      input.datasetRecords,
      (record) =>
        hasDatasetResource(record) ||
        hasModelResource(record) ||
        hasSpaceResource(record),
    ),
    citation_candidate_sources: input.citationCandidateSources,
    reference_candidate_sources: input.referenceCandidateSources,
    review_candidate_sources: input.reviewCandidateSources,
    next_workflow: scholarCommand("workflow", commandRef, input.opts),
    next_availability: scholarCommand("availability", commandRef, input.opts),
    next_evidence: scholarCommand("evidence", commandRef, input.opts),
    next_reproduce: scholarCommand("reproduce", commandRef, input.opts),
    next_get: scholarCommand("get", commandRef, input.opts),
    next_pdf: scholarCommand("pdf", commandRef, input.opts),
    next_read:
      hasPdf || input.fulltextCandidateSources.length > 0
        ? scholarCommand("read", commandRef, input.opts)
        : undefined,
    next_download: hasPdf
      ? scholarCommand("download", commandRef, input.opts)
      : undefined,
    next_code:
      input.codeRecords.length > 0 || codeCandidateSources.length > 0
        ? scholarCommand("code", commandRef, {
            source: input.opts.source,
            sources: input.opts.sources,
          })
        : undefined,
    next_datasets:
      input.datasetRecords.length > 0 || datasetCandidateSources.length > 0
        ? scholarCommand("datasets", commandRef, {
            source: input.opts.source,
            sources: input.opts.sources,
          })
        : undefined,
    next_citations:
      input.citationCandidateSources.length > 0
        ? scholarCommand("citations", commandRef, {
            source: input.opts.source,
            sources: input.opts.sources,
          })
        : undefined,
    next_references:
      input.referenceCandidateSources.length > 0
        ? scholarCommand("references", commandRef, {
            source: input.opts.source,
            sources: input.opts.sources,
          })
        : undefined,
    next_reviews:
      input.reviewCandidateSources.length > 0
        ? scholarCommand("reviews", reviewRef, {
            source: input.opts.source,
            sources: input.opts.sources,
          })
        : undefined,
    source_errors: input.sourceErrors,
    retrieved_at: new Date().toISOString(),
  };
}

function rowBoolean(row: ScholarAvailabilityRow, field: string): boolean {
  return row[field] === true;
}

function rowString(
  row: ScholarAvailabilityRow,
  field: string,
): string | undefined {
  const candidate = row[field];
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate
    : undefined;
}

function rowStringArray(row: ScholarAvailabilityRow, field: string): string[] {
  const candidate = row[field];
  if (!Array.isArray(candidate)) return [];
  return candidate.filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.trim().length > 0,
  );
}

type ScholarCanonicalLookupOpts = {
  source?: string;
  sources?: string;
  unpaywallEmail?: string;
};

function canonicalReferenceLookupOpts(
  opts: ScholarCanonicalLookupOpts,
): ScholarCanonicalLookupOpts {
  return {
    sources: CANONICAL_REFERENCE_SOURCES.join(","),
    unpaywallEmail: opts.unpaywallEmail,
  };
}

async function resolveUnknownRefViaAvailability(
  ref: string,
  opts: ScholarCanonicalLookupOpts,
  input: { fallbackToCanonicalSources: boolean },
): Promise<string> {
  if (resolveScholarReference(ref).kind !== "unknown") return ref;
  const scoped = await collectAvailabilityEvidence(ref, opts);
  const scopedRef = rowString(scoped.row, "canonical_ref");
  if (scopedRef) return scopedRef;
  if (!input.fallbackToCanonicalSources || (!opts.source && !opts.sources)) {
    return ref;
  }
  const broad = await collectAvailabilityEvidence(
    ref,
    canonicalReferenceLookupOpts(opts),
  );
  return rowString(broad.row, "canonical_ref") ?? ref;
}

async function resolveGraphLookupRef(
  capability: ScholarCapability,
  ref: string,
  opts: {
    source?: string;
    sources?: string;
    unpaywallEmail?: string;
  },
): Promise<string> {
  if (
    capability !== "scholar.citations" &&
    capability !== "scholar.references"
  ) {
    return ref;
  }
  return resolveUnknownRefViaAvailability(ref, opts, {
    fallbackToCanonicalSources: true,
  });
}

async function resolveArtifactLookupRef(
  ref: string,
  opts: ScholarCanonicalLookupOpts,
): Promise<string> {
  if (!opts.source && !opts.sources) return ref;
  return resolveUnknownRefViaAvailability(ref, opts, {
    fallbackToCanonicalSources: true,
  });
}

function availabilityIdentifiers(row: ScholarAvailabilityRow): string[] {
  return [
    rowString(row, "doi") ? `doi:${rowString(row, "doi")}` : undefined,
    rowString(row, "arxiv_id")
      ? `arxiv:${rowString(row, "arxiv_id")}`
      : undefined,
    rowString(row, "pmid") ? `pmid:${rowString(row, "pmid")}` : undefined,
    rowString(row, "pmc_id") ? `pmc:${rowString(row, "pmc_id")}` : undefined,
    rowString(row, "openreview_id")
      ? `openreview:${rowString(row, "openreview_id")}`
      : undefined,
  ].filter((entry): entry is string => entry !== undefined);
}

function availabilityPrimarySource(
  row: ScholarAvailabilityRow,
): string | undefined {
  return (
    rowString(row, "source_adapter") ??
    rowStringArray(row, "metadata_sources")[0] ??
    rowStringArray(row, "pdf_sources")[0] ??
    rowStringArray(row, "fulltext_candidate_sources")[0] ??
    rowStringArray(row, "code_sources")[0] ??
    rowStringArray(row, "dataset_sources")[0]
  );
}

function availabilityPrimaryEvidenceUrl(
  row: ScholarAvailabilityRow,
): string | undefined {
  return (
    rowString(row, "source_url") ??
    rowString(row, "pdf_url") ??
    rowString(row, "project_url") ??
    rowString(row, "code_url") ??
    rowString(row, "dataset_url")
  );
}

function availabilityMissingEvidence(row: ScholarAvailabilityRow): string[] {
  const missing: string[] = [];
  if (!rowBoolean(row, "record_found")) missing.push("metadata");
  if (
    !rowBoolean(row, "has_pdf") &&
    !rowBoolean(row, "has_fulltext_candidate")
  ) {
    missing.push("readable-text");
  }
  if (!rowBoolean(row, "has_code") && !rowBoolean(row, "has_project")) {
    missing.push("code/project");
  }
  if (
    !rowBoolean(row, "has_datasets") &&
    !rowBoolean(row, "has_models") &&
    !rowBoolean(row, "has_spaces")
  ) {
    missing.push("datasets/models/spaces");
  }
  if (
    rowStringArray(row, "citation_candidate_sources").length === 0 &&
    rowStringArray(row, "reference_candidate_sources").length === 0
  ) {
    missing.push("citation/reference-graph");
  }
  if (rowStringArray(row, "review_candidate_sources").length === 0) {
    missing.push("peer-review-audit");
  }
  return missing;
}

function sourceRecordsForCapability(
  outcomes: FanoutOutcome[],
  source: string,
  capability: ScholarCapability,
): ScholarlyWorkRecord[] {
  return outcomes
    .filter(
      (outcome) =>
        outcome.source === source && outcome.capability === capability,
    )
    .flatMap((outcome) => outcome.records);
}

function sourceOutcomeErrors(
  outcomes: FanoutOutcome[],
  source: string,
): string[] {
  return uniqueStrings(
    outcomes
      .filter((outcome) => outcome.source === source && outcome.error)
      .map(formatScholarOutcomeError),
  );
}

function sourceBlockingErrors(
  outcomes: FanoutOutcome[],
  source: string,
): string[] {
  return uniqueStrings(
    outcomes
      .filter(
        (outcome) =>
          outcome.source === source &&
          outcome.error &&
          outcome.error.code !== "capability_unsupported",
      )
      .map(formatScholarOutcomeError),
  );
}

function sourceCapabilities(source: string): string[] {
  const adapter = getAllAdapters().find(
    (candidate) => candidate.name === source,
  );
  if (!adapter) return [];
  const capabilities = new Set<string>();
  for (const command of Object.values(adapter.commands)) {
    for (const capability of command.capabilities ?? []) {
      if (capability.startsWith("scholar.")) capabilities.add(capability);
    }
  }
  return [...capabilities].sort();
}

function scholarCapabilitySetFromStrings(
  capabilities: readonly string[],
): Set<ScholarCapability> {
  return new Set(
    capabilities.filter((capability): capability is ScholarCapability =>
      (SCHOLAR_CAPABILITIES as readonly string[]).includes(capability),
    ),
  );
}

function sourceSearchCommandByName(source: string): string | undefined {
  const adapter = getAllAdapters().find(
    (candidate) => candidate.name === source,
  );
  return adapter ? sourceSearchCommand(adapter) : undefined;
}

function sourceScopedScholarCommand(
  subcommand: string,
  ref: string,
  source: string,
  opts: { unpaywallEmail?: string } = {},
): string {
  return scholarCommand(subcommand, ref, {
    source,
    unpaywallEmail: opts.unpaywallEmail,
  });
}

function sourceStatus(input: {
  hasReturnedEvidence: boolean;
  hasCandidateEvidence: boolean;
  hasBlockingErrors: boolean;
  hasOnlyUnsupportedErrors: boolean;
}): string {
  if (input.hasReturnedEvidence) return "evidence_found";
  if (input.hasCandidateEvidence && input.hasBlockingErrors)
    return "candidate_with_errors";
  if (input.hasCandidateEvidence) return "candidate_only";
  if (input.hasBlockingErrors) return "error";
  if (input.hasOnlyUnsupportedErrors) return "unsupported";
  return "no_evidence";
}

function sourceAuditEvidenceTypes(input: {
  hasMetadata: boolean;
  hasPdf: boolean;
  hasFulltextCandidate: boolean;
  hasCode: boolean;
  hasProject: boolean;
  hasDatasets: boolean;
  hasModels: boolean;
  hasSpaces: boolean;
  hasCitationCandidate: boolean;
  hasReferenceCandidate: boolean;
  hasReviewCandidate: boolean;
}): string[] {
  const evidence: string[] = [];
  if (input.hasMetadata) evidence.push("metadata");
  if (input.hasPdf) evidence.push("pdf");
  if (input.hasFulltextCandidate) evidence.push("fulltext-candidate");
  if (input.hasCode) evidence.push("code");
  if (input.hasProject) evidence.push("project");
  if (input.hasDatasets) evidence.push("datasets");
  if (input.hasModels) evidence.push("models");
  if (input.hasSpaces) evidence.push("spaces");
  if (input.hasCitationCandidate) evidence.push("citation-candidate");
  if (input.hasReferenceCandidate) evidence.push("reference-candidate");
  if (input.hasReviewCandidate) evidence.push("review-candidate");
  return evidence;
}

export function buildScholarSourceAuditRows(
  availability: ScholarAvailabilityRow,
  outcomes: FanoutOutcome[],
  opts: { unpaywallEmail?: string } = {},
): ScholarSourceAuditRow[] {
  const ref = String(availability.ref ?? "");
  const commandRef = rowString(availability, "canonical_ref") ?? ref;
  const canonicalRefKind = rowString(availability, "canonical_ref_kind");
  const reviewRef = canonicalRefKind === "openreview" ? commandRef : ref;
  const sources = uniqueStrings([
    ...outcomes.map((outcome) => outcome.source),
    ...rowStringArray(availability, "metadata_sources"),
    ...rowStringArray(availability, "pdf_sources"),
    ...rowStringArray(availability, "fulltext_candidate_sources"),
    ...rowStringArray(availability, "code_sources"),
    ...rowStringArray(availability, "dataset_sources"),
    ...rowStringArray(availability, "citation_candidate_sources"),
    ...rowStringArray(availability, "reference_candidate_sources"),
    ...rowStringArray(availability, "review_candidate_sources"),
  ]);

  return sources.map((source) => {
    const metadataRecords = sourceRecordsForCapability(
      outcomes,
      source,
      "scholar.get",
    );
    const pdfRecords = sourceRecordsForCapability(
      outcomes,
      source,
      "scholar.pdf",
    );
    const pdfEvidenceRecords = pdfRecords.filter(
      (record) => firstPdfRecord([record]) !== undefined,
    );
    const codeRecords = sourceRecordsForCapability(
      outcomes,
      source,
      "scholar.code",
    );
    const codeEvidenceRecords = codeRecords.filter(hasCodeResource);
    const datasetRecords = sourceRecordsForCapability(
      outcomes,
      source,
      "scholar.datasets",
    );
    const datasetEvidenceRecords = datasetRecords.filter(
      (record) =>
        hasDatasetResource(record) ||
        hasModelResource(record) ||
        hasSpaceResource(record),
    );
    const sourceRecords = reciprocalRankFusion(
      [
        metadataRecords,
        pdfEvidenceRecords,
        codeEvidenceRecords,
        datasetEvidenceRecords,
      ],
      { topN: 10 },
    );
    const representative = sourceRecords[0];
    const firstPdf = firstPdfRecord(pdfEvidenceRecords);
    const codeRecord = codeEvidenceRecords.find(hasCodeResource);
    const datasetRecord = datasetEvidenceRecords.find(hasDatasetResource);
    const modelRecord = datasetEvidenceRecords.find(hasModelResource);
    const spaceRecord = datasetEvidenceRecords.find(hasSpaceResource);
    const hasMetadata = metadataRecords.length > 0;
    const hasPdf = firstPdf !== undefined;
    const hasCode = codeRecord !== undefined;
    const hasProject =
      (codeRecord !== undefined &&
        nonEmptyResourceField(codeRecord.project_url)) ||
      (representative !== undefined &&
        nonEmptyResourceField(representative.project_url));
    const hasDatasets = datasetRecord !== undefined;
    const hasModels = modelRecord !== undefined;
    const hasSpaces = spaceRecord !== undefined;
    const hasFulltextCandidate = rowStringArray(
      availability,
      "fulltext_candidate_sources",
    ).includes(source);
    const hasCitationCandidate = rowStringArray(
      availability,
      "citation_candidate_sources",
    ).includes(source);
    const hasReferenceCandidate = rowStringArray(
      availability,
      "reference_candidate_sources",
    ).includes(source);
    const hasReviewCandidate = rowStringArray(
      availability,
      "review_candidate_sources",
    ).includes(source);
    const evidenceTypes = sourceAuditEvidenceTypes({
      hasMetadata,
      hasPdf,
      hasFulltextCandidate,
      hasCode,
      hasProject,
      hasDatasets,
      hasModels,
      hasSpaces,
      hasCitationCandidate,
      hasReferenceCandidate,
      hasReviewCandidate,
    });
    const errors = sourceOutcomeErrors(outcomes, source);
    const rawBlockingErrors = sourceBlockingErrors(outcomes, source);
    const capabilities = sourceCapabilities(source);
    const capabilitySet = scholarCapabilitySetFromStrings(capabilities);
    const adapter = getAllAdapters().find(
      (candidate) => candidate.name === source,
    );
    const hasSourceScopedAvailability =
      adapter !== undefined
        ? adapterSupportsSourceScopedAvailability(adapter, capabilitySet)
        : supportsSourceScopedAvailability(capabilitySet);
    const hasSearch = capabilitySet.has("scholar.search");
    const candidateCapabilities = [
      hasFulltextCandidate ? "scholar.fulltext" : undefined,
      hasCitationCandidate ? "scholar.citations" : undefined,
      hasReferenceCandidate ? "scholar.references" : undefined,
      hasReviewCandidate ? "scholar.review" : undefined,
    ].filter((capability): capability is string => capability !== undefined);
    const executedCapabilities = uniqueStrings(
      outcomes
        .filter((outcome) => outcome.source === source)
        .map((outcome) => outcome.capability),
    );
    const hasReturnedEvidence =
      hasMetadata ||
      hasPdf ||
      hasCode ||
      hasProject ||
      hasDatasets ||
      hasModels ||
      hasSpaces;
    const hasCandidateEvidence = candidateCapabilities.length > 0;
    const blockingErrors = hasReturnedEvidence ? [] : rawBlockingErrors;
    const recoveredErrors = hasReturnedEvidence ? rawBlockingErrors : [];
    const hasOnlyUnsupportedErrors =
      errors.length > 0 && blockingErrors.length === 0;

    return {
      ref,
      route_kind: availability.route_kind,
      canonical_ref: availability.canonical_ref,
      canonical_ref_kind: availability.canonical_ref_kind,
      source,
      source_status: sourceStatus({
        hasReturnedEvidence,
        hasCandidateEvidence,
        hasBlockingErrors: blockingErrors.length > 0,
        hasOnlyUnsupportedErrors,
      }),
      evidence_types: evidenceTypes,
      handoff_strategy: coverageHandoffStrategy(capabilitySet, adapter),
      record_count: sourceRecords.length,
      has_metadata: hasMetadata,
      has_pdf: hasPdf,
      has_fulltext_candidate: hasFulltextCandidate,
      has_code: hasCode,
      has_project: hasProject,
      has_datasets: hasDatasets,
      has_models: hasModels,
      has_spaces: hasSpaces,
      has_citation_candidate: hasCitationCandidate,
      has_reference_candidate: hasReferenceCandidate,
      has_review_candidate: hasReviewCandidate,
      title: representative?.title,
      year: representative?.year,
      primary_evidence_url:
        representative?.source_url ??
        firstPdf?.pdf_url ??
        codeRecord?.project_url ??
        codeRecord?.code_url ??
        datasetRecord?.dataset_url,
      pdf_url: firstPdf?.pdf_url,
      code_url: codeRecord?.code_url,
      project_url: codeRecord?.project_url ?? representative?.project_url,
      dataset_url: datasetRecord?.dataset_url,
      model_urls: modelRecord?.model_urls,
      dataset_urls: datasetRecord?.dataset_urls,
      space_urls: spaceRecord?.space_urls,
      capabilities,
      executed_capabilities: executedCapabilities,
      candidate_capabilities: candidateCapabilities,
      source_errors: errors,
      blocking_errors: blockingErrors,
      recovered_errors: recoveredErrors,
      next_source_availability: hasSourceScopedAvailability
        ? sourceScopedScholarCommand("availability", commandRef, source, opts)
        : undefined,
      next_search: hasSearch ? sourceSearchCommandByName(source) : undefined,
      next_workflow_from_result: hasSearch
        ? "unicli scholar workflow <title-or-id>"
        : undefined,
      next_sources_from_result: hasSearch
        ? "unicli scholar sources <title-or-id>"
        : undefined,
      next_read_from_result: hasSearch
        ? "unicli scholar read <title-or-id>"
        : undefined,
      next_read:
        hasPdf || hasFulltextCandidate
          ? sourceScopedScholarCommand("read", commandRef, source, opts)
          : undefined,
      next_download: hasPdf
        ? sourceScopedScholarCommand("download", commandRef, source, opts)
        : undefined,
      next_code:
        hasCode || capabilities.includes("scholar.code")
          ? sourceScopedScholarCommand("code", commandRef, source, opts)
          : undefined,
      next_datasets:
        hasDatasets ||
        hasModels ||
        hasSpaces ||
        capabilities.includes("scholar.datasets")
          ? sourceScopedScholarCommand("datasets", commandRef, source, opts)
          : undefined,
      next_citations: hasCitationCandidate
        ? sourceScopedScholarCommand("citations", commandRef, source, opts)
        : undefined,
      next_references: hasReferenceCandidate
        ? sourceScopedScholarCommand("references", commandRef, source, opts)
        : undefined,
      next_reviews: hasReviewCandidate
        ? sourceScopedScholarCommand("reviews", reviewRef, source, opts)
        : undefined,
      next_reproduce:
        hasReturnedEvidence || hasCandidateEvidence
          ? sourceScopedScholarCommand("reproduce", commandRef, source, opts)
          : undefined,
      retrieved_at: new Date().toISOString(),
    };
  });
}

function sourceAuditColumns(detailed = false): string[] {
  const base = [
    "ref",
    "route_kind",
    "canonical_ref",
    "canonical_ref_kind",
    "source",
    "source_status",
    "evidence_types",
    "handoff_strategy",
    "record_count",
    "has_metadata",
    "has_pdf",
    "has_fulltext_candidate",
    "has_code",
    "has_datasets",
    "has_citation_candidate",
    "has_reference_candidate",
    "has_review_candidate",
    "title",
    "year",
    "next_source_availability",
    "next_search",
    "next_workflow_from_result",
    "next_sources_from_result",
    "next_read_from_result",
    "next_read",
    "next_reproduce",
  ];
  return detailed
    ? [
        ...base,
        "has_project",
        "has_models",
        "has_spaces",
        "primary_evidence_url",
        "pdf_url",
        "code_url",
        "project_url",
        "dataset_url",
        "model_urls",
        "dataset_urls",
        "space_urls",
        "capabilities",
        "executed_capabilities",
        "candidate_capabilities",
        "source_errors",
        "blocking_errors",
        "recovered_errors",
        "next_download",
        "next_code",
        "next_datasets",
        "next_citations",
        "next_references",
        "next_reviews",
        "retrieved_at",
      ]
    : base;
}

function availabilityHasReadableSource(row: ScholarAvailabilityRow): boolean {
  return (
    rowBoolean(row, "has_pdf") || rowBoolean(row, "has_fulltext_candidate")
  );
}

function availabilityHasPrimaryAnchor(row: ScholarAvailabilityRow): boolean {
  return (
    availabilityIdentifiers(row).length > 0 ||
    availabilityPrimaryEvidenceUrl(row) !== undefined
  );
}

function availabilityHasResourceEvidence(row: ScholarAvailabilityRow): boolean {
  return (
    rowBoolean(row, "has_code") ||
    rowBoolean(row, "has_project") ||
    rowBoolean(row, "has_datasets") ||
    rowBoolean(row, "has_models") ||
    rowBoolean(row, "has_spaces")
  );
}

function workflowStep(
  order: number,
  step: string,
  status: string,
  input: {
    command?: string;
    commands?: string[];
    doneWhen: string;
    guard: string;
  },
): ScholarWorkflowStep {
  return Object.fromEntries(
    definedEntries({
      order,
      step,
      status,
      command: input.command,
      commands:
        input.commands && input.commands.length > 0
          ? input.commands
          : undefined,
      done_when: input.doneWhen,
      guard: input.guard,
    }),
  ) as unknown as ScholarWorkflowStep;
}

function workflowStatus(
  recordFound: boolean,
  hasPrimaryAnchor: boolean,
  hasReadableSource: boolean,
  hasResourceEvidence: boolean,
): string {
  if (!recordFound) return "blocked_no_source_record";
  if (!hasPrimaryAnchor) return "metadata_without_primary_anchor";
  if (!hasReadableSource && hasResourceEvidence)
    return "resources_found_needs_source_text";
  if (!hasReadableSource) return "metadata_only_needs_source_text";
  return "ready_for_agent_reading";
}

function workflowNextStep(
  recordFound: boolean,
  hasPrimaryAnchor: boolean,
  hasReadableSource: boolean,
): string {
  if (!recordFound) return "resolve_source_record";
  if (!hasPrimaryAnchor) return "verify_primary_anchor";
  if (!hasReadableSource) return "find_readable_source";
  return "run_next_read_before_quoting_claims";
}

function completedWorkflowSteps(
  availability: ScholarAvailabilityRow,
  hasPrimaryAnchor: boolean,
  hasReadableSource: boolean,
  hasResourceEvidence: boolean,
): string[] {
  const completed: string[] = [];
  if (rowBoolean(availability, "record_found"))
    completed.push("source_record_found");
  if (hasPrimaryAnchor) completed.push("primary_anchor_found");
  if (hasReadableSource) completed.push("readable_source_found");
  if (rowString(availability, "next_download"))
    completed.push("downloadable_pdf_found");
  if (
    rowString(availability, "next_citations") ||
    rowString(availability, "next_references")
  ) {
    completed.push("citation_reference_candidate_found");
  }
  if (rowString(availability, "next_reviews"))
    completed.push("peer_review_candidate_found");
  if (hasResourceEvidence) completed.push("reproducibility_resource_found");
  return completed;
}

function pendingWorkflowSteps(
  availability: ScholarAvailabilityRow,
  hasPrimaryAnchor: boolean,
  hasReadableSource: boolean,
  hasResourceEvidence: boolean,
): string[] {
  const pending: string[] = [];
  const recordFound = rowBoolean(availability, "record_found");
  if (!recordFound) pending.push("source_record");
  if (recordFound && !hasPrimaryAnchor) pending.push("primary_anchor");
  if (recordFound && !hasReadableSource) pending.push("readable_source");
  if (hasReadableSource) pending.push("source_text_reading");
  if (
    !rowString(availability, "next_citations") &&
    !rowString(availability, "next_references")
  ) {
    pending.push("citation_reference_graph");
  }
  if (!rowString(availability, "next_reviews"))
    pending.push("peer_review_audit");
  if (!hasResourceEvidence) pending.push("code_data_model_resources");
  if (hasResourceEvidence) pending.push("resource_inspection");
  return pending;
}

function blockedWorkflowSteps(
  availability: ScholarAvailabilityRow,
  hasReadableSource: boolean,
  hasResourceEvidence: boolean,
): string[] {
  const blocked: string[] = [];
  const recordFound = rowBoolean(availability, "record_found");
  if (!recordFound) {
    return [
      "source_reading",
      "claim_quotation",
      "artifact_download",
      "citation_reference_audit",
      "peer_review_audit",
      "reproducibility_audit",
    ];
  }
  if (!hasReadableSource) {
    blocked.push("source_reading");
    blocked.push("claim_quotation");
    blocked.push("artifact_download");
  }
  if (
    !rowString(availability, "next_citations") &&
    !rowString(availability, "next_references")
  ) {
    blocked.push("citation_reference_audit");
  }
  if (!rowString(availability, "next_reviews"))
    blocked.push("peer_review_audit");
  if (!hasResourceEvidence) blocked.push("reproducibility_installation");
  return blocked;
}

function workflowRunbook(
  availability: ScholarAvailabilityRow,
  recordFound: boolean,
): ScholarWorkflowStep[] {
  const graphCommands = [
    rowString(availability, "next_citations"),
    rowString(availability, "next_references"),
  ].filter((command): command is string => command !== undefined);
  const resourceCommands = [
    rowString(availability, "next_code"),
    rowString(availability, "next_datasets"),
  ].filter((command): command is string => command !== undefined);

  return [
    workflowStep(
      1,
      "availability_audit",
      recordFound ? "complete" : "blocked",
      {
        command: rowString(availability, "next_availability"),
        doneWhen: "record_found is true and source_errors are inspected",
        guard:
          "do not cite, download, or reproduce without a source-backed record",
      },
    ),
    workflowStep(
      2,
      "evidence_classification",
      recordFound ? "ready" : "blocked",
      {
        command: rowString(availability, "next_evidence"),
        doneWhen: "citation_safety and claim_boundary are explicit",
        guard: "metadata-only evidence cannot support paper claims",
      },
    ),
    workflowStep(
      3,
      "read_source_text",
      rowString(availability, "next_read") ? "ready" : "blocked",
      {
        command: rowString(availability, "next_read"),
        doneWhen: "source-direct full text or extracted PDF text is returned",
        guard: "quote claims only from the returned source text",
      },
    ),
    workflowStep(
      4,
      "download_artifact",
      rowString(availability, "next_download") ? "ready" : "blocked",
      {
        command: rowString(availability, "next_download"),
        doneWhen: "local artifact metadata is returned for a source-backed PDF",
        guard: "download only after a PDF candidate exists",
      },
    ),
    workflowStep(
      5,
      "citation_reference_audit",
      graphCommands.length > 0 ? "ready" : "blocked",
      {
        commands: graphCommands,
        doneWhen:
          "citation and reference rows are retrieved from graph-capable sources",
        guard:
          "graph rows are provenance evidence, not a substitute for reading the paper",
      },
    ),
    workflowStep(
      6,
      "peer_review_audit",
      rowString(availability, "next_reviews") ? "ready" : "blocked",
      {
        command: rowString(availability, "next_reviews"),
        doneWhen:
          "review, decision, rebuttal, or comment rows are retrieved when available",
        guard:
          "review rows qualify venue context but do not replace source text",
      },
    ),
    workflowStep(7, "reproducibility_plan", recordFound ? "ready" : "blocked", {
      command: rowString(availability, "next_reproduce"),
      doneWhen: "install_readiness and execution_boundary are explicit",
      guard: "never clone, install, or run remote code during planning",
    }),
    workflowStep(
      8,
      "inspect_code_and_resources",
      resourceCommands.length > 0 ? "ready" : "blocked",
      {
        commands: resourceCommands,
        doneWhen: "code, dataset, model, or Space resource rows are inspected",
        guard:
          "inspect repository and data provenance before any install command",
      },
    ),
  ];
}

export function buildScholarWorkflowRow(
  availability: ScholarAvailabilityRow,
): ScholarWorkflowRow {
  const recordFound = rowBoolean(availability, "record_found");
  const hasReadableSource = availabilityHasReadableSource(availability);
  const hasPrimaryAnchor = availabilityHasPrimaryAnchor(availability);
  const hasResourceEvidence = availabilityHasResourceEvidence(availability);

  return {
    ref: availability.ref,
    route_kind: availability.route_kind,
    canonical_ref: availability.canonical_ref,
    canonical_ref_kind: availability.canonical_ref_kind,
    workflow_status: workflowStatus(
      recordFound,
      hasPrimaryAnchor,
      hasReadableSource,
      hasResourceEvidence,
    ),
    next_step: workflowNextStep(
      recordFound,
      hasPrimaryAnchor,
      hasReadableSource,
    ),
    claim_boundary: hasReadableSource
      ? "quote_claims_only_after_next_read_output"
      : "metadata_only_no_claim_extraction",
    execution_boundary: "no_download_clone_install_or_remote_code_execution",
    record_found: recordFound,
    title: availability.title,
    year: availability.year,
    primary_source: availabilityPrimarySource(availability),
    primary_evidence_url: availabilityPrimaryEvidenceUrl(availability),
    persistent_identifiers: availabilityIdentifiers(availability),
    readable_sources: uniqueStrings([
      ...rowStringArray(availability, "fulltext_candidate_sources"),
      ...rowStringArray(availability, "pdf_sources"),
    ]),
    resource_sources: uniqueStrings([
      ...rowStringArray(availability, "code_sources"),
      ...rowStringArray(availability, "dataset_sources"),
    ]),
    graph_sources: uniqueStrings([
      ...rowStringArray(availability, "citation_candidate_sources"),
      ...rowStringArray(availability, "reference_candidate_sources"),
    ]),
    review_sources: rowStringArray(availability, "review_candidate_sources"),
    completed_steps: completedWorkflowSteps(
      availability,
      hasPrimaryAnchor,
      hasReadableSource,
      hasResourceEvidence,
    ),
    pending_steps: pendingWorkflowSteps(
      availability,
      hasPrimaryAnchor,
      hasReadableSource,
      hasResourceEvidence,
    ),
    blocked_steps: blockedWorkflowSteps(
      availability,
      hasReadableSource,
      hasResourceEvidence,
    ),
    agent_runbook: workflowRunbook(availability, recordFound),
    next_workflow: availability.next_workflow,
    next_availability: availability.next_availability,
    next_evidence: availability.next_evidence,
    next_read: availability.next_read,
    next_download: availability.next_download,
    next_code: availability.next_code,
    next_datasets: availability.next_datasets,
    next_citations: availability.next_citations,
    next_references: availability.next_references,
    next_reviews: availability.next_reviews,
    next_reproduce: availability.next_reproduce,
    source_errors: availability.source_errors,
    retrieved_at: new Date().toISOString(),
  };
}

function workflowColumns(detailed = false): string[] {
  const base = [
    "ref",
    "route_kind",
    "canonical_ref",
    "canonical_ref_kind",
    "workflow_status",
    "next_step",
    "claim_boundary",
    "execution_boundary",
    "record_found",
    "title",
    "year",
    "completed_steps",
    "pending_steps",
    "blocked_steps",
    "next_read",
    "next_evidence",
    "next_reproduce",
  ];
  return detailed
    ? [
        ...base,
        "primary_source",
        "primary_evidence_url",
        "persistent_identifiers",
        "readable_sources",
        "resource_sources",
        "graph_sources",
        "review_sources",
        "agent_runbook",
        "next_workflow",
        "next_availability",
        "next_download",
        "next_code",
        "next_datasets",
        "next_citations",
        "next_references",
        "next_reviews",
        "source_errors",
        "retrieved_at",
      ]
    : base;
}

export function buildScholarEvidenceRow(
  availability: ScholarAvailabilityRow,
): ScholarEvidenceRow {
  const recordFound = rowBoolean(availability, "record_found");
  const hasPdf = rowBoolean(availability, "has_pdf");
  const hasFulltextCandidate = rowBoolean(
    availability,
    "has_fulltext_candidate",
  );
  const hasReadableSource = hasPdf || hasFulltextCandidate;
  const persistentIdentifiers = availabilityIdentifiers(availability);
  const primaryEvidenceUrl = availabilityPrimaryEvidenceUrl(availability);
  const hasPrimaryAnchor =
    persistentIdentifiers.length > 0 || primaryEvidenceUrl !== undefined;
  const hasResourceEvidence =
    rowBoolean(availability, "has_code") ||
    rowBoolean(availability, "has_project") ||
    rowBoolean(availability, "has_datasets") ||
    rowBoolean(availability, "has_models") ||
    rowBoolean(availability, "has_spaces");
  const evidenceStatus = !recordFound
    ? "unverified"
    : hasReadableSource && hasPrimaryAnchor
      ? "readable_source_verified"
      : hasReadableSource
        ? "readable_source_candidate"
        : hasPrimaryAnchor
          ? "metadata_verified"
          : hasResourceEvidence
            ? "resource_only"
            : "metadata_only";
  const citationSafety = !recordFound
    ? "do_not_cite_unverified"
    : hasReadableSource && hasPrimaryAnchor
      ? "cite_after_reading_source"
      : hasPrimaryAnchor
        ? "metadata_only_do_not_quote_claims"
        : "do_not_cite_without_identifier";
  const readiness = rowString(availability, "next_read")
    ? "read_now"
    : rowString(availability, "next_download")
      ? "download_then_read"
      : recordFound
        ? "metadata_or_resource_only"
        : "not_ready";
  const graphSources = uniqueStrings([
    ...rowStringArray(availability, "citation_candidate_sources"),
    ...rowStringArray(availability, "reference_candidate_sources"),
  ]);

  return {
    ref: availability.ref,
    route_kind: availability.route_kind,
    evidence_status: evidenceStatus,
    citation_safety: citationSafety,
    readiness,
    claim_boundary: hasReadableSource
      ? "quote_claims_only_after_next_read_output"
      : "metadata_only_no_claim_extraction",
    record_found: recordFound,
    title: availability.title,
    year: availability.year,
    primary_source: availabilityPrimarySource(availability),
    primary_evidence_url: primaryEvidenceUrl,
    persistent_identifiers: persistentIdentifiers,
    readable_sources: uniqueStrings([
      ...rowStringArray(availability, "fulltext_candidate_sources"),
      ...rowStringArray(availability, "pdf_sources"),
    ]),
    resource_sources: uniqueStrings([
      ...rowStringArray(availability, "code_sources"),
      ...rowStringArray(availability, "dataset_sources"),
    ]),
    graph_sources: graphSources,
    review_sources: rowStringArray(availability, "review_candidate_sources"),
    missing_evidence: availabilityMissingEvidence(availability),
    next_availability: availability.next_availability,
    next_read: availability.next_read,
    next_download: availability.next_download,
    next_code: availability.next_code,
    next_datasets: availability.next_datasets,
    next_citations: availability.next_citations,
    next_references: availability.next_references,
    next_reviews: availability.next_reviews,
    source_errors: availability.source_errors,
    retrieved_at: new Date().toISOString(),
  };
}

function evidenceColumns(detailed = false): string[] {
  const base = [
    "ref",
    "route_kind",
    "evidence_status",
    "citation_safety",
    "readiness",
    "claim_boundary",
    "record_found",
    "title",
    "year",
    "primary_source",
    "primary_evidence_url",
    "persistent_identifiers",
    "readable_sources",
    "resource_sources",
    "graph_sources",
    "review_sources",
    "missing_evidence",
    "next_read",
    "next_code",
    "next_datasets",
    "next_citations",
    "next_references",
    "next_reviews",
  ];
  return detailed
    ? [
        ...base,
        "next_availability",
        "next_download",
        "source_errors",
        "retrieved_at",
      ]
    : base;
}

function cloneCandidateUrl(row: ScholarAvailabilityRow): string | undefined {
  const codeUrl = rowString(row, "code_url");
  if (!codeUrl) return undefined;
  if (!/^https?:\/\//i.test(codeUrl)) return undefined;
  if (
    !/github\.com|gitlab\.com|bitbucket\.org|huggingface\.co/i.test(codeUrl)
  ) {
    return undefined;
  }
  return codeUrl.replace(/\/$/, "");
}

function availabilityReproducibilityMissing(
  row: ScholarAvailabilityRow,
): string[] {
  const missing: string[] = [];
  if (!rowString(row, "code_url")) missing.push("code-repository");
  if (!rowBoolean(row, "has_project")) missing.push("project-page");
  if (
    !rowBoolean(row, "has_datasets") &&
    !rowBoolean(row, "has_models") &&
    !rowBoolean(row, "has_spaces")
  ) {
    missing.push("datasets/models/spaces");
  }
  if (!rowString(row, "next_read")) missing.push("readable-paper");
  if (rowStringArray(row, "citation_candidate_sources").length === 0) {
    missing.push("citation-graph");
  }
  return missing;
}

export function buildScholarReproducibilityRow(
  availability: ScholarAvailabilityRow,
): ScholarReproducibilityRow {
  const hasCodeRepository = rowString(availability, "code_url") !== undefined;
  const hasProject = rowBoolean(availability, "has_project");
  const hasResource =
    rowBoolean(availability, "has_datasets") ||
    rowBoolean(availability, "has_models") ||
    rowBoolean(availability, "has_spaces");
  const cloneUrl = cloneCandidateUrl(availability);
  const reproducibilityStatus =
    hasCodeRepository && hasResource
      ? "code_and_resources_found"
      : hasCodeRepository
        ? "code_found"
        : hasProject && hasResource
          ? "project_and_resources_found"
          : hasProject
            ? "project_page_found"
            : hasResource
              ? "resources_without_code"
              : "no_reproducibility_resources";
  const installReadiness = cloneUrl
    ? "clone_candidate_requires_inspection"
    : hasCodeRepository
      ? "code_url_requires_manual_inspection"
      : hasProject
        ? "project_page_requires_manual_inspection"
        : hasResource
          ? "resource_only_no_install"
          : "not_ready";

  return {
    ref: availability.ref,
    route_kind: availability.route_kind,
    reproducibility_status: reproducibilityStatus,
    install_readiness: installReadiness,
    execution_boundary: "no_remote_code_executed",
    install_boundary:
      "inspect_repository_before_running_install_or_training_commands",
    record_found: availability.record_found,
    title: availability.title,
    year: availability.year,
    primary_source: availabilityPrimarySource(availability),
    primary_evidence_url: availabilityPrimaryEvidenceUrl(availability),
    code_url: availability.code_url,
    project_url: availability.project_url,
    clone_candidate_url: cloneUrl,
    dataset_url: availability.dataset_url,
    dataset_urls: availability.dataset_urls,
    model_urls: availability.model_urls,
    space_urls: availability.space_urls,
    resource_sources: uniqueStrings([
      ...rowStringArray(availability, "code_sources"),
      ...rowStringArray(availability, "dataset_sources"),
    ]),
    missing_reproducibility: availabilityReproducibilityMissing(availability),
    next_evidence: availability.next_evidence,
    next_read: availability.next_read,
    next_download: availability.next_download,
    next_code: availability.next_code,
    next_datasets: availability.next_datasets,
    next_inspect_code: availability.next_code,
    next_inspect_resources: availability.next_datasets,
    source_errors: availability.source_errors,
    retrieved_at: new Date().toISOString(),
  };
}

function reproducibilityColumns(detailed = false): string[] {
  const base = [
    "ref",
    "route_kind",
    "reproducibility_status",
    "install_readiness",
    "execution_boundary",
    "install_boundary",
    "record_found",
    "title",
    "year",
    "primary_source",
    "primary_evidence_url",
    "code_url",
    "project_url",
    "clone_candidate_url",
    "dataset_urls",
    "model_urls",
    "space_urls",
    "resource_sources",
    "missing_reproducibility",
    "next_evidence",
    "next_read",
    "next_code",
    "next_datasets",
  ];
  return detailed
    ? [
        ...base,
        "dataset_url",
        "next_download",
        "next_inspect_code",
        "next_inspect_resources",
        "source_errors",
        "retrieved_at",
      ]
    : base;
}

function availabilityColumns(detailed = false): string[] {
  const base = [
    "ref",
    "route_kind",
    "canonical_ref",
    "canonical_ref_kind",
    "record_found",
    "title",
    "doi",
    "arxiv_id",
    "pmid",
    "openreview_id",
    "has_pdf",
    "has_fulltext_candidate",
    "has_code",
    "has_project",
    "has_datasets",
    "has_models",
    "has_spaces",
    "metadata_sources",
    "pdf_sources",
    "fulltext_candidate_sources",
    "code_sources",
    "dataset_sources",
    "citation_candidate_sources",
    "reference_candidate_sources",
    "review_candidate_sources",
    "next_read",
    "next_download",
    "next_code",
    "next_datasets",
  ];
  return detailed
    ? [
        ...base,
        "route_value",
        "id",
        "year",
        "pmc_id",
        "source_adapter",
        "source_url",
        "pdf_url",
        "code_url",
        "project_url",
        "dataset_url",
        "model_urls",
        "dataset_urls",
        "space_urls",
        "next_workflow",
        "next_get",
        "next_pdf",
        "next_evidence",
        "next_reproduce",
        "next_citations",
        "next_references",
        "next_reviews",
        "source_errors",
        "retrieved_at",
      ]
    : base;
}

async function collectAvailabilityEvidence(
  ref: string,
  opts: {
    source?: string;
    sources?: string;
    unpaywallEmail?: string;
  },
): Promise<ScholarAvailabilityCollect> {
  const route = resolveScholarReference(ref);
  const metadata = await collectSingleRecords("scholar.get", ref, opts);
  const pdf = await collectPdfCandidates(ref, opts);
  const code = await collectResourceRecords("scholar.code", ref, opts);
  const datasets = await collectResourceRecords("scholar.datasets", ref, opts);
  const outcomes = [
    ...metadata.outcomes,
    ...pdf.outcomes,
    ...code.outcomes,
    ...datasets.outcomes,
  ];
  const row = buildScholarAvailabilityRow({
    ref,
    route,
    metadataRecords: metadata.records,
    pdfRecords: pdf.records,
    codeRecords: code.records,
    datasetRecords: datasets.records,
    fulltextCandidateSources: resolveAvailabilityCapabilitySources(
      "scholar.fulltext",
      route,
      opts,
    ),
    citationCandidateSources: resolveAvailabilityCapabilitySources(
      "scholar.citations",
      route,
      opts,
    ),
    referenceCandidateSources: resolveAvailabilityCapabilitySources(
      "scholar.references",
      route,
      opts,
    ),
    reviewCandidateSources: resolveAvailabilityCapabilitySources(
      "scholar.review",
      route,
      opts,
    ),
    sourceErrors: collectSourceErrors(outcomes),
    opts,
  });
  return { row, outcomes };
}

async function collectCanonicalSourceAuditOutcomes(
  availability: ScholarAvailabilityRow,
  opts: {
    source?: string;
    sources?: string;
    unpaywallEmail?: string;
  },
): Promise<FanoutOutcome[]> {
  const ref = String(availability.ref ?? "");
  const canonicalRef = rowString(availability, "canonical_ref");
  if (!canonicalRef || canonicalRef === ref) return [];
  const metadata = await collectSingleRecords(
    "scholar.get",
    canonicalRef,
    opts,
  );
  const pdf = await collectPdfCandidates(canonicalRef, opts);
  const code = await collectResourceRecords("scholar.code", canonicalRef, opts);
  const datasets = await collectResourceRecords(
    "scholar.datasets",
    canonicalRef,
    opts,
  );
  return [
    ...metadata.outcomes,
    ...pdf.outcomes,
    ...code.outcomes,
    ...datasets.outcomes,
  ];
}

function mergeCanonicalAvailability(
  original: ScholarAvailabilityCollect,
  canonical: ScholarAvailabilityCollect,
): ScholarAvailabilityCollect {
  return {
    row: {
      ...canonical.row,
      ref: original.row.ref,
      route_kind: original.row.route_kind,
      route_value: original.row.route_value,
      source_errors: uniqueStrings([
        ...rowStringArray(original.row, "source_errors"),
        ...rowStringArray(canonical.row, "source_errors"),
      ]),
    },
    outcomes: [...original.outcomes, ...canonical.outcomes],
  };
}

async function collectCanonicalizedAvailability(
  ref: string,
  opts: {
    source?: string;
    sources?: string;
    unpaywallEmail?: string;
  },
): Promise<ScholarAvailabilityCollect> {
  const availability = await collectAvailabilityEvidence(ref, opts);
  if (
    availability.row.record_found === true ||
    resolveScholarReference(ref).kind !== "unknown" ||
    (!opts.source && !opts.sources)
  ) {
    return availability;
  }

  const canonicalLookup = await collectAvailabilityEvidence(
    ref,
    canonicalReferenceLookupOpts(opts),
  );
  const canonicalRef = rowString(canonicalLookup.row, "canonical_ref");
  if (!canonicalRef || canonicalRef === ref) return availability;

  const canonicalAvailability = await collectAvailabilityEvidence(
    canonicalRef,
    opts,
  );
  return mergeCanonicalAvailability(availability, canonicalAvailability);
}

async function runAvailability(
  program: Command,
  ref: string,
  opts: {
    source?: string;
    sources?: string;
    detailed?: boolean;
    unpaywallEmail?: string;
  },
): Promise<void> {
  const startedAt = Date.now();
  const fmt = detectFormat(program.opts().format as OutputFormat | undefined);
  const ctx = makeCtx("scholar.availability", startedAt);
  const availability = await collectCanonicalizedAvailability(ref, opts);
  const row = availability.row;

  ctx.duration_ms = Date.now() - startedAt;
  ctx.surface = "web";
  if (row.record_found !== true) {
    ctx.error = {
      code: "SCHOLAR_AVAILABILITY_NOT_FOUND",
      message: `no scholarly metadata, PDF, or resource evidence returned for "${ref}"`,
      suggestion:
        Array.isArray(row.source_errors) && row.source_errors.length > 0
          ? `Per-source errors: ${row.source_errors.join("; ")}`
          : "Try a DOI, arXiv id, PMID, OpenReview URL, or run `unicli scholar search` first.",
      retryable: availability.outcomes.some((outcome) =>
        isRetryableScholarError(outcome.error),
      ),
    };
    console.error(format(null, undefined, fmt, ctx));
    process.exit(ExitCode.EMPTY_RESULT);
  }

  console.log(format([row], availabilityColumns(opts.detailed), fmt, ctx));
}

async function runSourceAudit(
  program: Command,
  ref: string,
  opts: {
    source?: string;
    sources?: string;
    detailed?: boolean;
    unpaywallEmail?: string;
  },
): Promise<void> {
  const startedAt = Date.now();
  const fmt = detectFormat(program.opts().format as OutputFormat | undefined);
  const ctx = makeCtx("scholar.sources", startedAt);
  const availability = await collectCanonicalizedAvailability(ref, opts);
  const canonicalOutcomes = await collectCanonicalSourceAuditOutcomes(
    availability.row,
    opts,
  );
  const rows = buildScholarSourceAuditRows(
    availability.row,
    [...availability.outcomes, ...canonicalOutcomes],
    {
      unpaywallEmail: opts.unpaywallEmail,
    },
  );

  ctx.duration_ms = Date.now() - startedAt;
  ctx.surface = "web";
  if (rows.length === 0) {
    ctx.error = {
      code: "SCHOLAR_SOURCES_EMPTY",
      message: `no scholarly sources were audited for "${ref}"`,
      suggestion:
        "Run `unicli scholar doctor --sources all` to inspect registered scholarly sources, or pass --sources all.",
      retryable: false,
    };
    console.error(format(null, undefined, fmt, ctx));
    process.exit(ExitCode.EMPTY_RESULT);
  }

  console.log(format(rows, sourceAuditColumns(opts.detailed), fmt, ctx));
}

async function runWorkflow(
  program: Command,
  ref: string,
  opts: {
    source?: string;
    sources?: string;
    detailed?: boolean;
    unpaywallEmail?: string;
  },
): Promise<void> {
  const startedAt = Date.now();
  const fmt = detectFormat(program.opts().format as OutputFormat | undefined);
  const ctx = makeCtx("scholar.workflow", startedAt);
  const availability = await collectCanonicalizedAvailability(ref, opts);
  const row = availability.row;

  ctx.duration_ms = Date.now() - startedAt;
  ctx.surface = "web";
  if (row.record_found !== true) {
    ctx.error = {
      code: "SCHOLAR_WORKFLOW_NOT_FOUND",
      message: `no source-backed scholarly workflow evidence returned for "${ref}"`,
      suggestion:
        Array.isArray(row.source_errors) && row.source_errors.length > 0
          ? `Per-source errors: ${row.source_errors.join("; ")}`
          : "Try a DOI, arXiv id, PMID, OpenReview URL, or run `unicli scholar search` first.",
      retryable: availability.outcomes.some((outcome) =>
        isRetryableScholarError(outcome.error),
      ),
    };
    console.error(format(null, undefined, fmt, ctx));
    process.exit(ExitCode.EMPTY_RESULT);
  }

  console.log(
    format(
      [buildScholarWorkflowRow(row)],
      workflowColumns(opts.detailed),
      fmt,
      ctx,
    ),
  );
}

async function runEvidence(
  program: Command,
  ref: string,
  opts: {
    source?: string;
    sources?: string;
    detailed?: boolean;
    unpaywallEmail?: string;
  },
): Promise<void> {
  const startedAt = Date.now();
  const fmt = detectFormat(program.opts().format as OutputFormat | undefined);
  const ctx = makeCtx("scholar.evidence", startedAt);
  const availability = await collectCanonicalizedAvailability(ref, opts);
  const row = availability.row;

  ctx.duration_ms = Date.now() - startedAt;
  ctx.surface = "web";
  if (row.record_found !== true) {
    ctx.error = {
      code: "SCHOLAR_EVIDENCE_NOT_FOUND",
      message: `no source-backed scholarly evidence returned for "${ref}"`,
      suggestion:
        Array.isArray(row.source_errors) && row.source_errors.length > 0
          ? `Per-source errors: ${row.source_errors.join("; ")}`
          : "Try a DOI, arXiv id, PMID, OpenReview URL, or run `unicli scholar search` first.",
      retryable: availability.outcomes.some((outcome) =>
        isRetryableScholarError(outcome.error),
      ),
    };
    console.error(format(null, undefined, fmt, ctx));
    process.exit(ExitCode.EMPTY_RESULT);
  }

  console.log(
    format(
      [buildScholarEvidenceRow(row)],
      evidenceColumns(opts.detailed),
      fmt,
      ctx,
    ),
  );
}

async function runReproducibility(
  program: Command,
  ref: string,
  opts: {
    source?: string;
    sources?: string;
    detailed?: boolean;
    unpaywallEmail?: string;
  },
): Promise<void> {
  const startedAt = Date.now();
  const fmt = detectFormat(program.opts().format as OutputFormat | undefined);
  const ctx = makeCtx("scholar.reproduce", startedAt);
  const availability = await collectCanonicalizedAvailability(ref, opts);
  const row = availability.row;

  ctx.duration_ms = Date.now() - startedAt;
  ctx.surface = "web";
  if (row.record_found !== true) {
    ctx.error = {
      code: "SCHOLAR_REPRODUCIBILITY_NOT_FOUND",
      message: `no source-backed scholarly reproducibility evidence returned for "${ref}"`,
      suggestion:
        Array.isArray(row.source_errors) && row.source_errors.length > 0
          ? `Per-source errors: ${row.source_errors.join("; ")}`
          : "Try a DOI, arXiv id, OpenReview URL, or run `unicli scholar search` before requesting reproducibility resources.",
      retryable: availability.outcomes.some((outcome) =>
        isRetryableScholarError(outcome.error),
      ),
    };
    console.error(format(null, undefined, fmt, ctx));
    process.exit(ExitCode.EMPTY_RESULT);
  }

  console.log(
    format(
      [buildScholarReproducibilityRow(row)],
      reproducibilityColumns(opts.detailed),
      fmt,
      ctx,
    ),
  );
}

function rootPermissionOptions(program: Command): {
  permissionProfile?: string;
  approved?: boolean;
  rememberApproval?: boolean;
} {
  const opts = program.opts() as {
    permissionProfile?: string;
    yes?: boolean;
    rememberApproval?: boolean;
  };
  return {
    permissionProfile: opts.permissionProfile,
    approved: opts.yes === true,
    rememberApproval: opts.rememberApproval === true,
  };
}

function artifactArgs(
  record: ScholarlyWorkRecord,
  opts: {
    output?: string;
    firstPage?: string;
    lastPage?: string;
    maxChars?: string;
  },
): Record<string, unknown> {
  const firstPage =
    opts.firstPage === undefined ? undefined : Number(opts.firstPage);
  const lastPage =
    opts.lastPage === undefined ? undefined : Number(opts.lastPage);
  const maxChars =
    opts.maxChars === undefined ? undefined : Number(opts.maxChars);
  return {
    pdf_url: record.pdf_url,
    title: record.title,
    id: record.id,
    source_adapter: record.source_adapter,
    source_url: record.source_url ?? record.landing_url,
    output: opts.output,
    "first-page": firstPage,
    "last-page": lastPage,
    "max-chars": maxChars,
  };
}

function fulltextArgs(
  route: ScholarlyReferenceRoute,
  opts: {
    output?: string;
    firstPage?: string;
    lastPage?: string;
    maxChars?: string;
    unpaywallEmail?: string;
    venue?: string;
    year?: string;
    volume?: string;
  },
): Record<string, unknown> {
  const firstPage =
    opts.firstPage === undefined ? undefined : Number(opts.firstPage);
  const lastPage =
    opts.lastPage === undefined ? undefined : Number(opts.lastPage);
  const maxChars =
    opts.maxChars === undefined ? undefined : Number(opts.maxChars);
  return {
    ...referenceArgs(route, opts),
    output: opts.output,
    "first-page": firstPage,
    "last-page": lastPage,
    "max-chars": maxChars,
  };
}

async function executeDirectFulltext(
  program: Command,
  source: string,
  route: ScholarlyReferenceRoute,
  opts: {
    output?: string;
    firstPage?: string;
    lastPage?: string;
    maxChars?: string;
    unpaywallEmail?: string;
    venue?: string;
    year?: string;
    volume?: string;
  },
): Promise<{ handled: boolean; outcome: DirectFulltextOutcome }> {
  const adapter = getAllAdapters().find(
    (candidate) => candidate.name === source,
  );
  if (!adapter) {
    return {
      handled: false,
      outcome: {
        source,
        error: {
          code: "adapter_not_found",
          message: `unknown source: ${source}`,
        },
      },
    };
  }
  const found = findScholarCommandByCapability(adapter, "scholar.fulltext");
  if (!found) {
    return {
      handled: false,
      outcome: {
        source,
        error: {
          code: "capability_unsupported",
          message: `${source} does not expose scholar.fulltext`,
        },
      },
    };
  }

  const fmt = detectFormat(program.opts().format as OutputFormat | undefined);
  const invocation = buildInvocation(
    "cli",
    source,
    found.name,
    {
      args: normalizeScholarCommandArgs(
        found.command,
        fulltextArgs(route, opts),
      ),
      source: "internal",
    },
    rootPermissionOptions(program),
  );
  if (!invocation) {
    return {
      handled: false,
      outcome: {
        source,
        error: {
          code: "build_invocation_failed",
          message: `could not build invocation for ${source}.${found.name}`,
        },
      },
    };
  }

  const result = await execute(invocation);
  if (result.error) {
    return {
      handled: false,
      outcome: {
        source,
        error: {
          code: result.error.code ?? "execution_error",
          message: result.error.message ?? "source fulltext command failed",
          retryable: result.error.retryable,
        },
      },
    };
  }
  if (!Array.isArray(result.results) || result.results.length === 0) {
    return {
      handled: false,
      outcome: {
        source,
        error: {
          code: "empty_result",
          message: `${source}.${found.name} returned no fulltext rows`,
        },
      },
    };
  }

  console.log(
    format(result.results, invocation.command.columns, fmt, result.envelope),
  );
  return { handled: true, outcome: { source } };
}

async function tryDirectFulltextFromScholar(
  program: Command,
  ref: string,
  opts: {
    source?: string;
    sources?: string;
    output?: string;
    firstPage?: string;
    lastPage?: string;
    maxChars?: string;
    unpaywallEmail?: string;
    venue?: string;
    year?: string;
    volume?: string;
  },
): Promise<{ handled: boolean; outcomes: DirectFulltextOutcome[] }> {
  const route = resolveScholarReference(ref);
  const sources = resolveScholarFulltextSources(
    opts.source,
    opts.sources,
    route,
  );
  const outcomes: DirectFulltextOutcome[] = [];
  for (const source of sources) {
    const result = await executeDirectFulltext(program, source, route, opts);
    outcomes.push(result.outcome);
    if (result.handled) return { handled: true, outcomes };
  }
  return { handled: false, outcomes };
}

async function executeScholarArtifact(
  program: Command,
  command: "download-pdf" | "read-pdf",
  args: Record<string, unknown>,
): Promise<void> {
  const fmt = detectFormat(program.opts().format as OutputFormat | undefined);
  const invocation = buildInvocation(
    "cli",
    "scholar-artifacts",
    command,
    {
      args: Object.fromEntries(definedEntries(args)),
      source: "internal",
    },
    rootPermissionOptions(program),
  );
  if (!invocation) {
    const ctx = makeCtx(`scholar.${command}`, Date.now());
    ctx.surface = "web";
    ctx.error = {
      code: "SCHOLAR_ARTIFACT_ADAPTER_MISSING",
      message: "scholar-artifacts adapter is not registered",
      suggestion:
        "Run `unicli scholar doctor` and check adapter load diagnostics.",
      retryable: false,
    };
    console.error(format(null, undefined, fmt, ctx));
    process.exit(ExitCode.CONFIG_ERROR);
  }

  const result = await execute(invocation);
  if (result.error) {
    process.stderr.write(
      format([], invocation.command.columns, fmt, result.envelope) + "\n",
    );
    process.exit(result.exitCode);
  }
  console.log(
    format(result.results, invocation.command.columns, fmt, result.envelope),
  );
}

async function runArtifactFromScholar(
  program: Command,
  ref: string,
  opts: {
    source?: string;
    sources?: string;
    output?: string;
    firstPage?: string;
    lastPage?: string;
    maxChars?: string;
    unpaywallEmail?: string;
    venue?: string;
    year?: string;
    volume?: string;
  },
  command: "download-pdf" | "read-pdf",
): Promise<void> {
  const startedAt = Date.now();
  const fmt = detectFormat(program.opts().format as OutputFormat | undefined);
  const ctx = makeCtx(
    command === "download-pdf" ? "scholar.download" : "scholar.read",
    startedAt,
  );
  const fulltextOutcomes: DirectFulltextOutcome[] = [];
  if (command === "read-pdf" && (opts.source || opts.sources)) {
    const rawFulltext = await tryDirectFulltextFromScholar(program, ref, opts);
    fulltextOutcomes.push(...rawFulltext.outcomes);
    if (rawFulltext.handled) return;
  }

  const lookupRef = await resolveArtifactLookupRef(ref, opts);
  const fulltext =
    command === "read-pdf"
      ? lookupRef === ref && fulltextOutcomes.length > 0
        ? { handled: false, outcomes: fulltextOutcomes }
        : await tryDirectFulltextFromScholar(program, lookupRef, opts)
      : { handled: false, outcomes: [] };
  if (fulltext.outcomes !== fulltextOutcomes) {
    fulltextOutcomes.push(...fulltext.outcomes);
  }
  if (fulltext.handled) return;

  const { sourceList, outcomes, records } = await collectPdfCandidates(
    lookupRef,
    opts,
  );
  const record = firstPdfRecord(records);
  if (!record) {
    const errors = outcomes.filter((outcome) => outcome.error);
    const fulltextErrors = fulltextOutcomes.filter((outcome) => outcome.error);
    const suggestions = [
      fulltextErrors.length > 0
        ? `Fulltext errors: ${fulltextErrors.map(formatScholarOutcomeError).join("; ")}`
        : "",
      errors.length > 0
        ? `PDF/source errors: ${errors.map(formatScholarOutcomeError).join("; ")}`
        : "",
    ].filter(Boolean);
    ctx.duration_ms = Date.now() - startedAt;
    ctx.surface = "web";
    ctx.error = {
      code:
        command === "read-pdf"
          ? "SCHOLAR_READ_NOT_FOUND"
          : "SCHOLAR_PDF_NOT_FOUND",
      message:
        command === "read-pdf"
          ? `no source-direct scholarly full text or downloadable PDF returned for "${ref}" across [${sourceList.join(", ")}]`
          : `no downloadable scholarly PDF returned for "${ref}" across [${sourceList.join(", ")}]`,
      suggestion:
        suggestions.length > 0
          ? suggestions.join(" ")
          : "Try --source with a site from `unicli scholar doctor`, or pass a more exact DOI/arXiv/OpenReview/PubMed id/title.",
      retryable:
        errors.some((outcome) => isRetryableScholarError(outcome.error)) ||
        fulltextOutcomes.some((outcome) =>
          isRetryableScholarError(outcome.error),
        ),
    };
    console.error(format(null, undefined, fmt, ctx));
    process.exit(ExitCode.EMPTY_RESULT);
  }
  await executeScholarArtifact(program, command, artifactArgs(record, opts));
}

async function runCoverage(
  program: Command,
  opts: { sources?: string; detailed?: boolean; gaps?: boolean },
): Promise<void> {
  const startedAt = Date.now();
  const fmt = detectFormat(program.opts().format as OutputFormat | undefined);
  const ctx = makeCtx("scholar.coverage", startedAt);
  const selected = resolveScholarSources(
    opts.sources,
    listScholarAdapters().map((adapter) => adapter.name),
  );
  const selectedAdapters = listScholarAdapters().filter((adapter) =>
    selected.includes(adapter.name),
  );
  const rows = buildScholarCoverageRows(selectedAdapters).filter((row) => {
    if (!opts.gaps) return true;
    const missing = row.missing_closed_loop;
    return Array.isArray(missing) && missing.length > 0;
  });

  ctx.duration_ms = Date.now() - startedAt;
  ctx.surface = "web";
  if (rows.length === 0) {
    ctx.error = {
      code: "SCHOLAR_COVERAGE_EMPTY",
      message: `no scholarly sources matched [${selected.join(", ")}]`,
      suggestion:
        "Run `unicli scholar doctor --sources all` to inspect registered scholarly sources.",
      retryable: false,
    };
    console.error(format(null, undefined, fmt, ctx));
    process.exit(ExitCode.EMPTY_RESULT);
  }

  console.log(format(rows, coverageColumns(opts.detailed), fmt, ctx));
}

interface ScholarDoctorRow {
  source: string;
  capabilities: string[];
  health: string;
  detail: string;
  live_health?: string;
  live_command?: string;
  live_query?: string;
  live_count?: number;
  live_error_code?: string;
  live_error_message?: string;
}

interface ScholarLiveProbeErrorClassification {
  live_health: "empty" | "failed";
  live_error_code: string;
  live_error_message: string;
}

function isScholarNoMatchErrorMessage(message: string): boolean {
  return /^No .+ matched ["“].+["”]\.?$/i.test(message.trim());
}

export function classifyScholarLiveProbeError(error: {
  code?: string;
  message?: string;
}): ScholarLiveProbeErrorClassification {
  const message = error.message ?? "adapter command failed";
  if (isScholarNoMatchErrorMessage(message)) {
    return {
      live_health: "empty",
      live_error_code: "empty_source_result",
      live_error_message: message,
    };
  }
  return {
    live_health: "failed",
    live_error_code: error.code ?? "execution_error",
    live_error_message: message,
  };
}

function buildStaticDoctorRow(adapter: AdapterManifest): ScholarDoctorRow {
  const caps = new Set<string>();
  for (const command of Object.values(adapter.commands)) {
    for (const cap of command.capabilities ?? []) {
      if (cap.startsWith("scholar.")) caps.add(cap);
    }
  }
  const health = resolveCommand(adapter.name, "health");
  const strategy = health
    ? commandStrategy(adapter, health.command)
    : undefined;
  return {
    source: adapter.name,
    capabilities: [...caps].sort(),
    health: !health
      ? "skipped"
      : strategy !== undefined && strategy !== Strategy.PUBLIC
        ? "blocked"
        : "available",
    detail: !health
      ? "no `health` command — adapter passes by capability introspection"
      : strategy !== undefined && strategy !== Strategy.PUBLIC
        ? `health probe requires ${strategy} auth — skipped`
        : "health probe command is public",
  };
}

async function probeScholarDoctorRow(
  adapter: AdapterManifest,
  row: ScholarDoctorRow,
  opts: { query: string; limit: number },
): Promise<ScholarDoctorRow> {
  const found = findScholarQueryableSearchCommand(adapter);
  if (!found) {
    return {
      ...row,
      live_health: "not_probeable",
      live_query: opts.query,
      live_count: 0,
      live_error_code: "no_queryable_search",
      live_error_message:
        "no queryable scholar.search command is registered for live probing",
    };
  }
  const strategy = commandStrategy(adapter, found.command);
  if (strategy !== undefined && strategy !== Strategy.PUBLIC) {
    return {
      ...row,
      live_health: "blocked",
      live_command: sourceCommand(adapter.name, found.name, "<query>"),
      live_query: opts.query,
      live_count: 0,
      live_error_code: "auth_required",
      live_error_message: `live probe requires ${strategy} auth`,
    };
  }
  const outcome = await executeScholarAdapterCommand(
    adapter.name,
    found,
    { query: opts.query, limit: String(opts.limit) },
    "scholar.search",
  );
  if (outcome.error) {
    const liveError = classifyScholarLiveProbeError(outcome.error);
    return {
      ...row,
      ...liveError,
      live_command: sourceCommand(adapter.name, found.name, "<query>"),
      live_query: opts.query,
      live_count: 0,
    };
  }
  return {
    ...row,
    live_health: outcome.records.length > 0 ? "passed" : "empty",
    live_command: sourceCommand(adapter.name, found.name, "<query>"),
    live_query: opts.query,
    live_count: outcome.records.length,
    live_error_code:
      outcome.records.length > 0 ? undefined : "empty_normalized_result",
    live_error_message:
      outcome.records.length > 0
        ? undefined
        : "live probe returned no scholar-normalized records",
  };
}

async function runDoctor(
  program: Command,
  opts: {
    sources?: string;
    live?: boolean;
    query?: string;
    limit?: string;
    detailed?: boolean;
  },
): Promise<void> {
  const startedAt = Date.now();
  const fmt = detectFormat(program.opts().format as OutputFormat | undefined);
  const ctx = makeCtx("scholar.doctor", startedAt);
  const selected = resolveScholarSources(
    opts.sources,
    listScholarAdapters().map((adapter) => adapter.name),
  );
  let rows = listScholarAdapters()
    .filter((adapter) => selected.includes(adapter.name))
    .map(buildStaticDoctorRow);
  if (opts.live) {
    const adaptersByName = new Map(
      listScholarAdapters().map((adapter) => [adapter.name, adapter]),
    );
    const query = opts.query ?? "Llama 2";
    const limit = numberOpt(opts.limit, 1, 5);
    rows = await Promise.all(
      rows.map((row) => {
        const adapter = adaptersByName.get(row.source);
        return adapter
          ? probeScholarDoctorRow(adapter, row, { query, limit })
          : row;
      }),
    );
  }
  ctx.duration_ms = Date.now() - startedAt;
  ctx.surface = "web";
  const columns = [
    "source",
    "capabilities",
    "health",
    "detail",
    ...(opts.live || opts.detailed
      ? [
          "live_health",
          "live_command",
          "live_query",
          "live_count",
          "live_error_code",
          "live_error_message",
        ]
      : []),
  ];
  console.log(format(rows, columns, fmt, ctx));
}

export function registerScholarCommand(program: Command): void {
  const scholar = program
    .command("scholar")
    .description(
      "Scholarly meta-command — search, retrieve, PDF, resource links, citations, references, and source audit across first-source academic adapters",
    );

  scholar
    .command("search <query>")
    .description("Fan-out scholarly paper search across first-source adapters")
    .option("--sources <csv>", "comma-separated source list, or `all`")
    .option("--limit <n>", "maximum fused result count", "20")
    .option("-D, --detailed", "include richer metadata columns")
    .action(
      async (
        query: string,
        opts: { sources?: string; limit?: string; detailed?: boolean },
      ) => {
        await runSearch(program, query, opts);
      },
    );

  scholar
    .command("availability <ref>")
    .alias("audit")
    .description(
      "Audit source-backed metadata, PDF, full-text, code, dataset/model, citation, reference, and review availability for one paper without downloading artifacts",
    )
    .option("--source <site>", "force one source")
    .option("--sources <csv>", "override auto-routed source list")
    .option("--venue <venue>", "source-local venue scope, e.g. CVPR or ICCV")
    .option("--year <year>", "source-local proceedings year")
    .option(
      "--volume <volume>",
      "source-local proceedings volume, e.g. PMLR v235",
    )
    .option(
      "--unpaywall-email <email>",
      "requester email for Unpaywall DOI lookup",
    )
    .option(
      "-D, --detailed",
      "include evidence URLs, errors, and next commands",
    )
    .action(
      async (
        ref: string,
        opts: {
          source?: string;
          sources?: string;
          detailed?: boolean;
          unpaywallEmail?: string;
        },
      ) => {
        await runAvailability(program, ref, opts);
      },
    );

  scholar
    .command("sources <ref>")
    .alias("source-audit")
    .description(
      "Show a per-source scholarly provenance matrix for one paper, including source status, evidence types, candidate capabilities, next commands, and source errors without downloading artifacts",
    )
    .option("--source <site>", "force one source")
    .option("--sources <csv>", "override auto-routed source list")
    .option(
      "--unpaywall-email <email>",
      "requester email for Unpaywall DOI lookup",
    )
    .option(
      "-D, --detailed",
      "include URLs, source capabilities, errors, and per-source next commands",
    )
    .action(
      async (
        ref: string,
        opts: {
          source?: string;
          sources?: string;
          detailed?: boolean;
          unpaywallEmail?: string;
        },
      ) => {
        await runSourceAudit(program, ref, opts);
      },
    );

  scholar
    .command("workflow <ref>")
    .alias("runbook")
    .description(
      "Build a source-backed agent runbook for the full scholarly loop: evidence, reading, download, citation/reference graph, peer review, and reproducibility planning without downloading, cloning, installing, or summarizing claims",
    )
    .option("--source <site>", "force one source")
    .option("--sources <csv>", "override auto-routed source list")
    .option(
      "--unpaywall-email <email>",
      "requester email for Unpaywall DOI lookup",
    )
    .option(
      "-D, --detailed",
      "include runbook steps, source errors, and timestamp",
    )
    .action(
      async (
        ref: string,
        opts: {
          source?: string;
          sources?: string;
          detailed?: boolean;
          unpaywallEmail?: string;
        },
      ) => {
        await runWorkflow(program, ref, opts);
      },
    );

  scholar
    .command("evidence <ref>")
    .alias("classify")
    .description(
      "Classify source-backed scholarly evidence for one paper into citation safety, reading readiness, missing evidence, and next commands without downloading artifacts",
    )
    .option("--source <site>", "force one source")
    .option("--sources <csv>", "override auto-routed source list")
    .option(
      "--unpaywall-email <email>",
      "requester email for Unpaywall DOI lookup",
    )
    .option(
      "-D, --detailed",
      "include availability rerun command, source errors, and timestamp",
    )
    .action(
      async (
        ref: string,
        opts: {
          source?: string;
          sources?: string;
          detailed?: boolean;
          unpaywallEmail?: string;
        },
      ) => {
        await runEvidence(program, ref, opts);
      },
    );

  scholar
    .command("reproduce <ref>")
    .alias("install-plan")
    .description(
      "Plan source-backed paper code/data reproduction and installation readiness without cloning, installing, or executing remote code",
    )
    .option("--source <site>", "force one source")
    .option("--sources <csv>", "override auto-routed source list")
    .option(
      "--unpaywall-email <email>",
      "requester email for Unpaywall DOI lookup",
    )
    .option(
      "-D, --detailed",
      "include source errors, download command, and timestamp",
    )
    .action(
      async (
        ref: string,
        opts: {
          source?: string;
          sources?: string;
          detailed?: boolean;
          unpaywallEmail?: string;
        },
      ) => {
        await runReproducibility(program, ref, opts);
      },
    );

  scholar
    .command("coverage")
    .description(
      "Compare registered scholarly sources by discovery, metadata, PDF, full-text, code, dataset/model, citation, reference, and review coverage without network I/O",
    )
    .option("--sources <csv>", "limit to sources or all")
    .option("--gaps", "show only sources with missing closed-loop capabilities")
    .option("-D, --detailed", "include command names and next commands")
    .action(
      async (opts: {
        sources?: string;
        gaps?: boolean;
        detailed?: boolean;
      }) => {
        await runCoverage(program, opts);
      },
    );

  scholar
    .command("reviews <ref>")
    .description(
      "Fetch source-backed peer-review, decision, rebuttal, and comment rows for a scholarly paper review thread",
    )
    .option("--source <site>", "force one review-capable source")
    .option("--sources <csv>", "override review-capable source list")
    .option("--max-length <n>", "per-row review text truncation length", "4000")
    .option("-D, --detailed", "include reviewer/signature and text size fields")
    .action(
      async (
        ref: string,
        opts: {
          source?: string;
          sources?: string;
          maxLength?: string;
          detailed?: boolean;
        },
      ) => {
        await runReviews(program, ref, opts);
      },
    );

  scholar
    .command("get <ref>")
    .description(
      "Retrieve one paper/work by DOI, arXiv id, PMID, OpenAlex id, Semantic Scholar id, dblp key, or OpenReview forum",
    )
    .option("--source <site>", "force one source")
    .option("--sources <csv>", "override auto-routed source list")
    .option(
      "--unpaywall-email <email>",
      "requester email for Unpaywall DOI lookup",
    )
    .option("-D, --detailed", "include richer metadata columns")
    .action(
      async (
        ref: string,
        opts: {
          source?: string;
          sources?: string;
          detailed?: boolean;
          unpaywallEmail?: string;
        },
      ) => {
        await runSingle(program, "scholar.get", ref, opts);
      },
    );

  scholar
    .command("pdf <ref>")
    .description(
      "Find open-access PDF candidates for a DOI, arXiv id, PMID, or source id",
    )
    .option("--source <site>", "force one source")
    .option("--sources <csv>", "override auto-routed source list")
    .option(
      "--unpaywall-email <email>",
      "requester email for Unpaywall DOI lookup",
    )
    .option("-D, --detailed", "include richer metadata columns")
    .action(
      async (
        ref: string,
        opts: {
          source?: string;
          sources?: string;
          detailed?: boolean;
          unpaywallEmail?: string;
        },
      ) => {
        await runSingle(program, "scholar.pdf", ref, opts);
      },
    );

  scholar
    .command("code <ref>")
    .description(
      "Find code repository and project links for a paper through resource-capable scholarly adapters",
    )
    .option("--source <site>", "force one source")
    .option("--sources <csv>", "override auto-routed source list")
    .option("-D, --detailed", "include richer resource metadata columns")
    .action(
      async (
        ref: string,
        opts: { source?: string; sources?: string; detailed?: boolean },
      ) => {
        await runResources(program, "scholar.code", ref, opts);
      },
    );

  scholar
    .command("datasets <ref>")
    .description(
      "Find linked datasets, models, and Spaces for a paper through resource-capable scholarly adapters",
    )
    .option("--source <site>", "force one source")
    .option("--sources <csv>", "override auto-routed source list")
    .option("-D, --detailed", "include richer resource metadata columns")
    .action(
      async (
        ref: string,
        opts: { source?: string; sources?: string; detailed?: boolean },
      ) => {
        await runResources(program, "scholar.datasets", ref, opts);
      },
    );

  scholar
    .command("download <ref>")
    .description(
      "Resolve a scholarly PDF candidate, download it locally, and return artifact metadata",
    )
    .option("--source <site>", "force one source")
    .option("--sources <csv>", "override auto-routed source list")
    .option(
      "--unpaywall-email <email>",
      "requester email for Unpaywall DOI lookup",
    )
    .option("--output <dir>", "output directory", "./scholar-downloads")
    .action(
      async (
        ref: string,
        opts: {
          source?: string;
          sources?: string;
          venue?: string;
          year?: string;
          volume?: string;
          output?: string;
          unpaywallEmail?: string;
        },
      ) => {
        await runArtifactFromScholar(program, ref, opts, "download-pdf");
      },
    );

  scholar
    .command("read <ref>")
    .description(
      "Resolve a scholarly PDF candidate, download it locally, and extract text with pdftotext",
    )
    .option("--source <site>", "force one source")
    .option("--sources <csv>", "override auto-routed source list")
    .option("--venue <venue>", "source-local venue scope, e.g. CVPR or ICCV")
    .option("--year <year>", "source-local proceedings year")
    .option(
      "--volume <volume>",
      "source-local proceedings volume, e.g. PMLR v235",
    )
    .option(
      "--unpaywall-email <email>",
      "requester email for Unpaywall DOI lookup",
    )
    .option("--output <dir>", "output directory", "./scholar-downloads")
    .option("--first-page <n>", "first page to extract", "1")
    .option("--last-page <n>", "last page to extract", "20")
    .option("--max-chars <n>", "maximum extracted/read text characters")
    .action(
      async (
        ref: string,
        opts: {
          source?: string;
          sources?: string;
          venue?: string;
          year?: string;
          volume?: string;
          output?: string;
          firstPage?: string;
          lastPage?: string;
          maxChars?: string;
          unpaywallEmail?: string;
        },
      ) => {
        await runArtifactFromScholar(program, ref, opts, "read-pdf");
      },
    );

  scholar
    .command("citations <ref>")
    .description("List works citing this paper when the source supports it")
    .option("--source <site>", "force one source")
    .option("--sources <csv>", "override auto-routed source list")
    .option("-D, --detailed", "include richer metadata columns")
    .action(
      async (
        ref: string,
        opts: { source?: string; sources?: string; detailed?: boolean },
      ) => {
        await runSingle(program, "scholar.citations", ref, opts);
      },
    );

  scholar
    .command("references <ref>")
    .description(
      "List works referenced by this paper when the source supports it",
    )
    .option("--source <site>", "force one source")
    .option("--sources <csv>", "override auto-routed source list")
    .option("-D, --detailed", "include richer metadata columns")
    .action(
      async (
        ref: string,
        opts: { source?: string; sources?: string; detailed?: boolean },
      ) => {
        await runSingle(program, "scholar.references", ref, opts);
      },
    );

  scholar
    .command("doctor")
    .description(
      "Inspect registered scholarly adapters, capability tags, and optional live search health",
    )
    .option("--sources <csv>", "limit to a comma-separated source list")
    .option(
      "--live",
      "run a queryable search probe for each selected source instead of relying only on capability introspection",
    )
    .option("--query <query>", "query for --live probes", "Llama 2")
    .option("--limit <n>", "per-source --live probe limit", "1")
    .option("-D, --detailed", "include live probe fields in table output")
    .action(
      async (opts: {
        sources?: string;
        live?: boolean;
        query?: string;
        limit?: string;
        detailed?: boolean;
      }) => {
        await runDoctor(program, opts);
      },
    );
}
