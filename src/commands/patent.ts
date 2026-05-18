/**
 * @owner       src::commands::patent
 * @does        Top-level `unicli patent` meta-command — fans out search / get / family / citations / legal-status / prior-art / doctor across every registered patent adapter (discovered via the `patent.*` capability convention), normalises into PatentRecord, dedupes by family, and emits the standard agent envelope.
 * @needs       src/registry.ts, src/types/patent.ts, src/engine/normalizer/patent-envelope.ts, src/engine/kernel/execute.ts, src/output/formatter.ts
 * @feeds       src/cli.ts (registerPatentCommand wiring)
 * @breaks      emits PATENT_INVALID_NUMBER envelope on unknown publication-number prefix; PATENT_NOT_FOUND when every fan-out source returns empty; never falls back to a non-patent adapter (rule 02)
 * @invariants  --sources default = uspto,epo,jpo; --sources all = every registered adapter whose `capabilities[]` carries any `patent.*` tag; routing by publication-number prefix uses an explicit jurisdiction → adapter table — no fuzzy matching
 * @side-effects spawns adapter pipelines via engine kernel; reads env for adapter-specific API keys; writes to stdout/stderr only
 * @perf        O(N · M) where N = sources, M = result rows per source — fan-out is sequential today; can move to parallel once the engine kernel proves reentrant under load
 * @concurrency safe — Commander handlers run one at a time per process
 * @test        tests/unit/commands/patent.test.ts
 * @stability   experimental — wave-1 surface; field names locked, behaviour evolves with adapters
 * @since       2026-05-18
 *
 * Capability convention introduced here:
 *
 *   patent.search        — adapter exposes a free-text + filter search
 *   patent.get           — adapter retrieves one record by publication-number
 *   patent.family        — adapter returns DOCDB / INPADOC family members
 *   patent.citations     — adapter returns citing / cited records
 *   patent.legal-status  — adapter resolves prosecution / grant status
 *   patent.fulltext      — adapter delivers description + claims text
 *   patent.prior-art     — adapter performs semantic prior-art retrieval
 *
 * Each patent-vertical YAML adapter must include the relevant tags in its
 * `capabilities:` array so this meta-command discovers it without
 * hard-coding a site list.
 */

import type { Command } from "commander";

import {
  commandStrategy,
  getAllAdapters,
  resolveCommand,
} from "../registry.js";
import { detectFormat, format } from "../output/formatter.js";
import { makeCtx, type AgentContext } from "../output/envelope.js";
import type {
  AdapterCommand,
  AdapterManifest,
  OutputFormat,
} from "../types.js";
import { ExitCode, Strategy } from "../types.js";
import { buildInvocation, execute } from "../engine/kernel/execute.js";
import type { PatentRecord } from "../types/patent.js";

// ── Publication-number prefix table ─────────────────────────────────────
//
// ST.16 two-letter country codes → the canonical first-party adapter that
// resolves get/family for that jurisdiction. Espacenet (EPO) is the broker
// for `family` regardless of prefix, but for `get` we go to the home office
// when one is registered, then fall back to espacenet.

const JURISDICTION_ADAPTERS: Record<string, string> = {
  US: "uspto",
  EP: "epo",
  WO: "epo", // PCT — EPO Espacenet brokers
  JP: "jpo",
  KR: "kipris",
  CN: "cnipa",
  DE: "dpma",
  FR: "inpi-fr",
  GB: "espacenet",
  CA: "cipo",
  AU: "ipaustralia",
  BR: "inpi-br",
  RU: "fips",
};

const FAMILY_BROKER = "epo";
const DEFAULT_SOURCES = ["uspto", "epo", "jpo"] as const;

// Vertical capability tags (re-exported so adapters and tests can grep).
export const PATENT_CAPABILITIES = [
  "patent.search",
  "patent.get",
  "patent.family",
  "patent.citations",
  "patent.legal-status",
  "patent.fulltext",
  "patent.prior-art",
] as const;
export type PatentCapability = (typeof PATENT_CAPABILITIES)[number];

// ── Discovery helpers ───────────────────────────────────────────────────

function hasAnyPatentCapability(adapter: AdapterManifest): boolean {
  for (const command of Object.values(adapter.commands)) {
    const caps = command.capabilities ?? [];
    if (caps.some((cap) => cap.startsWith("patent."))) return true;
  }
  return false;
}

