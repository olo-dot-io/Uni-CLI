/**
 * @owner       src::adapters::retrieval::intelligence
 * @does        Registers domain-neutral retrieval source discovery and federated search over retrieval metadata.
 * @needs       engine/retrieval, adapter registry, and the shared invocation kernel
 * @feeds       `unicli retrieval search|sources` for AI, security, databases, medicine, climate, standards, and future domain packs
 * @breaks      Hard-coded site lists or domain vocabularies would turn the generic evidence surface into another coupled vertical.
 * @invariants  Default search uses public search-index sources; broader or optionally authenticated sources require explicit selection but never become mandatory auth; every result retains normalized provenance and its raw source record; partial failures remain visible.
 * @side-effects search executes selected read-only source commands; sources is network-free.
 * @perf        Fan-out is capped at six requests, 20 seconds per source, 30 results per source, and 100 fused results.
 * @concurrency Each source request owns its timeout and result state.
 * @test        tests/unit/engine/retrieval.test.ts and live cross-industry evidence probes
 * @stability   experimental
 * @since       2026-07-17
 */

import {
  executeRetrievalRequests,
  listRetrievalSources,
  normalizeEvidenceCandidates,
  RetrievalFailure,
  retrievalSourceCanRun,
  selectRetrievalSources,
} from "../../engine/retrieval.js";
import { evidenceRetryCommand } from "../../engine/evidence-reader.js";
import { cli, Strategy } from "../../registry.js";

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

function timestamp(row: { updated_at: string; published_at: string }): number {
  const parsed = Date.parse(row.updated_at || row.published_at);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
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
  args: [
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
        "Comma-separated exact refs, sites, kinds, or source classes; use all explicitly for every registered source",
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
  ],
  columns: [
    "title",
    "result_kind",
    "source_class",
    "source_adapter",
    "updated_at",
    "url",
    "summary",
  ],
  capabilities: [...EVIDENCE_CAPABILITIES, "evidence.discover"],
  auth_requirement: "optional",
  executables: ["gh"],
  minimum_capability: "http.fetch",
  func: async (_page, kwargs, context) => {
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
    const sources = selectRetrievalSources(
      csv(kwargs.sources, "search-index"),
      {
        resultKind: text(kwargs.kind),
        sourceClass: text(kwargs.source_class),
      },
    ).filter((source) => retrievalSourceCanRun(source, values));
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
        signal: context.signal,
      },
    );
    const errors = outcomes
      .map((outcome) => outcome.error)
      .filter((error) => error !== undefined);
    const candidates = normalizeEvidenceCandidates(outcomes, limit);
    if (text(kwargs.sort) === "latest") {
      candidates.sort((left, right) => timestamp(right) - timestamp(left));
    }
    if (candidates.length === 0) {
      throw new RetrievalFailure({
        code: "empty_result",
        message: "Selected retrieval sources returned no evidence candidates.",
        suggestion:
          "Broaden the query or inspect source-specific failures and retry commands.",
        retryable: errors.some((error) => error.retryable === true),
        alternatives: [
          ...new Set(errors.flatMap((error) => error.alternatives)),
        ],
      });
    }
    return candidates.map((candidate, index) => ({
      ...candidate,
      partial_failure_count: errors.length,
      source_errors: index === 0 ? errors : undefined,
      next_read: candidate.url ? evidenceRetryCommand(candidate.url) : "",
    }));
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
    listRetrievalSources().map((source) => ({
      source: source.ref,
      description: source.command.description ?? "",
      result_kind: source.metadata.result_kind,
      source_class: source.metadata.source_class,
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
