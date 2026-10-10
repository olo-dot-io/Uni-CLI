/**
 * @owner       src::adapters::retrieval::intelligence
 * @does        Registers domain-neutral source discovery, federated search, and resumable resource acquisition.
 * @needs       engine/retrieval, adapter registry, and the shared invocation kernel
 * @feeds       `unicli retrieval search|acquire|sources` across registered evidence domains
 * @breaks      Hard-coded site lists or domain vocabularies would turn the generic evidence surface into another coupled vertical.
 * @invariants  Default search uses public search-index sources; broader or optionally authenticated sources require explicit selection but never become mandatory auth; every result retains normalized provenance and its raw source record; partial failures remain visible.
 * @side-effects search executes selected read-only sources; acquire writes bounded resource files and structured results; sources is network-free.
 * @perf        Fan-out is capped at six requests, 20 seconds per source, 30 results per source, and 100 fused results.
 * @concurrency Each source request owns its timeout and result state.
 * @test        tests/unit/engine/retrieval.test.ts and live cross-industry evidence probes
 * @stability   experimental
 * @since       2026-07-17
 */

import {
  acquireEvidenceResources,
  executeRetrievalRequests,
  listRetrievalSources,
  normalizeEvidenceCandidates,
  RetrievalFailure,
  retrievalSourceCanRun,
  selectRetrievalSources,
} from "../../engine/retrieval.js";
import { evidenceRetryCommand } from "../../engine/evidence-reader.js";
import { cli, Strategy } from "../../registry.js";
import type { AdapterArg } from "../../types.js";

const EVIDENCE_CAPABILITIES = [
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
  "patent.search",
] as const;

function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const result = String(value).trim();
  return result || undefined;
}

function csv(value: unknown, fallback = ""): string[] {
  return (text(value) ?? fallback)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function positiveLimit(value: unknown): number {
  const limit = Number(value ?? 20);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RetrievalFailure({
      code: "invalid_input",
      message: "limit must be an integer between 1 and 100.",
      suggestion: "Use --limit with an integer from 1 to 100.",
    });
  }
  return limit;
}

