/**
 * @owner       src::commands::ai
 * @does        Provides profile-aware AI search/pulse, source and primary-target discovery, normalization, provenance, deduplication, and AI enrichment over the domain-neutral retrieval contract.
 * @needs       src/commands/ai-content.ts, src/commands/ai-landscape.ts, adapter retrieval metadata, shared kernel execution, and the evidence-document reader
 * @feeds       Agent AI research loops through `unicli ai search|pulse|read|sources|landscape|profiles`
 * @breaks      Missing AI source-pack refs, weak domain enrichment, silent source failures, or lossy normalization make current AI evidence undiscoverable or untraceable.
 * @invariants  Search executes only registered read-only retrieval commands selected by AI profiles after the outer orchestrator is authorized; internal fan-out passes only declared mapped args; partial failures are counted on every row and detailed once per response; every result retains source adapter, command, canonical URL, retrieval time, and inferred provenance class.
 * @side-effects Search and pulse execute registered read-only adapters; read may create and remove one temporary PDF artifact while extracting text; sources, landscape, and profiles are network-free.
 * @perf        Source fan-out is bounded to six concurrent requests with a 20-second per-source deadline; HTML readers are bounded to 30 seconds and PDF extraction to 60 seconds; normalization and reciprocal-rank fusion are O(S * R).
 * @concurrency Independent source invocations run in a bounded worker pool; each owns an abort signal and result state.
 * @test        tests/unit/commands/ai.test.ts, tests/unit/adapters/ai-intelligence.test.ts, plus live ai/hf/gh/web probes
 * @stability   experimental
 * @since       2026-07-17
 */

import {
  coerceAiContentRecords,
  enrichAiEvidenceDocument,
  reciprocalRankFuse,
  type AiContentRecord,
  type AiContentSource,
  type AiVendor,
} from "./ai-content.js";
import {
  AUTHENTICATED_AI_SOURCE_REFS,
  AI_ROLE_PROFILES,
  OPTIONAL_AI_SOURCE_REFS,
  listAiLandscapeRows,
  listAiProfileRows,
  resolveAiRoleProfile,
  selectAiOfficialDomains,
  type AiRoleProfileId,
} from "./ai-landscape.js";
import { mapConcurrent } from "../engine/download.js";
import {
  EvidenceReadFailure,
  readEvidenceDocument,
} from "../engine/evidence-reader.js";
import {
  executeRetrievalRequests,
  listRetrievalSources,
  retrievalSourceCanRun,
  type RetrievalRequest,
  type RetrievalSource,
} from "../engine/retrieval.js";
import {
  commandAuthSetupCommand,
  commandRequiresAuth,
  commandStrategy,
} from "../registry.js";

interface AiSourceCommand extends AiContentSource, RetrievalSource {}

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
  profile?: string;
  signal?: AbortSignal;
}

export interface AiPulseOptions {
  profile?: string;
  query?: string;
  sources?: string;
  window?: string;
  includeAuth?: boolean;
  limit?: string | number;
  signal?: AbortSignal;
}

