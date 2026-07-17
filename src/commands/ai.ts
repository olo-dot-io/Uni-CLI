/**
 * @owner       src::commands::ai
 * @does        Provides registry-driven AI/AI-infrastructure search, source discovery, cross-source normalization, provenance, deduplication, and structured document reading.
 * @needs       src/commands/ai-content.ts, adapter registry, shared kernel execution, web.read
 * @feeds       Agent AI-infrastructure research loops through `unicli ai search|read|sources`
 * @breaks      Missing ai.* capability tags, weak URL canonicalization, silent source failures, or lossy normalization make current evidence undiscoverable or untraceable.
 * @invariants  Search executes only registered read-only ai.search source commands after the outer orchestrator is authorized; internal fan-out passes only declared args; partial failures are counted on every row and detailed once per response; every result retains source adapter, command, canonical URL, retrieval time, and inferred provenance class.
 * @side-effects Search and read execute registered read-only adapters; sources is network-free.
 * @perf        Source fan-out is bounded to six concurrent requests with a 20-second per-source deadline; normalization and reciprocal-rank fusion are O(S * R).
 * @concurrency Independent source invocations run in a bounded worker pool; each owns an abort signal and result state.
 * @test        tests/unit/commands/ai.test.ts, tests/unit/adapters/ai-intelligence.test.ts, plus live ai/hf/gh/web probes
 * @stability   experimental
 * @since       2026-07-17
 */

import {
  coerceAiContentRecords,
  inferAiSourceClass,
  inferAiSourceKind,
  reciprocalRankFuse,
  structureAiDocument,
  type AiContentRecord,
  type AiContentSource,
  type AiVendor,
} from "./ai-content.js";
import { resolveArgs } from "../engine/args.js";
import { buildInvocation, execute } from "../engine/kernel/execute.js";
import { buildCommandContract } from "../core/command-contract.js";
import { mapConcurrent } from "../engine/download.js";
import {
  commandAuthSetupCommand,
  commandRequiresAuth,
  commandStrategy,
  getAllAdapters,
} from "../registry.js";
import type { AdapterCommand, AdapterManifest } from "../types.js";

interface AiSourceCommand extends AiContentSource {
  adapter: AdapterManifest;
  command: AdapterCommand;
}

export interface AiSourceError {
  ref: string;
  code: string;
  message: string;
  suggestion: string;
  adapter_path?: string;
  step?: number;
  retryable?: boolean;
  alternatives: string[];
  retry_command: string;
}

export interface AiSearchOptions {
  sources?: string;
  kind?: string;
  vendors?: string;
  domains?: string;
  repo?: string;
  sort?: string;
  since?: string;
  limit?: string | number;
}

export interface AiSearchResult extends AiContentRecord {
  source_errors?: AiSourceError[];
  partial_failure_count: number;
  freshness_mode: "relevance" | "latest";
  source_timestamp: string;
  freshness_verifiable: boolean;
  next_read: string;
}

type AiCommandFailureInit = {
  code: string;
  message: string;
  suggestion: string;
  retryable?: boolean;
  alternatives?: string[];
};

export class AiCommandFailure extends Error {
  readonly code: string;
  readonly suggestion: string;
  readonly retryable: boolean;
  readonly alternatives: string[];

  constructor(init: AiCommandFailureInit) {
    super(init.message);
    this.name = "AiCommandFailure";
    this.code = init.code;
    this.suggestion = init.suggestion;
    this.retryable = init.retryable ?? false;
    this.alternatives = init.alternatives ?? [];
  }
}

const DEFAULT_AI_SOURCE_REFS = [
  "duckduckgo.search",
  "yahoo.search",
  "gh.search-repos",
  "gh.search-issues",
  "gh.search-prs",
  "hf.models",
  "hf.datasets",
  "hf.spaces",
  "hf.community",
  "huggingface-papers.search",
  "arxiv.search",
  "semantic-scholar.search",
  "hackernews.search",
  "stackoverflow.search",
  "lobsters.search",
] as const;

const AI_SOURCE_CONCURRENCY = 6;
const AI_SOURCE_TIMEOUT_MS = 20_000;

export const OFFICIAL_AI_INFRA_DOMAINS = [
  "docs.nvidia.com",
  "developer.nvidia.com",
  "rocm.docs.amd.com",
  "amd.com",
  "hiascend.com",
  "huggingface.co/docs",
  "docs.github.com",
] as const;