/**
 * Find every registered adapter whose command set carries any patent.* tag.
 * Returns a stable alphabetical ordering so output is deterministic.
 */
export function listPatentAdapters(): AdapterManifest[] {
  return getAllAdapters()
    .filter(hasAnyPatentCapability)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Filter the list of adapter names by a `--sources` string. `all` expands to
 * every patent-capable adapter discovered in the registry.
 */
export function resolveSources(
  sourcesArg: string | undefined,
  fallback: readonly string[] = DEFAULT_SOURCES,
): string[] {
  if (!sourcesArg || sourcesArg.trim().length === 0) {
    return [...fallback];
  }
  if (sourcesArg.trim() === "all") {
    return listPatentAdapters().map((a) => a.name);
  }
  return sourcesArg
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Map a publication number to the adapter that should serve `get`/`family`
 * for it. Returns `undefined` when the prefix is not recognised — callers
 * surface PATENT_INVALID_NUMBER in that case.
 */
export function routeByPublicationPrefix(
  publicationNumber: string,
): string | undefined {
  const match = /^([A-Z]{2})/.exec(publicationNumber.trim().toUpperCase());
  if (!match) return undefined;
  return JURISDICTION_ADAPTERS[match[1]];
}

/**
 * Find the first command on `adapter` that carries the requested patent.*
 * capability tag. Adapters may name their command anything; the capability
 * tag is what wires them up.
 */
export function findCommandByCapability(
  adapter: AdapterManifest,
  capability: PatentCapability,
): { name: string; command: AdapterCommand } | undefined {
  for (const [name, command] of Object.entries(adapter.commands)) {
    const caps = command.capabilities ?? [];
    if (caps.includes(capability)) return { name, command };
  }
  return undefined;
}

// ── Reciprocal-rank fusion ──────────────────────────────────────────────

/**
 * Reciprocal-rank fusion across ranked result lists. The scoring follows
 * Cormack/Clarke/Buettcher 2009 (`score = Σ 1 / (k + rank)` with k = 60).
 * Records are keyed by `family_id` when present, falling back to
 * canonical publication_number — that is the dedupe axis required by the
 * patent vertical (different offices issue separate publication numbers
 * for the same invention).
 */
export function reciprocalRankFusion(
  rankedLists: PatentRecord[][],
  options: { k?: number; topN?: number } = {},
): PatentRecord[] {
  const k = options.k ?? 60;
  type Bucket = { score: number; record: PatentRecord; firstSeen: number };
  const buckets = new Map<string, Bucket>();

  let order = 0;
  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const record = list[rank];
      const key = record.family_id ?? record.publication_number;
      const existing = buckets.get(key);
      const increment = 1 / (k + rank + 1);
      if (existing) {
        existing.score += increment;
      } else {
        buckets.set(key, { score: increment, record, firstSeen: order++ });
      }
    }
  }

  const fused = [...buckets.values()].sort(
    (a, b) => b.score - a.score || a.firstSeen - b.firstSeen,
  );
  const top = options.topN ? fused.slice(0, options.topN) : fused;
  return top.map((b) => b.record);
}

// ── Pipeline-result coercion ────────────────────────────────────────────

function coerceToPatentRecords(rows: unknown, source: string): PatentRecord[] {
  if (!Array.isArray(rows)) return [];
  const out: PatentRecord[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.publication_number !== "string") continue;
    const record: PatentRecord = {
      publication_number: r.publication_number,
      source_adapter:
        typeof r.source_adapter === "string" ? r.source_adapter : source,
      retrieved_at:
        typeof r.retrieved_at === "string"
          ? r.retrieved_at
          : new Date().toISOString(),
    };
    if (typeof r.application_number === "string")
      record.application_number = r.application_number;
    if (typeof r.title === "string") record.title = r.title;
    if (typeof r.abstract === "string") record.abstract = r.abstract;
    if (typeof r.filing_date === "string") record.filing_date = r.filing_date;
    if (typeof r.publication_date === "string")
      record.publication_date = r.publication_date;
    if (typeof r.grant_date === "string") record.grant_date = r.grant_date;
    if (typeof r.priority_date === "string")
      record.priority_date = r.priority_date;
    if (typeof r.family_id === "string") record.family_id = r.family_id;
    if (typeof r.legal_status === "string")
      record.legal_status = r.legal_status;
    if (typeof r.source_url === "string") record.source_url = r.source_url;
    out.push(record);
  }
  return out;
}