export interface AiPulseResult extends AiSearchResult {
  pulse_profile: AiRoleProfileId;
  pulse_window: string;
  pulse_queries: string[];
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

const AI_SOURCE_CONCURRENCY = 6;
const AI_SOURCE_TIMEOUT_MS = 20_000;

export const AI_RETRIEVAL_CAPABILITIES = [
  "http.fetch",
  "subprocess.exec",
  "auth.executable.gh",
  "cdp-browser.navigate",
  "cdp-browser.evaluate",
  "scholar.search",
  "scholar.pdf",
  "scholar.code",
  "scholar.datasets",
  "scholar.review",
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
  "intel-ai": {
    terms: ["Intel Gaudi", "Habana", "oneAPI", "oneDNN"],
    domains: ["docs.habana.ai", "intel.com", "oneapi.io"],
  },
  "aws-neuron": {
    terms: ["AWS Neuron", "Trainium", "Inferentia"],
    domains: [
      "awsdocs-neuron.readthedocs-hosted.com",
      "docs.aws.amazon.com",
      "aws.amazon.com",
    ],
  },
  "google-tpu": {
    terms: ["Google Cloud TPU", "TPU", "XLA"],
    domains: ["cloud.google.com", "docs.cloud.google.com"],
  },
  cerebras: {
    terms: ["Cerebras", "Wafer Scale Engine", "WSE"],
    domains: ["docs.cerebras.net", "cerebras.ai"],
  },
  groq: {
    terms: ["Groq LPU", "GroqCloud"],
    domains: ["console.groq.com", "groq.com"],
  },
  tenstorrent: {
    terms: ["Tenstorrent", "TT-Metal"],
    domains: ["docs.tenstorrent.com", "tenstorrent.com"],
  },
  sambanova: {
    terms: ["SambaNova", "SN40L"],
    domains: ["docs.sambanova.ai", "sambanova.ai"],
  },
  "apple-mlx": {
    terms: ["Apple MLX", "Metal"],
    domains: ["ml-explore.github.io", "developer.apple.com"],
  },
  "qualcomm-ai": {
    terms: ["Qualcomm AI", "Hexagon NPU", "Cloud AI 100"],
    domains: ["docs.qualcomm.com", "qualcomm.com"],
  },
  "alibaba-thead": {
    terms: ["Alibaba T-Head", "平头哥", "含光", "Hanguang"],
    domains: ["developer.t-head.cn", "t-head.cn"],
  },
  kunlunxin: {
    terms: ["Kunlunxin", "昆仑芯", "Kunlun XPU"],
    domains: ["kunlunxin.com", "paddlepaddle.org.cn"],
  },
  cambricon: {
    terms: ["Cambricon", "寒武纪", "MLU", "MagicMind", "BANG C"],
    domains: ["developer.cambricon.com", "cambricon.com"],
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
  "release",
  "commit",
  "post",
  "video",
  "benchmark",
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
  const configuredRefs = new Set([
    ...AI_ROLE_PROFILES.flatMap((profile) => profile.sourceRefs),
    ...AUTHENTICATED_AI_SOURCE_REFS,
    ...OPTIONAL_AI_SOURCE_REFS,
  ]);
  return listRetrievalSources()
    .filter((source) => configuredRefs.has(source.ref))
    .map((source) => ({
      ...source,
      kind: source.metadata.result_kind,
      sourceClass: source.metadata.source_class,
    }));
}

function commandCanRun(
  source: AiSourceCommand,
  opts: AiSearchOptions,
): boolean {
  return retrievalSourceCanRun(source, {
    query: "query",
    limit: 1,
    sort: "relevance",
    order: "desc",
    since: opts.since,
    repository: opts.repo,
  });
}

function kindMatches(source: AiSourceCommand, requested: string): boolean {
  if (requested === "all") return true;
  if (requested === "community") {
    return ["community", "discussion", "post", "video"].includes(source.kind);
  }
  return source.kind === requested;
}

function resolveAiSources(opts: AiSearchOptions): AiSourceCommand[] {
  const available = listAiSourceCommands();
  const byRef = new Map(available.map((source) => [source.ref, source]));
  const requested = parseCsv(opts.sources);
  let selected: AiSourceCommand[];

  if (requested.length === 0) {
    const refs: string[] = [...resolveAiRoleProfile(opts.profile).sourceRefs];
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
    .filter((source) => commandCanRun(source, opts));
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
    if (
      ["t-head", "thead", "hanguang", "平头哥", "含光"].includes(normalized)
    ) {
      return "alibaba-thead";
    }
    if (["kunlun", "kunlunxin", "昆仑", "昆仑芯"].includes(normalized)) {
      return "kunlunxin";
    }
    if (["cambricon", "寒武纪", "mlu"].includes(normalized)) {
      return "cambricon";
    }
    if (normalized in VENDOR_CONFIG) {
      return normalized as keyof typeof VENDOR_CONFIG;
    }
    throw new Error(`unsupported AI infrastructure vendor: ${value}`);
  });
}

function inferVendorScopeFromQuery(query: string): string | undefined {
  const matches = [
    {
      vendor: "nvidia",
      pattern: /\b(?:nvidia|cuda|nvlink|nvswitch|nvml|nvls|dcgm|dgx)\b/i,
    },
    { vendor: "amd", pattern: /\b(?:amd|rocm|instinct)\b/i },
    {
      vendor: "huawei-ascend",
      pattern: /(?:华为昇腾|昇腾|\bascend\b|\bmindie\b|\bcann\b)/i,
    },
    {
      vendor: "alibaba-thead",
      pattern: /(?:平头哥|含光|玄铁|\bt-?head\b|\bhanguang\b)/i,
    },
    {
      vendor: "kunlunxin",
      pattern: /(?:昆仑芯|\bkunlunxin\b|\bkunlun xpu\b)/i,
    },
    {
      vendor: "cambricon",
      pattern:
        /(?:寒武纪|\bcambricon\b|\bmagicmind\b|\bneuware\b|\bbang c\b|\bmlu[- ]?\d*\b)/i,
    },
  ]
    .filter(({ pattern }) => pattern.test(query))
    .map(({ vendor }) => vendor);
  return matches.length === 1 ? matches[0] : undefined;
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
  let scoped = query;

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
          : selectAiOfficialDomains(query, opts.profile);
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
    if (source.site === "bluesky") return "latest";
    if (source.site === "opencsg") return "recently_update";
  }
  if (source.site === "hackernews" || source.site === "arxiv") {
    return "relevance";
  }
  if (source.site === "stackoverflow" || source.site === "lobsters") {
    return "relevance";
  }
  if (source.site === "gh") return "updated";
  if (source.site === "bluesky") return "top";
  if (source.site === "opencsg") return "trending";
  return "lastModified";
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
    "profile",
  ] as const) {
    if (omitSince && name === "since") continue;
    const value = opts[name];
    if (value === undefined || value === "") continue;
    parts.push(`--${name}`, shellQuote(String(value)));
  }
  return parts.join(" ");
}