const VENDOR_CONFIG: Record<
  Exclude<AiVendor, "hugging-face" | "github" | "unknown">,
  { terms: string[]; domains: string[] }
> = {
  nvidia: {
    terms: ["NVIDIA", "CUDA", "TensorRT", "DGX"],
    domains: ["docs.nvidia.com", "developer.nvidia.com", "nvidia.com"],
  },
  amd: {
    terms: ["AMD", "ROCm", "Instinct"],
    domains: ["rocm.docs.amd.com", "amd.com"],
  },
  "huawei-ascend": {
    terms: ["Huawei Ascend", "昇腾", "CANN", "MindIE"],
    domains: ["hiascend.com", "huawei.com"],
  },
};

const AI_CONTENT_KINDS = new Set<string>([
  "all",
  "docs",
  "repository",
  "issue",
  "pull-request",
  "discussion",
  "model",
  "dataset",
  "space",
  "paper",
  "community",
]);

function parseCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function listAiSourceCommands(): AiSourceCommand[] {
  return getAllAdapters()
    .flatMap((adapter) =>
      Object.entries(adapter.commands)
        .filter(([, command]) =>
          (command.capabilities ?? []).includes("ai.search"),
        )
        .map(([name, command]) => {
          const contract = buildCommandContract({
            adapter,
            commandName: name,
            command,
          });
          if (!contract.effect.read_only) {
            throw new AiCommandFailure({
              code: "ai_source_not_read_only",
              message: `Registered AI source ${adapter.name}.${name} is not read-only.`,
              suggestion:
                "Remove the ai.search capability or redesign the source command as a read-only operation.",
            });
          }
          const ref = `${adapter.name}.${name}`;
          return {
            ref,
            site: adapter.name,
            name,
            adapter,
            command,
            kind: inferAiSourceKind(ref, command.capabilities ?? []),
            sourceClass: inferAiSourceClass(ref),
          } satisfies AiSourceCommand;
        }),
    )
    .sort((left, right) => left.ref.localeCompare(right.ref));
}

function commandCanRun(
  source: AiSourceCommand,
  hasRepository: boolean,
): boolean {
  return (source.command.adapterArgs ?? []).every(
    (arg) =>
      !arg.required ||
      arg.name === "query" ||
      arg.name === "limit" ||
      (arg.name === "repo" && hasRepository),
  );
}

function kindMatches(source: AiSourceCommand, requested: string): boolean {
  if (requested === "all") return true;
  if (requested === "community") {
    return (source.command.capabilities ?? []).includes("ai.community");
  }
  return source.kind === requested;
}

function resolveAiSources(opts: AiSearchOptions): AiSourceCommand[] {
  const available = listAiSourceCommands();
  const byRef = new Map(available.map((source) => [source.ref, source]));
  const requested = parseCsv(opts.sources);
  let selected: AiSourceCommand[];

  if (requested.length === 0) {
    const refs: string[] = [...DEFAULT_AI_SOURCE_REFS];
    if (opts.repo) refs.push("gh.discussions");
    selected = refs
      .map((ref) => byRef.get(ref))
      .filter((source): source is AiSourceCommand => source !== undefined);
  } else if (requested.length === 1 && requested[0] === "all") {
    selected = available;
  } else {
    const expanded = requested.flatMap((selector) => {
      if (selector.includes(".")) {
        const exact = byRef.get(selector);
        if (!exact) throw new Error(`unknown AI source command: ${selector}`);
        return [exact];
      }
      const siteMatches = available.filter(
        (source) => source.site === selector,
      );
      if (siteMatches.length === 0) {
        throw new Error(`unknown AI source site: ${selector}`);
      }
      return siteMatches;
    });
    selected = expanded;
  }

  const requestedKind = opts.kind ?? "all";
  return [...new Map(selected.map((source) => [source.ref, source])).values()]
    .filter((source) => kindMatches(source, requestedKind))
    .filter((source) => commandCanRun(source, Boolean(opts.repo)));
}