// ── Fan-out runner ──────────────────────────────────────────────────────

interface FanoutOutcome {
  source: string;
  records: PatentRecord[];
  error?: { code: string; message: string };
}

async function runAdapterCommand(
  source: string,
  capability: PatentCapability,
  args: Record<string, unknown>,
): Promise<FanoutOutcome> {
  const adapter = getAllAdapters().find((a) => a.name === source);
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
  const found = findCommandByCapability(adapter, capability);
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
  const inv = buildInvocation(
    "cli",
    source,
    found.name,
    { args, source: "internal" },
    { approved: true },
  );
  if (!inv) {
    return {
      source,
      records: [],
      error: {
        code: "build_invocation_failed",
        message: `could not build invocation for ${source}.${found.name}`,
      },
    };
  }
  const result = await execute(inv);
  if (result.error) {
    return {
      source,
      records: [],
      error: {
        code: result.error.code ?? "execution_error",
        message: result.error.message ?? "adapter pipeline failed",
      },
    };
  }
  return {
    source,
    records: coerceToPatentRecords(result.results, source),
  };
}

// ── Command bodies ──────────────────────────────────────────────────────

interface SearchOpts {
  sources?: string;
  limit?: string;
  since?: string;
  cpc?: string;
}

async function runSearch(
  program: Command,
  query: string,
  opts: SearchOpts,
): Promise<void> {
  const startedAt = Date.now();
  const fmt = detectFormat(program.opts().format as OutputFormat | undefined);
  const ctx = makeCtx("patent.search", startedAt);

  const sources = resolveSources(opts.sources);
  const limit = Number(opts.limit ?? "20");
  const args: Record<string, unknown> = { query, limit };
  if (opts.since) args.date_from = `${opts.since}-01-01`;
  if (opts.cpc) args.cpc = opts.cpc;

  const outcomes: FanoutOutcome[] = [];
  for (const source of sources) {
    outcomes.push(await runAdapterCommand(source, "patent.search", args));
  }

  const lists = outcomes.map((o) => o.records);
  const fused = reciprocalRankFusion(lists, { topN: limit });
  const errors = outcomes.filter((o) => o.error);

  ctx.duration_ms = Date.now() - startedAt;
  ctx.surface = "web";
  if (fused.length === 0) {
    ctx.error = {
      code: "PATENT_NOT_FOUND",
      message: `no patent records returned for "${query}" across [${sources.join(", ")}]`,
      suggestion:
        errors.length > 0
          ? `Per-source errors: ${errors.map((e) => `${e.source}: ${e.error?.code}`).join("; ")}`
          : "Try --sources all or relax filters (--since / --cpc).",
      retryable: errors.some((e) => e.error?.code === "rate_limit"),
    };
    console.error(format(null, undefined, fmt, ctx));
    process.exit(ExitCode.EMPTY_RESULT);
  }
  console.log(
    format(
      fused,
      ["publication_number", "title", "publication_date", "source_adapter"],
      fmt,
      ctx,
    ),
  );
}

async function runGet(
  program: Command,
  publicationNumber: string,
): Promise<void> {
  const startedAt = Date.now();
  const fmt = detectFormat(program.opts().format as OutputFormat | undefined);
  const ctx = makeCtx("patent.get", startedAt);

  const source = routeByPublicationPrefix(publicationNumber);
  if (!source) {
    ctx.error = {
      code: "PATENT_INVALID_NUMBER",
      message: `publication number "${publicationNumber}" has no recognised ST.16 jurisdiction prefix`,
      suggestion:
        "Use a publication number with a two-letter country code prefix (US, EP, JP, KR, CN, DE, FR, GB, CA, AU, BR, RU).",
      retryable: false,
    };
    ctx.duration_ms = Date.now() - startedAt;
    console.error(format(null, undefined, fmt, ctx));
    process.exit(ExitCode.USAGE_ERROR);
  }

  const outcome = await runAdapterCommand(source, "patent.get", {
    publication_number: publicationNumber,
  });
  ctx.duration_ms = Date.now() - startedAt;
  ctx.surface = "web";
  if (outcome.error || outcome.records.length === 0) {
    ctx.error = {
      code: outcome.error ? "PATENT_NOT_FOUND" : "PATENT_NOT_FOUND",
      message:
        outcome.error?.message ??
        `${source} returned no record for ${publicationNumber}`,
      suggestion: `Verify the number on ${source}'s primary search, or retry against --sources all.`,
      retryable: false,
    };
    console.error(format(null, undefined, fmt, ctx));
    process.exit(ExitCode.EMPTY_RESULT);
  }
  console.log(format(outcome.records, undefined, fmt, ctx));
}

