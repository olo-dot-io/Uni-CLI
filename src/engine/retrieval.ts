/**
 * @owner       src::engine::retrieval
 * @does        Discovers and executes read-only evidence-source commands through their domain-neutral retrieval metadata, then normalizes candidates without domain assumptions.
 * @needs       adapter registry, command contracts, argument resolver, kernel execution, bounded concurrency, and EvidenceDocument URL canonicalization
 * @feeds       generic retrieval commands and domain overlays such as AI search
 * @breaks      Inferring semantics from adapter names, bypassing outer capability scopes, or dropping source-specific raw records couples every domain to one orchestrator.
 * @invariants  Only read-only commands with valid retrieval metadata execute; semantic roles map only to declared arguments; source capabilities must be contained by the caller; cancellation retains caller identity; fused representatives come from the highest-ranked source while every outcome retains source identity and an exact retry command.
 * @side-effects Executes registered read-only source commands.
 * @perf        Request fan-out uses caller-bounded concurrency and per-source deadlines; candidate normalization is O(results).
 * @concurrency Each request owns its arguments, timeout signal, results, and error.
 * @test        tests/unit/engine/retrieval.test.ts, tests/unit/commands/ai.test.ts
 * @stability   experimental
 * @since       2026-07-17
 */

import { createHash } from "node:crypto";

import { buildCommandContract } from "../core/command-contract.js";
import { getAllAdapters } from "../registry.js";
import type {
  AdapterCommand,
  AdapterManifest,
  RetrievalMetadata,
} from "../types.js";
import { resolveArgs } from "./args.js";
import { mapConcurrent } from "./download.js";
import { canonicalizeUrl } from "./evidence-document.js";
import { buildInvocation, execute } from "./kernel/execute.js";

export interface RetrievalSource {
  ref: string;
  site: string;
  name: string;
  adapter: AdapterManifest;
  command: AdapterCommand;
  metadata: RetrievalMetadata;
}

export interface RetrievalSourceError {
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

export interface RetrievalRequest {
  source: RetrievalSource;
  values: Readonly<Record<string, unknown>>;
}

export interface RetrievalOutcome {
  source: RetrievalSource;
  arguments: Record<string, unknown>;
  retrieved_at: string;
  results: unknown[];
  error?: RetrievalSourceError;
}

export interface EvidenceCandidate {
  id: string;
  title: string;
  url: string;
  domain: string;
  summary: string;
  result_kind: string;
  source_class: RetrievalMetadata["source_class"];
  source_adapter: string;
  source_command: string;
  source_rank: number;
  source_refs: string[];
  published_at: string;
  updated_at: string;
  retrieved_at: string;
  rrf_score: number;
  raw: Record<string, unknown>;
}

type RetrievalFailureInit = {
  code: string;
  message: string;
  suggestion: string;
  retryable?: boolean;
  alternatives?: string[];
};

export class RetrievalFailure extends Error {
  readonly code: string;
  readonly suggestion: string;
  readonly retryable: boolean;
  readonly alternatives: string[];