function sinceValue(value: unknown): string | undefined {
  const since = text(value);
  if (!since) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    throw new RetrievalFailure({
      code: "invalid_input",
      message: "since must use YYYY-MM-DD syntax.",
      suggestion: "Use --since with a valid calendar date.",
    });
  }
  const parsed = new Date(`${since}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== since
  ) {
    throw new RetrievalFailure({
      code: "invalid_input",
      message: "since must be a valid calendar date.",
      suggestion: "Use --since with a valid calendar date.",
    });
  }
  return parsed.toISOString();
}

const SEARCH_ARGS: AdapterArg[] = [
  {
    name: "query",
    type: "str",
    required: true,
    positional: true,
    description: "Research query in any domain",
  },
  {
    name: "sources",
    type: "str",
    default: "search-index",
    description:
      "Comma-separated exact refs, sites, kinds, or source classes; all selects automatic sources, while paid or configured providers require an exact ref or site",
  },
  {
    name: "kind",
    type: "str",
    description: "Extensible result kind such as docs, paper, or dataset",
  },
  {
    name: "source_class",
    type: "str",
    choices: ["official", "hosted-artifact", "community", "search-index"],
    description: "Optional acquisition/provenance class",
  },
  {
    name: "repository",
    type: "str",
    description: "Optional source role value such as GitHub OWNER/REPO",
  },
  {
    name: "since",
    type: "str",
    format: "date",
    description: "Optional YYYY-MM-DD source filter where supported",
  },
  {
    name: "sort",
    type: "str",
    default: "relevance",
    choices: ["relevance", "latest"],
    description: "Fuse by source relevance or sort by verifiable timestamp",
  },
  {
    name: "limit",
    type: "int",
    default: 20,
    description: "Maximum normalized candidates (1-100)",
  },
];

async function runRetrievalSearch(
  kwargs: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const query = text(kwargs.query);
  if (!query) {
    throw new RetrievalFailure({
      code: "invalid_input",
      message: "query cannot be empty.",
      suggestion: "Pass a concrete research question or source identifier.",
    });
  }
  const limit = positiveLimit(kwargs.limit);
  const since = sinceValue(kwargs.since);
  const values = {
    query,
    limit: Math.min(Math.max(limit * 2, 20), 30),
    repository: text(kwargs.repository),
    since,
  };
  const sources = selectRetrievalSources(csv(kwargs.sources, "search-index"), {
    resultKind: text(kwargs.kind),
    sourceClass: text(kwargs.source_class),
  }).filter((source) => retrievalSourceCanRun(source, values));
  if (sources.length === 0) {
    throw new RetrievalFailure({
      code: "retrieval_source_scope_empty",
      message: "No registered retrieval source can satisfy this scope.",
      suggestion:
        "Run `unicli retrieval sources` and select a compatible source, kind, or source class.",
      alternatives: ["unicli retrieval sources"],
    });
  }
  const outcomes = await executeRetrievalRequests(
    sources.map((source) => ({ source, values })),
    {
      allowedCapabilities: EVIDENCE_CAPABILITIES,
      concurrency: 6,
      timeoutMs: 20_000,
      signal,
    },
  );
  const errors = outcomes
    .map((outcome) => outcome.error)
    .filter((error) => error !== undefined);
  const candidates = normalizeEvidenceCandidates(outcomes, limit, {
    sort: text(kwargs.sort) === "latest" ? "latest" : "relevance",
  });
  if (candidates.length === 0) {
    const allFailed = errors.length === outcomes.length;
    const failureDetails = errors
      .map((error) => `${error.ref} (${error.code}): ${error.message}`)
      .join("; ");
    throw new RetrievalFailure({
      code: allFailed
        ? errors.every((error) => error.code === errors[0].code)
          ? errors[0].code
          : "upstream_error"
        : "empty_result",
      message: [
        allFailed
          ? "All selected retrieval sources failed."
          : "Selected retrieval sources returned no evidence candidates.",
        failureDetails,
      ]
        .filter(Boolean)
        .join(" "),
      suggestion:
        "Broaden the query or inspect source-specific failures and retry commands.",
      retryable: errors.some((error) => error.retryable === true),
      alternatives: [...new Set(errors.flatMap((error) => error.alternatives))],
    });
  }
  return candidates.map((candidate, index) => ({
    ...candidate,
    partial_failure_count: errors.length,
    source_errors: index === 0 ? errors : undefined,
    next_read: candidate.url ? evidenceRetryCommand(candidate.url) : "",
  }));
}

cli({
  site: "retrieval",
  name: "search",
  description:
    "Federate current records across registered retrieval providers without a domain-specific router; 通用跨行业实时检索来源，覆盖 AI、安全、数据库、医疗、气候、标准及未来行业的一手资料",
  strategy: Strategy.PUBLIC,
  browser: false,
  target_surface: "web",
  operation_effect: "read",
  idempotency: "guaranteed",
  execution_operator: "structured-api",
  args: SEARCH_ARGS,
  columns: [
    "title",
    "result_kind",
    "source_class",
    "selection",
    "source_adapter",
    "updated_at",
    "url",
    "summary",
  ],
  capabilities: [...EVIDENCE_CAPABILITIES, "evidence.discover"],
  auth_requirement: "optional",
  executables: ["gh"],
  minimum_capability: "http.fetch",
  func: async (_page, kwargs, context) =>
    runRetrievalSearch(kwargs, context.signal),
});

cli({
  site: "retrieval",
  name: "acquire",
  description:
    "Search or open a URL, save structured source documents, and download a bounded set of resource links; 搜索并下载资料，保存结构化结果，支持恢复重跑",
  strategy: Strategy.PUBLIC,
  browser: false,
  target_surface: "web",
  operation_family: "download",
  operation_effect: "download_file",
  idempotency: "conditional",
  execution_operator: "structured-api",
  args: [
    ...SEARCH_ARGS.map((argument) =>
      argument.name === "query" ? { ...argument, required: false } : argument,
    ),
    {
      name: "resume",
      type: "str",
      description:
        "Resume the selected resources in a saved results.json without repeating discovery",
    },
    {
      name: "dir",
      type: "str",
      default: "./downloads",
      description:
        "Output directory for files, structured documents, and results.json",
    },
    {
      name: "concurrency",
      type: "int",
      default: 3,
      minimum: 1,
      maximum: 8,
      description: "Maximum active resource downloads",
    },
    {
      name: "max_resources",
      type: "int",
      default: 20,
      minimum: 0,
      maximum: 100,
      description:
        "Maximum additional file links from selected result pages; 0 downloads selected URLs only",
    },
    {
      name: "max_bytes",
      type: "int",
      default: 52428800,
      minimum: 1,
      maximum: 1073741824,
      description: "Maximum bytes per downloaded resource",
    },
    {
      name: "timeout_ms",
      type: "int",
      default: 30000,
      minimum: 1,
      maximum: 300000,
      description: "Deadline in milliseconds per downloaded resource",
    },
    {
      name: "refresh",
      type: "bool",
      default: false,
      description:
        "Fetch selected resources again instead of reusing completed files",
    },
  ],
  capabilities: [
    ...EVIDENCE_CAPABILITIES,
    "evidence.discover",
    "http.download",
  ],
  auth_requirement: "optional",
  executables: ["gh"],
  minimum_capability: "http.download",
  func: async (_page, kwargs, context) => {
    const query = text(kwargs.query);
    const resume = text(kwargs.resume);
    if (Boolean(query) === Boolean(resume))
      throw new RetrievalFailure({
        code: "invalid_input",
        message: "Provide either query or resume.",
        suggestion:
          "Pass a research query, an HTTP(S) URL, or --resume <results.json>.",
      });
    const direct = /^https?:\/\/\S+$/i.test(query ?? "");
    const candidates =
      resume || direct ? [] : await runRetrievalSearch(kwargs, context.signal);
    return acquireEvidenceResources(query ?? "", candidates, {
      directory: text(kwargs.dir),
      resume,
      concurrency:
        kwargs.concurrency === undefined
          ? undefined
          : Number(kwargs.concurrency),
      maxResources:
        kwargs.max_resources === undefined
          ? undefined
          : Number(kwargs.max_resources),
      maxBytes:
        kwargs.max_bytes === undefined ? undefined : Number(kwargs.max_bytes),
      timeoutMs:
        kwargs.timeout_ms === undefined ? undefined : Number(kwargs.timeout_ms),
      refresh: kwargs.refresh === true,
      sourceErrors: candidates[0]?.source_errors,
      signal: context.signal,
    });
  },
});

cli({
  site: "retrieval",
  name: "sources",
  description:
    "List registered retrieval providers and their semantic argument mappings",
  strategy: Strategy.PUBLIC,
  browser: false,
  target_surface: "web",
  operation_effect: "read",
  idempotency: "guaranteed",
  execution_operator: "local-runtime",
  args: [],
  columns: [
    "source",
    "result_kind",
    "source_class",
    "argument_roles",
    "capabilities",
  ],
  capabilities: ["evidence.discover"],
  minimum_capability: "evidence.discover",
  func: async () =>
    listRetrievalSources({ discoverableOnly: true }).map((source) => ({
      source: source.ref,
      description: source.command.description ?? "",
      result_kind: source.metadata.result_kind,
      source_class: source.metadata.source_class,
      selection: source.metadata.selection ?? "automatic",
      argument_roles: Object.entries(source.metadata.arguments ?? {})
        .map(([role, argument]) => `${role}=${argument}`)
        .join(", "),
      required_args: (source.command.adapterArgs ?? [])
        .filter((argument) => argument.required)
        .map((argument) => argument.name)
        .join(", "),
      capabilities: (source.command.capabilities ?? []).join(", "),
      adapter_path: source.command.adapter_path ?? "",
      next_search: `unicli retrieval search '<query>' --sources ${source.ref}`,
    })),
});