function declaredArgs(
  command: AdapterCommand,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const schema = command.adapterArgs ?? [];
  const names = new Set(schema.map((arg) => arg.name));
  const filtered = Object.fromEntries(
    Object.entries(args).filter(
      ([name, value]) => names.has(name) && value !== undefined,
    ),
  );
  const resolved = resolveArgs({
    opts: filtered,
    positionals: [],
    schema: schema.map((arg) => ({ ...arg, positional: false })),
    stdinIsTTY: true,
  });
  return Object.fromEntries(
    Object.entries(resolved.args).filter(([name]) => names.has(name)),
  );
}

function parseVendors(
  raw: string | undefined,
): Array<keyof typeof VENDOR_CONFIG> {
  return parseCsv(raw).map((value) => {
    const normalized = value.toLowerCase();
    if (normalized === "huawei" || normalized === "ascend") {
      return "huawei-ascend";
    }
    if (normalized === "nvidia" || normalized === "amd") return normalized;
    if (normalized === "huawei-ascend") return normalized;
    throw new Error(`unsupported AI infrastructure vendor: ${value}`);
  });
}

function searchQueryForSource(
  source: AiSourceCommand,
  query: string,
  opts: AiSearchOptions,
): string {
  const vendors = parseVendors(opts.vendors);
  const vendorTerms = vendors
    .filter(
      (vendor) =>
        !VENDOR_CONFIG[vendor].terms.some((term) =>
          query.toLowerCase().includes(term.toLowerCase()),
        ),
    )
    .map((vendor) => VENDOR_CONFIG[vendor].terms[0]);
  const vendorScope = vendorTerms
    .map((term) => (term.includes(" ") ? `"${term}"` : term))
    .join(" OR ");
  let scoped = vendorTerms.length === 1 ? `${query} ${vendorTerms[0]}` : query;

  if (source.kind === "docs") {
    const explicitDomains = parseCsv(opts.domains);
    const vendorDomains = vendors.flatMap(
      (vendor) => VENDOR_CONFIG[vendor].domains,
    );
    const domains =
      explicitDomains.length > 0
        ? explicitDomains
        : vendorDomains.length > 0
          ? vendorDomains
          : [...OFFICIAL_AI_INFRA_DOMAINS];
    const vendorQuery = vendorTerms.length === 1 ? `(${vendorScope})` : "";
    scoped = `${query} ${vendorQuery} (${domains.map((domain) => `site:${domain}`).join(" OR ")})`;
  }
  if (
    opts.repo &&
    source.site === "gh" &&
    (source.kind === "issue" || source.kind === "pull-request")
  ) {
    scoped = `${scoped} repo:${opts.repo}`;
  }
  if (opts.since && source.site === "gh") {
    const qualifier = source.kind === "repository" ? "pushed" : "updated";
    scoped = `${scoped} ${qualifier}:>=${opts.since}`;
  } else if (opts.since && source.kind === "docs") {
    scoped = `${scoped} after:${opts.since}`;
  }
  return scoped.trim().replace(/\s+/g, " ");
}

function sourceSort(source: AiSourceCommand, mode: string): string {
  if (mode === "latest") {
    if (source.site === "hackernews") return "date";
    if (source.site === "arxiv") return "submittedDate";
    if (source.site === "stackoverflow") return "activity";
    if (source.site === "lobsters") return "newest";
  }
  if (source.site === "hackernews" || source.site === "arxiv") {
    return "relevance";
  }
  if (source.site === "stackoverflow" || source.site === "lobsters") {
    return "relevance";
  }
  if (source.site === "gh") return "updated";
  return "lastModified";
}

function retryCommand(
  source: AiSourceCommand,
  args: Record<string, unknown>,
): string {
  const positionals: string[] = [];
  const options: string[] = [];
  for (const arg of source.command.adapterArgs ?? []) {
    const value = args[arg.name];
    if (value === undefined || value === "") continue;
    if (arg.positional) {
      positionals.push(shellQuote(String(value)));
      continue;
    }
    const flag = `--${arg.name.replaceAll("_", "-")}`;
    if (arg.type === "bool") {
      if (value === true) options.push(flag);
    } else {
      options.push(flag, shellQuote(String(value)));
    }
  }
  return ["unicli", source.site, source.name, ...positionals, ...options].join(
    " ",
  );
}

function retryAiSearchCommand(
  query: string,
  opts: AiSearchOptions,
  omitSince = false,
): string {
  const parts = ["unicli", "ai", "search", shellQuote(query)];
  for (const name of [
    "sources",
    "kind",
    "vendors",
    "domains",
    "repo",
    "sort",
    "since",
    "limit",
  ] as const) {
    if (omitSince && name === "since") continue;
    const value = opts[name];
    if (value === undefined || value === "") continue;
    parts.push(`--${name}`, shellQuote(String(value)));
  }
  return parts.join(" ");
}