function prepareAiRetrievalRequest(
  source: AiSourceCommand,
  query: string,
  opts: AiSearchOptions,
): { request: RetrievalRequest; sourceQuery: string } {
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
  return {
    request: {
      source,
      values: {
        query: sourceQuery,
        repository: opts.repo,
        limit: perSourceLimit,
        sort: sourceSort(source, opts.sort ?? "relevance"),
        order: "desc",
        since: opts.since ? `${opts.since}T00:00:00.000Z` : undefined,
      },
    },
    sourceQuery,
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

function scholarlyReadRef(row: AiContentRecord): string {
  if (row.arxiv_id) return `arxiv:${row.arxiv_id}`;
  if (row.doi) return row.doi;
  return row.title;
}

function nextReadCommand(row: AiContentRecord): string {
  return row.kind === "paper"
    ? `unicli scholar read ${shellQuote(scholarlyReadRef(row))}`
    : `unicli ai read ${shellQuote(row.url)}`;
}

function filterProfilePhraseNoise(
  rows: AiContentRecord[],
  query: string,
  profileValue: string | undefined,
): AiContentRecord[] {
  const normalizedQuery = query.toLowerCase().replaceAll(/\s+/g, " ");
  const phrases = resolveAiRoleProfile(profileValue).keywords.filter(
    (keyword) =>
      keyword.includes(" ") && normalizedQuery.includes(keyword.toLowerCase()),
  );
  if (phrases.length === 0) return rows;
  const communityKinds = new Set(["community", "discussion", "post", "video"]);
  return rows.filter((row) => {
    if (!communityKinds.has(row.kind)) return true;
    const corpus = `${row.title} ${row.summary} ${row.tags.join(" ")}`
      .toLowerCase()
      .replaceAll(/\s+/g, " ");
    return phrases.some((phrase) => corpus.includes(phrase.toLowerCase()));
  });
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
  const inferredVendor = opts.vendors
    ? undefined
    : inferVendorScopeFromQuery(normalizedQuery);
  const effectiveOpts = inferredVendor
    ? { ...opts, vendors: inferredVendor }
    : opts;

  let sources: AiSourceCommand[];
  try {
    resolveAiRoleProfile(effectiveOpts.profile);
    sources = resolveAiSources(effectiveOpts);
    parseVendors(effectiveOpts.vendors);
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
  const vendorScopes = parseVendors(effectiveOpts.vendors);
  const sourceRuns = sources.flatMap((source) => {
    const scopes =
      source.kind === "docs" && vendorScopes.length > 1
        ? vendorScopes.map((vendor) => ({ ...effectiveOpts, vendors: vendor }))
        : [effectiveOpts];
    return scopes.map((sourceScope) => ({ source, sourceScope }));
  });
  const prepared = sourceRuns.map(({ source, sourceScope }) =>
    prepareAiRetrievalRequest(source, normalizedQuery, sourceScope),
  );
  const retrievalOutcomes = await executeRetrievalRequests(
    prepared.map(({ request }) => request),
    {
      allowedCapabilities: AI_RETRIEVAL_CAPABILITIES,
      concurrency: AI_SOURCE_CONCURRENCY,
      timeoutMs: AI_SOURCE_TIMEOUT_MS,
      signal: opts.signal,
      retrievedAt,
    },
  );
  const outcomes = retrievalOutcomes.map((outcome, index) => ({
    records: coerceAiContentRecords(
      outcome.results,
      outcome.source as AiSourceCommand,
      prepared[index].sourceQuery,
      retrievedAt,
    ),
    error: outcome.error,
  }));

  const errors = outcomes
    .map((outcome) => outcome.error)
    .filter((error): error is AiSourceError => error !== undefined);
  const recordLists = outcomes.map((outcome) => outcome.records);
  let rows = reciprocalRankFuse(
    recordLists,
    recordLists.reduce((sum, records) => sum + records.length, 0),
  );
  rows = filterProfilePhraseNoise(rows, normalizedQuery, opts.profile);

  const requestedDomains = parseCsv(effectiveOpts.domains).map((domain) =>
    domain.toLowerCase(),
  );
  if (requestedDomains.length > 0) {
    rows = rows.filter((row) =>
      requestedDomains.some(
        (domain) => row.domain === domain || row.domain.endsWith(`.${domain}`),
      ),
    );
  }
  const requestedVendors = parseVendors(effectiveOpts.vendors);
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
    next_read: nextReadCommand(row),
  }));
}

