/**
 * @owner       src::commands::scholar
 * @does        Top-level `unicli scholar` meta-command for academic source discovery: searches, retrieves, PDF availability, citation/reference traversal, and doctor output across adapters tagged with `scholar.*` capabilities.
 * @needs       src/registry.ts, src/types/scholarly.ts, src/engine/kernel/execute.ts, src/output/formatter.ts
 * @feeds       src/cli.ts, MCP/agent command discovery via list/search/do
 * @breaks      Missing capability tags make scholarly sources invisible to the meta-command; weak reference routing can send DOI/arXiv/PMID lookups to the wrong first source.
 * @invariants  --sources default is a conservative first-source set; --sources all is registry capability discovery; DOI is the primary dedupe key; no non-scholarly adapter is invoked as fallback.
 * @side-effects Executes adapter commands through the engine kernel; writes stdout/stderr only.
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
] as const;

export type ScholarCapability = (typeof SCHOLAR_CAPABILITIES)[number];

function hasAnyScholarCapability(adapter: AdapterManifest): boolean {
  return Object.values(adapter.commands).some((command) =>
    (command.capabilities ?? []).some((cap) => cap.startsWith("scholar.")),
  );
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
  for (const [name, command] of Object.entries(adapter.commands)) {
    if ((command.capabilities ?? []).includes(capability))
      return { name, command };
  }
  return undefined;
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
      preferredSources: ["openalex", "crossref", "semantic-scholar"],
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

  const openReview = raw.match(/^openreview:\s*([A-Za-z0-9_-]{6,20})$/i);
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
  if (!Array.isArray(value)) return undefined;
  const out = value.map((item) => String(item ?? "").trim()).filter(Boolean);
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

function coerceToScholarlyRecords(
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
    if (year !== undefined) work.year = year;
    for (const field of [
      "date",
      "venue",
      "type",
      "abstract",
      "doi",
      "arxiv_id",
      "pmid",
      "openalex_id",
      "semantic_scholar_id",
      "dblp_key",
      "openreview_id",
      "oa_status",
      "pdf_url",
      "landing_url",
      "code_url",
      "dataset_url",
      "source_url",
    ] as const) {
      if (typeof record[field] === "string" && record[field].length > 0) {
        work[field] = record[field] as never;
      }
    }
    for (const [sourceField, targetField] of [
      ["cited_by_count", "cited_by_count"],
      ["references_count", "references_count"],
    ] as const) {
      const n = coerceNumber(record[sourceField]);
      if (n !== undefined) work[targetField] = n;
    }
    if (typeof record.is_open_access === "boolean") {
      work.is_open_access = record.is_open_access;
    }
    if (record.raw !== undefined) work.raw = record.raw;
    out.push(work);
  }
  return out;
}

interface FanoutOutcome {
  source: string;
  records: ScholarlyWorkRecord[];
  error?: { code: string; message: string };
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
  const invocation = buildInvocation(
    "cli",
    source,
    found.name,
    { args, source: "internal" },
    { approved: true },
  );
  if (!invocation) {
    return {
      source,
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
      records: [],
      error: {
        code: result.error.code ?? "execution_error",
        message: result.error.message ?? "adapter command failed",
      },
    };
  }
  return {
    source,
    records: coerceToScholarlyRecords(result.results, source),
  };
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
        "source_adapter",
        "source_url",
      ]
    : ["id", "title", "year", "venue", "doi", "pdf_url", "source_adapter"];
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
          ? `Per-source errors: ${errors.map((outcome) => `${outcome.source}: ${outcome.error?.code}`).join("; ")}`
          : "Try --sources all or a more specific query.",
      retryable: errors.some((outcome) => outcome.error?.code === "rate_limit"),
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
  opts: { source?: string; sources?: string; detailed?: boolean },
): Promise<void> {
  const startedAt = Date.now();
  const fmt = detectFormat(program.opts().format as OutputFormat | undefined);
  const ctx = makeCtx(capability, startedAt);
  const route = resolveScholarReference(ref);
  const sourceList = opts.source
    ? [opts.source]
    : resolveScholarSources(opts.sources, route.preferredSources);
  const outcomes: FanoutOutcome[] = [];
  for (const source of sourceList) {
    outcomes.push(
      await runAdapterCommand(source, capability, {
        ref: route.value,
        id: route.value,
        doi: route.kind === "doi" ? route.value : undefined,
        arxiv_id: route.kind === "arxiv" ? route.value : undefined,
        pmid: route.kind === "pmid" ? route.value : undefined,
      }),
    );
  }
  const fused = reciprocalRankFusion(
    outcomes.map((outcome) => outcome.records),
    { topN: capability === "scholar.pdf" ? 10 : 50 },
  );
  ctx.duration_ms = Date.now() - startedAt;
  ctx.surface = "web";
  if (fused.length === 0) {
    const errors = outcomes.filter((outcome) => outcome.error);
    ctx.error = {
      code: "SCHOLAR_NOT_FOUND",
      message: `no scholarly records returned for "${ref}" across [${sourceList.join(", ")}]`,
      suggestion:
        errors.length > 0
          ? `Per-source errors: ${errors.map((outcome) => `${outcome.source}: ${outcome.error?.code}`).join("; ")}`
          : "Run `unicli scholar doctor` to inspect available scholarly sources.",
      retryable: errors.some((outcome) => outcome.error?.code === "rate_limit"),
    };
    console.error(format(null, undefined, fmt, ctx));
    process.exit(ExitCode.EMPTY_RESULT);
  }
  console.log(format(fused, columns(opts.detailed), fmt, ctx));
}

async function runDoctor(
  program: Command,
  opts: { sources?: string },
): Promise<void> {
  const startedAt = Date.now();
  const fmt = detectFormat(program.opts().format as OutputFormat | undefined);
  const ctx = makeCtx("scholar.doctor", startedAt);
  const selected = resolveScholarSources(
    opts.sources,
    listScholarAdapters().map((adapter) => adapter.name),
  );
  const rows = listScholarAdapters()
    .filter((adapter) => selected.includes(adapter.name))
    .map((adapter) => {
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
    });
  ctx.duration_ms = Date.now() - startedAt;
  ctx.surface = "web";
  console.log(
    format(rows, ["source", "capabilities", "health", "detail"], fmt, ctx),
  );
}

export function registerScholarCommand(program: Command): void {
  const scholar = program
    .command("scholar")
    .description(
      "Scholarly meta-command — search, retrieve, PDF, citations, references, and source audit across first-source academic adapters",
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
    .command("get <ref>")
    .description(
      "Retrieve one paper/work by DOI, arXiv id, PMID, OpenAlex id, Semantic Scholar id, dblp key, or OpenReview forum",
    )
    .option("--source <site>", "force one source")
    .option("--sources <csv>", "override auto-routed source list")
    .option("-D, --detailed", "include richer metadata columns")
    .action(
      async (
        ref: string,
        opts: { source?: string; sources?: string; detailed?: boolean },
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
    .option("-D, --detailed", "include richer metadata columns")
    .action(
      async (
        ref: string,
        opts: { source?: string; sources?: string; detailed?: boolean },
      ) => {
        await runSingle(program, "scholar.pdf", ref, opts);
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
    .description("Inspect registered scholarly adapters and capability tags")
    .option("--sources <csv>", "limit to a comma-separated source list")
    .action(async (opts: { sources?: string }) => {
      await runDoctor(program, opts);
    });
}