async function runAiSource(
  source: AiSourceCommand,
  query: string,
  opts: AiSearchOptions,
  retrievedAt: string,
): Promise<{ records: AiContentRecord[]; error?: AiSourceError }> {
  const requestedLimit = parseLimit(opts.limit, 20);
  const hasPostFilter =
    parseCsv(opts.vendors).length > 0 || parseCsv(opts.domains).length > 0;
  const needsRankingWindow = opts.sort === "latest" || Boolean(opts.since);
  const perSourceLimit = Math.min(
    hasPostFilter || needsRankingWindow
      ? Math.max(requestedLimit * 3, 20)
      : requestedLimit,
    30,
  );
  const sourceQuery = searchQueryForSource(source, query, opts);
  const args = declaredArgs(source.command, {
    query: sourceQuery,
    repo: opts.repo,
    limit: perSourceLimit,
    sort: sourceSort(source, opts.sort ?? "relevance"),
    order: "desc",
  });
  const invocation = buildInvocation(
    "cli",
    source.site,
    source.name,
    { args, source: "internal" },
    { approved: true, signal: AbortSignal.timeout(AI_SOURCE_TIMEOUT_MS) },
  );
  const rerun = retryCommand(source, args);
  if (!invocation) {
    return {
      records: [],
      error: {
        ref: source.ref,
        code: "build_invocation_failed",
        message: `could not build ${source.ref}`,
        suggestion: `Inspect the registered contract with \`unicli describe ${source.site} ${source.name}\`.`,
        alternatives: [`unicli describe ${source.site} ${source.name}`, rerun],
        retry_command: rerun,
      },
    };
  }
  const result = await execute(invocation);
  if (result.error) {
    return {
      records: [],
      error: {
        ref: source.ref,
        code: result.error.code,
        message: result.error.message,
        suggestion: result.error.suggestion ?? `Retry or repair ${source.ref}.`,
        adapter_path: result.error.adapter_path,
        step: result.error.step,
        retryable: result.error.retryable,
        alternatives: [...(result.error.alternatives ?? []), rerun],
        retry_command: rerun,
      },
    };
  }
  return {
    records: coerceAiContentRecords(
      result.results,
      source,
      sourceQuery,
      retrievedAt,
    ),
  };
}

function parseLimit(
  value: string | number | undefined,
  fallback: number,
  label = "limit",
): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 100) {
    throw new AiCommandFailure({
      code: "invalid_input",
      message: `${label} must be an integer between 1 and 100.`,
      suggestion: `Use --${label.replaceAll("_", "-")} with an integer from 1 to 100.`,
    });
  }
  return parsed;
}

function invalidSearchInput(message: string): AiCommandFailure {
  return new AiCommandFailure({
    code: "invalid_input",
    message,
    suggestion:
      "Run `unicli ai sources` and choose registered source refs, kinds, vendors, and a limit from 1 to 100.",
    alternatives: ["unicli ai sources"],
  });
}

function validateSince(value: string | undefined): void {
  if (!value) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw invalidSearchInput("since must use YYYY-MM-DD syntax.");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw invalidSearchInput("since must be a valid calendar date.");
  }
}