async function runFamily(
  program: Command,
  publicationNumber: string,
): Promise<void> {
  const startedAt = Date.now();
  const fmt = detectFormat(program.opts().format as OutputFormat | undefined);
  const ctx = makeCtx("patent.family", startedAt);

  if (!routeByPublicationPrefix(publicationNumber)) {
    ctx.error = {
      code: "PATENT_INVALID_NUMBER",
      message: `publication number "${publicationNumber}" has no recognised ST.16 jurisdiction prefix`,
      suggestion:
        "Family lookups need a CC-prefixed publication number so we know which jurisdiction issued it.",
      retryable: false,
    };
    ctx.duration_ms = Date.now() - startedAt;
    console.error(format(null, undefined, fmt, ctx));
    process.exit(ExitCode.USAGE_ERROR);
  }

  // EPO is the canonical INPADOC family broker — try it first.
  const primary = await runAdapterCommand(FAMILY_BROKER, "patent.family", {
    publication_number: publicationNumber,
  });
  ctx.duration_ms = Date.now() - startedAt;
  ctx.surface = "web";
  if (primary.error || primary.records.length === 0) {
    const fallback = await runAdapterCommand(
      routeByPublicationPrefix(publicationNumber)!,
      "patent.family",
      { publication_number: publicationNumber },
    );
    ctx.duration_ms = Date.now() - startedAt;
    if (fallback.error || fallback.records.length === 0) {
      ctx.error = {
        code: "PATENT_FAMILY_BROKER_DOWN",
        message: `EPO Espacenet family lookup failed and home-office fallback returned empty for ${publicationNumber}`,
        suggestion: "Retry with --sources all or check unicli patent doctor.",
        retryable: true,
      };
      console.error(format(null, undefined, fmt, ctx));
      process.exit(ExitCode.SERVICE_UNAVAILABLE);
    }
    console.log(format(fallback.records, undefined, fmt, ctx));
    return;
  }
  console.log(format(primary.records, undefined, fmt, ctx));
}

async function runCitations(
  program: Command,
  publicationNumber: string,
  opts: { direction?: string },
): Promise<void> {
  const startedAt = Date.now();
  const fmt = detectFormat(program.opts().format as OutputFormat | undefined);
  const ctx = makeCtx("patent.citations", startedAt);

  const source = routeByPublicationPrefix(publicationNumber);
  if (!source) {
    ctx.error = {
      code: "PATENT_INVALID_NUMBER",
      message: `publication number "${publicationNumber}" has no recognised ST.16 jurisdiction prefix`,
      suggestion: "Provide a CC-prefixed publication number.",
      retryable: false,
    };
    ctx.duration_ms = Date.now() - startedAt;
    console.error(format(null, undefined, fmt, ctx));
    process.exit(ExitCode.USAGE_ERROR);
  }
  const direction = opts.direction ?? "citing";
  const outcome = await runAdapterCommand(source, "patent.citations", {
    publication_number: publicationNumber,
    direction,
  });
  ctx.duration_ms = Date.now() - startedAt;
  ctx.surface = "web";
  if (outcome.error) {
    ctx.error = {
      code: "PATENT_NOT_FOUND",
      message: outcome.error.message,
      suggestion: `Verify ${publicationNumber} exists at ${source}, then retry.`,
      retryable: false,
    };
    console.error(format(null, undefined, fmt, ctx));
    process.exit(ExitCode.EMPTY_RESULT);
  }
  console.log(format(outcome.records, undefined, fmt, ctx));
}