function pulseSince(window: string, now: Date): string | undefined {
  if (window === "all") return undefined;
  const days = window === "day" ? 1 : window === "week" ? 7 : 30;
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - days);
  return start.toISOString().slice(0, 10);
}

export async function pulseAiContent(
  opts: AiPulseOptions = {},
): Promise<AiPulseResult[]> {
  const profile = resolveAiRoleProfile(opts.profile);
  const window = opts.window ?? "week";
  if (!["day", "week", "month", "all"].includes(window)) {
    throw invalidSearchInput(`unsupported AI pulse window: ${window}`);
  }
  const limit = parseLimit(opts.limit, 20);
  const customQuery = opts.query?.trim();
  const queries = customQuery ? [customQuery] : profile.pulseQueries;
  if (queries.some((query) => !query)) {
    throw invalidSearchInput("pulse query cannot be empty.");
  }
  const requestedSources = parseCsv(opts.sources);
  const baseSources =
    requestedSources.length > 0 ? requestedSources : profile.sourceRefs;
  const sourceRefs = [
    ...new Set([
      ...baseSources,
      ...(opts.includeAuth ? AUTHENTICATED_AI_SOURCE_REFS : []),
    ]),
  ];
  const since = pulseSince(window, new Date());
  const outcomes = await mapConcurrent(queries, 2, async (query) => {
    try {
      const rows = await searchAiContent(query, {
        profile: profile.id,
        sources: sourceRefs.join(","),
        sort: "latest",
        since,
        limit: Math.min(Math.max(limit * 2, 20), 100),
        signal: opts.signal,
      });
      return { rows, error: undefined };
    } catch (error) {
      const failure =
        error instanceof AiCommandFailure
          ? error
          : new AiCommandFailure({
              code: "pulse_query_failed",
              message: error instanceof Error ? error.message : String(error),
              suggestion: `Retry the pulse lane with \`unicli ai search ${shellQuote(query)} --profile ${profile.id}\`.`,
            });
      return {
        rows: [] as AiSearchResult[],
        error: {
          ref: `ai.pulse:${query}`,
          code: failure.code,
          message: failure.message,
          suggestion: failure.suggestion,
          retryable: failure.retryable,
          alternatives: failure.alternatives,
          retry_command: `unicli ai search ${shellQuote(query)} --profile ${profile.id}`,
        } satisfies AiSourceError,
      };
    }
  });
  const errors = [
    ...new Map(
      outcomes
        .flatMap((outcome) => [
          ...(outcome.rows[0]?.source_errors ?? []),
          ...(outcome.error ? [outcome.error] : []),
        ])
        .map((error) => [`${error.ref}:${error.code}:${error.message}`, error]),
    ).values(),
  ];
  let rows = reciprocalRankFuse(
    outcomes.map((outcome) => outcome.rows),
    outcomes.reduce((count, outcome) => count + outcome.rows.length, 0),
  );
  rows.sort((left, right) => {
    const byTime =
      (timestampMillis(right) ?? Number.NEGATIVE_INFINITY) -
      (timestampMillis(left) ?? Number.NEGATIVE_INFINITY);
    return byTime || (right.rrf_score ?? 0) - (left.rrf_score ?? 0);
  });
  if (new Set(rows.map((row) => row.source_adapter)).size > 1) {
    const perSourceLimit = Math.max(2, Math.ceil(limit / 2));
    const sourceCounts = new Map<string, number>();
    rows = rows.filter((row) => {
      const count = sourceCounts.get(row.source_adapter) ?? 0;
      if (count >= perSourceLimit) return false;
      sourceCounts.set(row.source_adapter, count + 1);
      return true;
    });
  }
  rows = rows.slice(0, limit);
  if (rows.length === 0) {
    throw new AiCommandFailure({
      code: "empty_result",
      message: `No timestamp-verifiable ${profile.name} pulse results matched the ${window} window.`,
      suggestion:
        "Broaden --window, provide --query, or inspect `unicli ai sources` for source-specific recovery.",
      retryable: errors.some((error) => error.retryable === true),
      alternatives: ["unicli ai sources", "unicli ai pulse --window all"],
    });
  }
  return rows.map((row, index) => ({
    ...row,
    source_errors: index === 0 ? errors : undefined,
    partial_failure_count: errors.length,
    freshness_mode: "latest",
    source_timestamp: row.updated_at || row.published_at,
    freshness_verifiable: timestampMillis(row) !== undefined,
    next_read: nextReadCommand(row),
    pulse_profile: profile.id,
    pulse_window: window,
    pulse_queries: queries,
  }));
}