function timestampMillis(record: AiContentRecord): number | undefined {
  const value = record.updated_at || record.published_at;
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export async function searchAiContent(
  query: string,
  opts: AiSearchOptions = {},
): Promise<AiSearchResult[]> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) throw invalidSearchInput("query cannot be empty.");
  if (opts.kind && !AI_CONTENT_KINDS.has(opts.kind)) {
    throw invalidSearchInput(`unsupported AI content kind: ${opts.kind}`);
  }
  if (opts.sort && opts.sort !== "relevance" && opts.sort !== "latest") {
    throw invalidSearchInput(`unsupported AI search sort: ${opts.sort}`);
  }
  validateSince(opts.since);
  if (opts.repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(opts.repo)) {
    throw invalidSearchInput("repo must use OWNER/REPO syntax.");
  }

  let sources: AiSourceCommand[];
  try {
    sources = resolveAiSources(opts);
    parseVendors(opts.vendors);
  } catch (error) {
    if (error instanceof AiCommandFailure) throw error;
    throw invalidSearchInput(
      error instanceof Error ? error.message : String(error),
    );
  }
  const limit = parseLimit(opts.limit, 20);
  if (sources.length === 0) {
    throw new AiCommandFailure({
      code: "AI_SOURCE_SCOPE_EMPTY",
      message:
        "No registered AI source can satisfy the requested kind/repository scope.",
      suggestion:
        "Run `unicli ai sources` and select a compatible source; GitHub discussions require --repo OWNER/REPO.",
      alternatives: ["unicli ai sources"],
    });
  }

  const retrievedAt = new Date().toISOString();
  const vendorScopes = parseVendors(opts.vendors);
  const sourceRuns = sources.flatMap((source) => {
    const scopes =
      source.kind === "docs" && vendorScopes.length > 1
        ? vendorScopes.map((vendor) => ({ ...opts, vendors: vendor }))
        : [opts];
    return scopes.map((sourceScope) => ({ source, sourceScope }));
  });
  const outcomes = await mapConcurrent(
    sourceRuns,
    AI_SOURCE_CONCURRENCY,
    ({ source, sourceScope }) =>
      runAiSource(source, normalizedQuery, sourceScope, retrievedAt),
  );

  const errors = outcomes
    .map((outcome) => outcome.error)
    .filter((error): error is AiSourceError => error !== undefined);
  const recordLists = outcomes.map((outcome) => outcome.records);
  let rows = reciprocalRankFuse(
    recordLists,
    recordLists.reduce((sum, records) => sum + records.length, 0),
  );

  const requestedDomains = parseCsv(opts.domains).map((domain) =>
    domain.toLowerCase(),
  );
  if (requestedDomains.length > 0) {
    rows = rows.filter((row) =>
      requestedDomains.some(
        (domain) => row.domain === domain || row.domain.endsWith(`.${domain}`),
      ),
    );
  }
  const requestedVendors = parseVendors(opts.vendors);
  if (requestedVendors.length > 0) {
    rows = rows.filter((row) =>
      requestedVendors.some((vendor) => row.vendors.includes(vendor)),
    );
  }
  const unverifiableBeforeSince = opts.since
    ? rows.filter((row) => timestampMillis(row) === undefined).length
    : 0;
  if (opts.since) {
    const sinceMillis = Date.parse(`${opts.since}T00:00:00.000Z`);
    rows = rows.filter((row) => {
      const timestamp = timestampMillis(row);
      return timestamp !== undefined && timestamp >= sinceMillis;
    });
  }
  const freshnessMode = opts.sort === "latest" ? "latest" : "relevance";
  if (freshnessMode === "latest") {
    rows.sort((left, right) => {
      const byTime =
        (timestampMillis(right) ?? Number.NEGATIVE_INFINITY) -
        (timestampMillis(left) ?? Number.NEGATIVE_INFINITY);
      return byTime || (right.rrf_score ?? 0) - (left.rrf_score ?? 0);
    });
  }
  rows = rows.slice(0, limit);

  if (rows.length === 0) {
    const sourceFailures = errors.map((error) =>
      `${error.ref}: ${error.code} ${error.message}; ${error.suggestion}`.trim(),
    );
    const uniformFailureCode =
      errors.length === outcomes.length &&
      new Set(errors.map((error) => error.code)).size === 1
        ? errors[0]?.code
        : undefined;
    const freshnessGap = Boolean(opts.since && unverifiableBeforeSince > 0);
    const freshnessSuggestion = freshnessGap
      ? `${unverifiableBeforeSince} normalized source result(s) lacked a source or search-index timestamp, so the strict --since bound excluded them. Retry without --since, inspect timestamp_origin, then refresh a canonical candidate with \`unicli ai read <url>\`.`
      : undefined;
    throw new AiCommandFailure({
      code: uniformFailureCode ?? "empty_result",
      message: freshnessGap
        ? `No timestamp-verifiable results matched --since ${opts.since} across ${sources.length} registered sources.`
        : `No normalized results matched across ${sources.length} registered sources.`,
      suggestion:
        freshnessSuggestion && sourceFailures.length > 0
          ? `${freshnessSuggestion} Source failures: ${sourceFailures.join("; ")}`
          : (freshnessSuggestion ??
            (sourceFailures.length > 0
              ? sourceFailures.join("; ")
              : "Broaden the query or run `unicli ai sources` to choose a wider source scope.")),
      retryable: errors.some((error) => error.retryable === true),
      alternatives: [
        ...new Set([
          ...errors.flatMap((error) => error.alternatives),
          ...(freshnessGap
            ? [retryAiSearchCommand(normalizedQuery, opts, true)]
            : []),
          "unicli ai sources",
        ]),
      ],
    });
  }

  return rows.map((row, index) => ({
    ...row,
    ...(index === 0 ? { source_errors: errors } : {}),
    partial_failure_count: errors.length,
    freshness_mode: freshnessMode,
    source_timestamp: row.updated_at || row.published_at,
    freshness_verifiable: timestampMillis(row) !== undefined,
    next_read: `unicli ai read ${shellQuote(row.url)}`,
  }));
}