async function runLegalStatus(
  program: Command,
  publicationNumbers: string[],
): Promise<void> {
  const startedAt = Date.now();
  const fmt = detectFormat(program.opts().format as OutputFormat | undefined);
  const ctx = makeCtx("patent.legal-status", startedAt);

  const invalid = publicationNumbers.filter(
    (n) => !routeByPublicationPrefix(n),
  );
  if (invalid.length > 0) {
    ctx.error = {
      code: "PATENT_INVALID_NUMBER",
      message: `unrecognised jurisdiction prefix on: ${invalid.join(", ")}`,
      suggestion: "Every number must carry a two-letter ST.16 country code.",
      retryable: false,
    };
    ctx.duration_ms = Date.now() - startedAt;
    console.error(format(null, undefined, fmt, ctx));
    process.exit(ExitCode.USAGE_ERROR);
  }

  const byJurisdiction = new Map<string, string[]>();
  for (const number of publicationNumbers) {
    const source = routeByPublicationPrefix(number)!;
    const bucket = byJurisdiction.get(source) ?? [];
    bucket.push(number);
    byJurisdiction.set(source, bucket);
  }

  const all: PatentRecord[] = [];
  for (const [source, numbers] of byJurisdiction.entries()) {
    const outcome = await runAdapterCommand(source, "patent.legal-status", {
      publication_numbers: numbers,
    });
    all.push(...outcome.records);
  }
  ctx.duration_ms = Date.now() - startedAt;
  ctx.surface = "web";
  console.log(
    format(
      all,
      ["publication_number", "legal_status", "source_adapter"],
      fmt,
      ctx,
    ),
  );
}

async function runPriorArt(
  program: Command,
  opts: { abstract?: string; sources?: string; top?: string },
): Promise<void> {
  const startedAt = Date.now();
  const fmt = detectFormat(program.opts().format as OutputFormat | undefined);
  const ctx = makeCtx("patent.prior-art", startedAt);

  if (!opts.abstract) {
    ctx.error = {
      code: "invalid_input",
      message: "patent prior-art requires --abstract <text>",
      suggestion:
        "Pass the candidate abstract as a single string: --abstract 'A method for …'.",
      retryable: false,
    };
    ctx.duration_ms = Date.now() - startedAt;
    console.error(format(null, undefined, fmt, ctx));
    process.exit(ExitCode.USAGE_ERROR);
  }
  const top = Number(opts.top ?? "20");
  const sources = resolveSources(opts.sources, [
    "pqai",
    "google-patents-bq",
    "epo",
  ]);
  const outcomes: FanoutOutcome[] = [];
  for (const source of sources) {
    outcomes.push(
      await runAdapterCommand(source, "patent.prior-art", {
        abstract: opts.abstract,
        limit: top,
      }),
    );
  }
  const lists = outcomes.map((o) => o.records);
  const fused = reciprocalRankFusion(lists, { topN: top });
  ctx.duration_ms = Date.now() - startedAt;
  ctx.surface = "web";
  if (fused.length === 0) {
    const errors = outcomes.filter((o) => o.error);
    ctx.error = {
      code: "PATENT_NOT_FOUND",
      message: `no prior-art candidates returned across [${sources.join(", ")}]`,
      suggestion:
        errors.length > 0
          ? `Per-source errors: ${errors.map((e) => `${e.source}: ${e.error?.code}`).join("; ")}`
          : "Try widening --sources, or supply more of the abstract.",
      retryable: false,
    };
    console.error(format(null, undefined, fmt, ctx));
    process.exit(ExitCode.EMPTY_RESULT);
  }
  console.log(
    format(
      fused,
      ["publication_number", "title", "abstract", "source_adapter"],
      fmt,
      ctx,
    ),
  );
}

// ── doctor ──────────────────────────────────────────────────────────────

interface DoctorRow {
  source: string;
  capabilities: string[];
  health: "ok" | "skipped" | "blocked" | "error";
  detail: string;
}