  constructor(init: RetrievalFailureInit) {
    super(init.message);
    this.name = "RetrievalFailure";
    this.code = init.code;
    this.suggestion = init.suggestion;
    this.retryable = init.retryable ?? false;
    this.alternatives = init.alternatives ?? [];
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function listRetrievalSources(): RetrievalSource[] {
  return getAllAdapters()
    .flatMap((adapter) =>
      Object.entries(adapter.commands)
        .filter(
          (
            entry,
          ): entry is [
            string,
            AdapterCommand & { retrieval: RetrievalMetadata },
          ] => entry[1].retrieval?.operation === "discover",
        )
        .map(([name, command]) => {
          const contract = buildCommandContract({
            adapter,
            commandName: name,
            command,
          });
          if (!contract.effect.read_only) {
            throw new RetrievalFailure({
              code: "retrieval_source_not_read_only",
              message: `Registered retrieval source ${adapter.name}.${name} is not read-only.`,
              suggestion:
                "Remove retrieval metadata or redesign the command as a read-only operation.",
            });
          }
          return {
            ref: `${adapter.name}.${name}`,
            site: adapter.name,
            name,
            adapter,
            command,
            metadata: command.retrieval,
          };
        }),
    )
    .sort((left, right) => left.ref.localeCompare(right.ref));
}

export function selectRetrievalSources(
  selectors: readonly string[],
  filters: { resultKind?: string; sourceClass?: string } = {},
): RetrievalSource[] {
  const available = listRetrievalSources();
  const selected =
    selectors.length === 0
      ? available
      : selectors.flatMap((selector) => {
          if (selector === "all") return available;
          const matches = available.filter(
            (source) =>
              source.ref === selector ||
              source.site === selector ||
              source.metadata.result_kind === selector ||
              source.metadata.source_class === selector,
          );
          if (matches.length === 0) {
            throw new RetrievalFailure({
              code: "unknown_retrieval_source",
              message: `No retrieval source matches ${selector}.`,
              suggestion:
                "Run `unicli retrieval sources` and choose an exact ref, site, result kind, or source class.",
              alternatives: ["unicli retrieval sources"],
            });
          }
          return matches;
        });
  return [...new Map(selected.map((source) => [source.ref, source])).values()]
    .filter(
      (source) =>
        !filters.resultKind ||
        source.metadata.result_kind === filters.resultKind,
    )
    .filter(
      (source) =>
        !filters.sourceClass ||
        source.metadata.source_class === filters.sourceClass,
    );
}

export function retrievalSourceCanRun(
  source: RetrievalSource,
  values: Readonly<Record<string, unknown>>,
): boolean {
  const providedArguments = new Set(
    Object.entries(source.metadata.arguments ?? {})
      .filter(([role]) => values[role] !== undefined && values[role] !== "")
      .map(([, argument]) => argument),
  );
  return (source.command.adapterArgs ?? []).every(
    (argument) =>
      !argument.required ||
      argument.default !== undefined ||
      providedArguments.has(argument.name),
  );
}

export function projectRetrievalArguments(
  source: RetrievalSource,
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const schema = source.command.adapterArgs ?? [];
  const declared = new Set(schema.map((argument) => argument.name));
  const projected: Record<string, unknown> = {};
  for (const [role, target] of Object.entries(
    source.metadata.arguments ?? {},
  )) {
    if (!declared.has(target)) {
      throw new RetrievalFailure({
        code: "retrieval_contract_invalid",
        message: `${source.ref} retrieval role ${role} maps to undeclared argument ${target}.`,
        suggestion:
          "Fix retrieval.arguments so every target names a declared adapter argument.",
      });
    }
    if (values[role] !== undefined) projected[target] = values[role];
  }
  const resolved = resolveArgs({
    opts: projected,
    positionals: [],
    schema: schema.map((argument) => ({ ...argument, positional: false })),
    stdinIsTTY: true,
  });
  return Object.fromEntries(
    Object.entries(resolved.args).filter(([name]) => declared.has(name)),
  );
}

export function retrievalRetryCommand(
  source: RetrievalSource,
  args: Readonly<Record<string, unknown>>,
): string {
  const positionals: string[] = [];
  const options: string[] = [];
  for (const argument of source.command.adapterArgs ?? []) {
    const value = args[argument.name];
    if (value === undefined || value === "") continue;
    if (argument.positional) {
      positionals.push(shellQuote(String(value)));
      continue;
    }
    const flag = `--${argument.name.replaceAll("_", "-")}`;
    if (argument.type === "bool") {
      if (value === true) options.push(flag);
    } else {
      options.push(flag, shellQuote(String(value)));
    }
  }
  return ["unicli", source.site, source.name, ...positionals, ...options].join(
    " ",
  );
}

function boundedSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
}

async function executeRequest(
  request: RetrievalRequest,
  options: {
    allowedCapabilities: ReadonlySet<string>;
    timeoutMs: number;
    signal?: AbortSignal;
    retrievedAt: string;
  },
): Promise<RetrievalOutcome> {
  const { source } = request;
  let args: Record<string, unknown> = {};
  try {
    options.signal?.throwIfAborted();
    const uncontained = (source.command.capabilities ?? []).filter(
      (capability) => !options.allowedCapabilities.has(capability),
    );
    if (uncontained.length > 0) {
      throw new RetrievalFailure({
        code: "retrieval_capability_not_contained",
        message: `${source.ref} requires capabilities outside its orchestrator: ${uncontained.join(", ")}.`,
        suggestion:
          "Declare the exact read-only capability superset on the orchestrator or remove this source from its domain pack.",
      });
    }
    args = projectRetrievalArguments(source, request.values);
    const retryCommand = retrievalRetryCommand(source, args);
    const invocation = buildInvocation(
      "cli",
      source.site,
      source.name,
      { args, source: "internal" },
      {
        approved: true,
        signal: boundedSignal(options.signal, options.timeoutMs),
      },
    );
    if (!invocation) {
      throw new RetrievalFailure({
        code: "build_invocation_failed",
        message: `Could not build ${source.ref}.`,
        suggestion: `Inspect \`unicli describe ${source.site} ${source.name}\`.`,
        alternatives: [
          `unicli describe ${source.site} ${source.name}`,
          retryCommand,
        ],
      });
    }
    const result = await execute(invocation);
    options.signal?.throwIfAborted();
    if (result.error) {
      return {
        source,
        arguments: args,
        retrieved_at: options.retrievedAt,
        results: [],
        error: {
          ref: source.ref,
          code: result.error.code,
          message: result.error.message,
          suggestion:
            result.error.suggestion ?? `Retry or repair ${source.ref}.`,
          adapter_path: result.error.adapter_path,
          step: result.error.step,
          retryable: result.error.retryable,
          alternatives: [...(result.error.alternatives ?? []), retryCommand],
          retry_command: retryCommand,
        },
      };
    }
    return {
      source,
      arguments: args,
      retrieved_at: options.retrievedAt,
      results: result.results,
    };
  } catch (error) {
    options.signal?.throwIfAborted();
    const retryCommand = retrievalRetryCommand(source, args);
    const actionable = error as Partial<RetrievalFailure>;
    return {
      source,
      arguments: args,
      retrieved_at: options.retrievedAt,
      results: [],
      error: {
        ref: source.ref,
        code: actionable.code ?? "retrieval_source_failed",
        message: error instanceof Error ? error.message : String(error),
        suggestion: actionable.suggestion ?? `Inspect or repair ${source.ref}.`,
        retryable: false,
        alternatives: [
          ...(actionable.alternatives ?? []),
          ...(retryCommand ? [retryCommand] : []),
        ],
        retry_command: retryCommand,
      },
    };
  }
}

export async function executeRetrievalRequests(
  requests: readonly RetrievalRequest[],
  options: {
    allowedCapabilities: readonly string[];
    concurrency?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    retrievedAt?: string;
  },
): Promise<RetrievalOutcome[]> {
  const retrievedAt = options.retrievedAt ?? new Date().toISOString();
  const allowedCapabilities = new Set(options.allowedCapabilities);
  return mapConcurrent([...requests], options.concurrency ?? 6, (request) =>
    executeRequest(request, {
      allowedCapabilities,
      timeoutMs: options.timeoutMs ?? 20_000,
      signal: options.signal,
      retrievedAt,
    }),
  );
}

function stringField(
  row: Record<string, unknown>,
  fields: readonly string[],
): string {
  for (const field of fields) {
    const value = row[field];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return "";
}

function recordRows(results: readonly unknown[]): Record<string, unknown>[] {
  return results
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter(
      (value): value is Record<string, unknown> =>
        typeof value === "object" && value !== null && !Array.isArray(value),
    );
}

export function normalizeEvidenceCandidates(
  outcomes: readonly RetrievalOutcome[],
  limit: number,
): EvidenceCandidate[] {
  type CandidateGroup = { candidate: EvidenceCandidate; score: number };
  const groups = new Map<string, CandidateGroup>();
  for (const outcome of outcomes) {
    recordRows(outcome.results).forEach((raw, index) => {
      const url = canonicalizeUrl(
        stringField(raw, ["url", "html_url", "source_url", "pdf_url", "link"]),
      );
      const title = stringField(raw, [
        "title",
        "name",
        "fullName",
        "tagName",
        "id",
      ]);
      if (!url && !title) return;
      const key =
        url || `${outcome.source.metadata.result_kind}:${title.toLowerCase()}`;
      const score = 1 / (60 + index + 1);
      const candidate: EvidenceCandidate = {
        id: createHash("sha256").update(key).digest("hex").slice(0, 24),
        title: title || url,
        url,
        domain: url ? new URL(url).hostname.toLowerCase() : "",
        summary: stringField(raw, [
          "summary",
          "snippet",
          "description",
          "abstract",
          "text",
          "body",
        ]),
        result_kind: outcome.source.metadata.result_kind,
        source_class: outcome.source.metadata.source_class,
        source_adapter: outcome.source.site,
        source_command: outcome.source.name,
        source_rank: index + 1,
        source_refs: [outcome.source.ref],
        published_at: stringField(raw, [
          "published_at",
          "publishedAt",
          "published",
          "created_at",
          "createdAt",
          "date",
        ]),
        updated_at: stringField(raw, [
          "updated_at",
          "updatedAt",
          "lastModified",
        ]),
        retrieved_at: outcome.retrieved_at,
        rrf_score: 0,
        raw,
      };
      const current = groups.get(key);
      if (current) {
        current.score += score;
        const sourceRefs = [
          ...new Set([...current.candidate.source_refs, outcome.source.ref]),
        ].sort();
        if (candidate.source_rank < current.candidate.source_rank) {
          current.candidate = { ...candidate, source_refs: sourceRefs };
        } else {
          current.candidate.source_refs = sourceRefs;
        }
        return;
      }
      groups.set(key, {
        score,
        candidate,
      });
    });
  }
  return [...groups.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ candidate, score }) => ({
      ...candidate,
      rrf_score: Number(score.toFixed(8)),
    }));
}