export async function readAiContent(
  url: string,
  opts: { maxCharsK?: string | number; maxLinks?: string | number } = {},
): Promise<Record<string, unknown>> {
  const maxChars = parseLimit(opts.maxCharsK, 100, "max_chars_k") * 1_000;
  const maxLinks = parseLimit(opts.maxLinks, 100, "max_links");
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new AiCommandFailure({
      code: "invalid_input",
      message: "url must be an absolute HTTP(S) URL.",
      suggestion: "Pass the canonical URL from an `unicli ai search` result.",
    });
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new AiCommandFailure({
      code: "invalid_input",
      message: "url must use HTTP or HTTPS.",
      suggestion: "Pass the canonical URL from an `unicli ai search` result.",
    });
  }

  const resolved = getAllAdapters().find((adapter) => adapter.name === "web");
  const command = resolved?.commands.read;
  if (!resolved || !command) {
    throw new AiCommandFailure({
      code: "AI_READ_UNAVAILABLE",
      message: "Registered web.read command is unavailable.",
      suggestion: "Repair or restore the web.read adapter before retrying.",
    });
  }
  const invocation = buildInvocation(
    "cli",
    "web",
    "read",
    {
      args: declaredArgs(command, { url: parsedUrl.toString() }),
      source: "internal",
    },
    { approved: true },
  );
  if (!invocation) {
    throw new AiCommandFailure({
      code: "AI_READ_UNAVAILABLE",
      message: "Could not build web.read invocation.",
      suggestion:
        "Run `unicli describe web read` to inspect the adapter contract.",
    });
  }
  const result = await execute(invocation);
  if (result.error) {
    throw new AiCommandFailure({
      code: result.error.code,
      message: result.error.message,
      suggestion:
        result.error.suggestion ??
        "Retry the canonical source URL or use an authenticated site adapter.",
      retryable: result.error.retryable ?? false,
      alternatives: [`unicli web read ${shellQuote(url)}`],
    });
  }
  const markdown = result.results
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean)
    .join("\n\n");
  if (!markdown) {
    throw new AiCommandFailure({
      code: "AI_READ_EMPTY",
      message: "web.read returned no document content.",
      suggestion:
        "Try the canonical documentation URL or inspect `unicli repair web read`.",
    });
  }
  const row = structureAiDocument(
    parsedUrl.toString(),
    markdown,
    new Date().toISOString(),
    maxChars,
    maxLinks,
  );
  return {
    ...row,
    next_search: `unicli ai search ${shellQuote(String(row.title))} --domains ${String(row.domain)}`,
  };
}

export function listAiSourceRows(): Array<Record<string, unknown>> {
  return listAiSourceCommands().map((source) => ({
    source: source.ref,
    description: source.command.description ?? "",
    kind: source.kind,
    source_class: source.sourceClass,
    capabilities: (source.command.capabilities ?? []).join(", "),
    minimum_capability: source.command.minimum_capability ?? "",
    required_args: (source.command.adapterArgs ?? [])
      .filter((arg) => arg.required)
      .map((arg) => arg.name)
      .join(", "),
    auth: commandRequiresAuth(source.adapter, source.command),
    auth_setup: commandAuthSetupCommand(source.adapter, source.command) ?? "",
    strategy: commandStrategy(source.adapter, source.command) ?? "",
    domain: source.command.domain ?? source.adapter.domain ?? "",
    adapter_path: source.command.adapter_path ?? "",
    next_search: `unicli ai search '<query>' --sources ${source.ref}`,
  }));
}