export { listAiLandscapeRows, listAiProfileRows };

export async function readAiContent(
  url: string,
  opts: {
    maxCharsK?: string | number;
    maxLinks?: string | number;
    reader?: string;
    firstPage?: string | number;
    lastPage?: string | number;
    signal?: AbortSignal;
  } = {},
): Promise<Record<string, unknown>> {
  const maxChars = parseLimit(opts.maxCharsK, 100, "max_chars_k") * 1_000;
  const maxLinks = parseLimit(opts.maxLinks, 100, "max_links");
  const firstPage = parseLimit(opts.firstPage, 1, "first_page");
  const lastPage = parseLimit(opts.lastPage, 20, "last_page");
  const reader = opts.reader ?? "direct";
  if (reader !== "direct" && reader !== "jina" && reader !== "defuddle") {
    throw new AiCommandFailure({
      code: "invalid_input",
      message: "reader must be direct, jina, or defuddle.",
      suggestion: "Use --reader direct, --reader jina, or --reader defuddle.",
    });
  }

  let evidence;
  try {
    evidence = await readEvidenceDocument(url, {
      maxChars,
      maxLinks,
      reader,
      firstPage,
      lastPage,
      signal: opts.signal,
    });
  } catch (error) {
    if (error instanceof EvidenceReadFailure) {
      throw new AiCommandFailure({
        code: error.code,
        message: error.message,
        suggestion: error.suggestion,
        retryable: error.retryable,
        alternatives: error.alternatives,
      });
    }
    throw error;
  }

  const enriched = enrichAiEvidenceDocument(evidence);
  const parsedUrl = new URL(evidence.url);
  const arxivId =
    /(?:^|\.)arxiv\.org$/i.test(parsedUrl.hostname) &&
    /^\/(?:pdf|abs)\/([^/?#]+?)(?:\.pdf)?$/.exec(parsedUrl.pathname)?.[1];
  const githubThread =
    parsedUrl.hostname.toLowerCase() === "github.com"
      ? /^\/([^/]+)\/([^/]+)\/(?:issues|pull)\/\d+\/?$/.exec(parsedUrl.pathname)
      : null;
  const title = arxivId ? `arXiv ${arxivId}` : evidence.title;
  const nextSearch = arxivId
    ? `unicli scholar read ${shellQuote(arxivId)}`
    : githubThread
      ? `unicli ai search ${shellQuote(title)} --repo ${githubThread[1]}/${githubThread[2]}`
      : `unicli ai search ${shellQuote(title)} --domains ${evidence.domain}`;

  return {
    ...enriched,
    title,
    next_search: nextSearch,
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