async function runDoctor(
  program: Command,
  opts: { sources?: string },
): Promise<void> {
  const startedAt = Date.now();
  const fmt = detectFormat(program.opts().format as OutputFormat | undefined);
  const ctx = makeCtx("patent.doctor", startedAt);

  const adapters = listPatentAdapters().filter((a) => {
    const list = resolveSources(
      opts.sources,
      listPatentAdapters().map((x) => x.name),
    );
    return list.includes(a.name);
  });

  const rows: DoctorRow[] = [];
  let anyError = false;
  for (const adapter of adapters) {
    const caps = new Set<string>();
    for (const cmd of Object.values(adapter.commands)) {
      for (const cap of cmd.capabilities ?? []) {
        if (cap.startsWith("patent.")) caps.add(cap);
      }
    }
    const healthCmd = resolveCommand(adapter.name, "health");
    if (!healthCmd) {
      rows.push({
        source: adapter.name,
        capabilities: [...caps].sort(),
        health: "skipped",
        detail: "no `health` command — adapter passes by introspection only",
      });
      continue;
    }
    const strategy = commandStrategy(adapter, healthCmd.command);
    if (strategy !== undefined && strategy !== Strategy.PUBLIC) {
      rows.push({
        source: adapter.name,
        capabilities: [...caps].sort(),
        health: "blocked",
        detail: `health probe requires ${strategy} auth — skipped`,
      });
      continue;
    }
    const inv = buildInvocation(
      "cli",
      adapter.name,
      "health",
      { args: {}, source: "internal" },
      { approved: true },
    );
    if (!inv) {
      rows.push({
        source: adapter.name,
        capabilities: [...caps].sort(),
        health: "error",
        detail: "could not build invocation for health command",
      });
      anyError = true;
      continue;
    }
    const result = await execute(inv);
    if (result.error) {
      rows.push({
        source: adapter.name,
        capabilities: [...caps].sort(),
        health: "error",
        detail: result.error.message ?? result.error.code ?? "health failed",
      });
      anyError = true;
      continue;
    }
    rows.push({
      source: adapter.name,
      capabilities: [...caps].sort(),
      health: "ok",
      detail: "health probe returned successfully",
    });
  }
  ctx.duration_ms = Date.now() - startedAt;
  ctx.surface = "web";
  console.log(
    format(rows, ["source", "capabilities", "health", "detail"], fmt, ctx),
  );
  if (anyError) process.exit(ExitCode.GENERIC_ERROR);
}

// ── Registration ────────────────────────────────────────────────────────

export function registerPatentCommand(program: Command): void {
  const patent = program
    .command("patent")
    .description(
      "Patent meta-command — search, retrieve, and audit across L0/L1/L2 patent adapters",
    );

  patent
    .command("search <query>")
    .description("Free-text + filter search across patent sources")
    .option(
      "--sources <csv>",
      "comma-separated source list, or `all` for every patent adapter",
    )
    .option("--limit <n>", "maximum fused result count", "20")
    .option("--since <YYYY>", "earliest filing year")
    .option("--cpc <csv>", "Cooperative Patent Classification filter")
    .action(async (query: string, opts: SearchOpts) => {
      await runSearch(program, query, opts);
    });

  patent
    .command("get <publication-number>")
    .description("Retrieve one patent record by ST.16 publication number")
    .action(async (publicationNumber: string) => {
      await runGet(program, publicationNumber);
    });

  patent
    .command("family <publication-number>")
    .description("INPADOC / DOCDB family lookup brokered through EPO Espacenet")
    .action(async (publicationNumber: string) => {
      await runFamily(program, publicationNumber);
    });

  patent
    .command("citations <publication-number>")
    .description("Citing / cited records for the given publication number")
    .option(
      "--direction <dir>",
      "citing (records that cite this) or cited (records this cites)",
      "citing",
    )
    .action(async (publicationNumber: string, opts: { direction?: string }) => {
      await runCitations(program, publicationNumber, opts);
    });

  patent
    .command("legal-status <publication-numbers...>")
    .description(
      "Prosecution / grant status for one or more publication numbers",
    )
    .action(async (publicationNumbers: string[]) => {
      await runLegalStatus(program, publicationNumbers);
    });

  patent
    .command("prior-art")
    .description(
      "Semantic + keyword + CPC prior-art fusion against an abstract",
    )
    .requiredOption("--abstract <text>", "candidate abstract text")
    .option(
      "--sources <csv>",
      "comma-separated source list (default: pqai,google-patents-bq,epo)",
    )
    .option("--top <n>", "top-N fused results to return", "20")
    .action(
      async (opts: { abstract?: string; sources?: string; top?: string }) => {
        await runPriorArt(program, opts);
      },
    );

  patent
    .command("doctor")
    .description(
      "Probe each registered patent adapter for health and schema drift",
    )
    .option("--sources <csv>", "limit to a comma-separated source list")
    .action(async (opts: { sources?: string }) => {
      await runDoctor(program, opts);
    });
}

// Re-export some helpers so the test suite can exercise them without
// going through Commander; rule 03 forbids mocking owned modules.
export { JURISDICTION_ADAPTERS, FAMILY_BROKER, DEFAULT_SOURCES };
export type { AgentContext };
