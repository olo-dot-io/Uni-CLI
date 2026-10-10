/**
 * @owner       src::engine::retrieval
 * @does        Discovers read-only evidence sources, normalizes candidates, and acquires selected resources through a resumable bounded download flow.
 * @needs       adapter registry, command contracts, argument resolver, kernel execution, bounded concurrency, and EvidenceDocument URL canonicalization
 * @feeds       generic retrieval commands and domain overlays such as AI search
 * @breaks      Inferring semantics from adapter names, bypassing outer capability scopes, or dropping source-specific raw records couples every domain to one orchestrator.
 * @invariants  Only read-only commands with valid retrieval metadata execute; semantic roles map only to declared arguments; source capabilities must be contained by the caller; cancellation retains caller identity; fused representatives come from the highest-ranked source while every outcome retains source identity and an exact retry command.
 * @side-effects Executes registered read-only source commands; acquisition writes selected originals, structured documents, and one atomic result file.
 * @perf        Request fan-out uses bounded concurrency and per-source deadlines; fusion selects K from U distinct candidates in O(N + U log K) time, plus sorting the selected candidates' source refs; candidate and per-source score maps retain O(N) entries.
 * @concurrency Each request owns its arguments, timeout signal, results, and error.
 * @test        tests/unit/engine/retrieval.test.ts, tests/unit/commands/ai.test.ts
 * @stability   experimental
 * @since       2026-07-17
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";

import { buildCommandContract } from "../core/command-contract.js";
import { boundedTopK } from "../core/bounded-top-k.js";
import { commandRequiresAuth, getAllAdapters } from "../registry.js";
import { isCommandDiscoverable } from "../core/command-availability.js";
import type {
  AdapterCommand,
  AdapterManifest,
  RetrievalMetadata,
} from "../types.js";
import { resolveArgs } from "./args.js";
import {
  httpDownload,
  mapConcurrent,
  type DownloadResult,
} from "./download.js";
import { canonicalizeUrl } from "./evidence-document.js";
import { structureFetchedEvidence } from "./evidence-reader.js";
import {
  analyzeRetrievalQuery,
  scoreRetrievalCandidate,
} from "./retrieval-relevance.js";
import { writeFileTransactionally } from "./transactional-file.js";
import {
  MAX_TEXT_RESOURCE_BYTES,
  isTextualContentType,
} from "./steps/fetch-text.js";
import {
  assertRuntimeNetworkAllowed,
  assertRuntimePathAllowed,
} from "./runtime-resource-guard.js";
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

export function listRetrievalSources(
  options: { discoverableOnly?: boolean } = {},
): RetrievalSource[] {
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
        .filter(
          ([, command]) =>
            !options.discoverableOnly || isCommandDiscoverable(command),
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
  const automatic = available.filter(
    (source) =>
      source.metadata.selection !== "explicit" &&
      !commandRequiresAuth(source.adapter, source.command) &&
      isCommandDiscoverable(source.command),
  );
  const selected =
    selectors.length === 0
      ? automatic
      : selectors.flatMap((selector) => {
          if (selector === "all") return automatic;
          const exactMatches = available.filter(
            (source) => source.ref === selector || source.site === selector,
          );
          if (exactMatches.length > 0) return exactMatches;
          const matches = automatic.filter(
            (source) =>
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
    if (values[role] !== undefined) {
      const argument = schema.find((candidate) => candidate.name === target)!;
      let value = values[role];
      if (
        role === "limit" &&
        typeof value === "number" &&
        Number.isFinite(value)
      ) {
        value = Math.min(
          argument.maximum ?? Number.POSITIVE_INFINITY,
          Math.max(argument.minimum ?? Number.NEGATIVE_INFINITY, value),
        );
      }
      projected[target] = value;
    }
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
        retryable: actionable.retryable ?? false,
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
  options: { sort?: "relevance" | "latest" } = {},
): EvidenceCandidate[] {
  type CandidateGroup = {
    candidate: EvidenceCandidate;
    score: number;
    order: number;
    timestamp: number;
  };
  const groups = new Map<string, CandidateGroup>();
  const scoresBySource = new Map<string, Map<string, number>>();
  for (const outcome of outcomes) {
    let sourceScores = scoresBySource.get(outcome.source.ref);
    if (!sourceScores) {
      sourceScores = new Map();
      scoresBySource.set(outcome.source.ref, sourceScores);
    }
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
      const previousScore = sourceScores.get(key) ?? 0;
      if (score > previousScore) sourceScores.set(key, score);
      const current = groups.get(key);
      if (current) {
        if (score > previousScore) {
          current.score += score - previousScore;
        }
        if (previousScore === 0)
          current.candidate.source_refs.push(outcome.source.ref);
        if (index + 1 >= current.candidate.source_rank) return;
      }
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
        source_refs: current?.candidate.source_refs ?? [outcome.source.ref],
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
      let timestamp = Number.NEGATIVE_INFINITY;
      if (options.sort === "latest") {
        const updatedAt = Date.parse(candidate.updated_at);
        const publishedAt = Date.parse(candidate.published_at);
        timestamp = Number.isFinite(updatedAt)
          ? updatedAt
          : Number.isFinite(publishedAt)
            ? publishedAt
            : Number.NEGATIVE_INFINITY;
      }
      if (current) {
        current.candidate = candidate;
        current.timestamp = timestamp;
        return;
      }
      groups.set(key, {
        score,
        candidate,
        order: groups.size,
        timestamp,
      });
    });
  }
  return boundedTopK(
    groups.values(),
    limit,
    (left, right) =>
      (options.sort === "latest" ? right.timestamp - left.timestamp : 0) ||
      right.score - left.score ||
      left.order - right.order,
  ).map(({ candidate, score }) => ({
    ...candidate,
    source_refs: candidate.source_refs.sort(),
    rrf_score: Number(score.toFixed(8)),
  }));
}

export interface AcquiredResource extends Omit<DownloadResult, "status"> {
  id: string;
  url: string;
  source_urls: string[];
  path: string;
  status: DownloadResult["status"] | "pending" | "cancelled";
  document_path?: string;
  structure_error?: string;
  retry_command: string;
}

export interface ResourceAcquisition {
  schema_version: "resource-acquisition.v1";
  query: string;
  directory: string;
  manifest_path: string;
  candidates: readonly EvidenceCandidate[];
  resources: AcquiredResource[];
  source_errors: readonly RetrievalSourceError[];
  max_resources: number;
  selection_complete: boolean;
  linked_resources_found: number;
  linked_resources_selected: number;
}

const RESOURCE_EXTENSION =
  /\.(?:pdf|zip|tar|gz|bz2|xz|7z|csv|tsv|jsonl?|parquet|xlsx?|docx?|pptx?|epub|txt|md|png|jpe?g|webp|svg|mp3|mp4|wav)$/i;

function acquisitionUrl(value: unknown, base?: string): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim(), base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Download selected search results and one bounded layer of their resource links. */
export async function acquireEvidenceResources(
  query: string,
  candidates: readonly EvidenceCandidate[],
  options: {
    directory?: string;
    resume?: string;
    concurrency?: number;
    maxResources?: number;
    maxBytes?: number;
    timeoutMs?: number;
    refresh?: boolean;
    sourceErrors?: readonly RetrievalSourceError[];
    signal?: AbortSignal;
  } = {},
): Promise<ResourceAcquisition> {
  const concurrency = options.concurrency ?? 3;
  let maxResources = options.maxResources ?? 20;
  const maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 30_000;
  for (const [name, value, minimum, maximum] of [
    ["concurrency", concurrency, 1, 8],
    ["max_resources", maxResources, 0, 100],
    ["max_bytes", maxBytes, 1, 1024 * 1024 * 1024],
    ["timeout_ms", timeoutMs, 1, 300_000],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new RetrievalFailure({
        code: "invalid_input",
        message: `${name} must be an integer between ${minimum} and ${maximum}.`,
        suggestion: `Set --${name.replaceAll("_", "-")} within that range.`,
      });
    }
  }
  options.signal?.throwIfAborted();
  const directory = options.resume
    ? dirname(resolve(options.resume))
    : resolve(options.directory ?? "./downloads");
  const manifestPath = options.resume
    ? resolve(options.resume)
    : join(directory, "results.json");
  const context = {
    args: { query, dir: directory },
    vars: {},
    data: null,
    site: "retrieval",
    command: "acquire",
    canMutate: true,
  };
  const validatePath = (path: string) =>
    assertRuntimePathAllowed(context, {
      action: "download",
      step: -1,
      config: {},
      path,
      access: "write",
    });
  const validateRequest = (url: string) =>
    assertRuntimeNetworkAllowed(context, {
      action: "download",
      step: -1,
      config: {},
      url,
      access: "read",
    });
  validatePath(manifestPath);
  let previous: Partial<ResourceAcquisition> = {};
  try {
    const stored: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    if (stored && typeof stored === "object" && !Array.isArray(stored))
      previous = stored;
  } catch (error) {
    if (options.resume) {
      throw new RetrievalFailure({
        code: "invalid_input",
        message: `Cannot resume acquisition from ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
        suggestion:
          "Pass a readable results.json from retrieval acquire or start a new query.",
      });
    }
    if (
      (error as NodeJS.ErrnoException).code !== "ENOENT" &&
      !(error instanceof SyntaxError)
    )
      throw error;
  }
  if (options.resume) {
    if (
      previous.schema_version !== "resource-acquisition.v1" ||
      typeof previous.query !== "string" ||
      !Array.isArray(previous.candidates) ||
      !Array.isArray(previous.resources) ||
      previous.resources.length === 0 ||
      typeof previous.selection_complete !== "boolean" ||
      !Number.isSafeInteger(previous.max_resources) ||
      previous.max_resources! < 0 ||
      previous.max_resources! > 100 ||
      !previous.resources.every(
        (resource) =>
          resource &&
          acquisitionUrl(resource.url) &&
          Array.isArray(resource.source_urls) &&
          resource.source_urls.every((url) => typeof url === "string"),
      )
    ) {
      throw new RetrievalFailure({
        code: "invalid_input",
        message: `${manifestPath} does not contain a supported acquisition result.`,
        suggestion:
          "Resume from a complete resource-acquisition.v1 result or start a new query.",
      });
    }
    query = previous.query;
    candidates = previous.candidates;
    maxResources = previous.max_resources!;
  }
  await mkdir(directory, { recursive: true });
  const reusable = new Map(
    previous.schema_version === "resource-acquisition.v1" &&
      Array.isArray(previous.resources)
      ? previous.resources
          .filter((resource) => resource && typeof resource.url === "string")
          .map((resource) => [canonicalizeUrl(resource.url), resource])
      : [],
  );
  const result: ResourceAcquisition = {
    schema_version: "resource-acquisition.v1",
    query,
    directory,
    manifest_path: manifestPath,
    candidates,
    resources: [],
    source_errors: options.resume
      ? (previous.source_errors ?? [])
      : (options.sourceErrors ?? []),
    max_resources: maxResources,
    selection_complete: options.resume ? previous.selection_complete! : false,
    linked_resources_found: options.resume
      ? (previous.linked_resources_found ?? 0)
      : 0,
    linked_resources_selected: options.resume
      ? (previous.linked_resources_selected ?? 0)
      : 0,
  };
  const known = new Map<string, AcquiredResource>();
  const addResource = (url: string, sourceUrl: string): AcquiredResource => {
    const key = canonicalizeUrl(url);
    const existing = known.get(key);
    if (existing) {
      if (!existing.source_urls.includes(sourceUrl))
        existing.source_urls.push(sourceUrl);
      return existing;
    }
    const id = createHash("sha256").update(key).digest("hex").slice(0, 24);
    const extension = extname(new URL(url).pathname)
      .slice(0, 16)
      .replace(/[^.a-z0-9]/gi, "");
    const resource: AcquiredResource = {
      id,
      url,
      source_urls: [sourceUrl],
      path: join(directory, `${id}${extension || ".bin"}`),
      status: "pending",
      retry_command: `unicli retrieval acquire --resume ${shellQuote(manifestPath)} --max-bytes ${maxBytes} --timeout-ms ${timeoutMs}`,
    };
    known.set(key, resource);
    result.resources.push(resource);
    return resource;
  };
  const directUrl = acquisitionUrl(query);
  const initialResources = directUrl
    ? [{ url: directUrl, sourceUrl: directUrl }]
    : candidates.flatMap((candidate) => {
        const url =
          acquisitionUrl(candidate?.raw?.download_url, candidate?.url) ??
          acquisitionUrl(candidate?.raw?.pdf_url, candidate?.url) ??
          acquisitionUrl(candidate?.url);
        return url ? [{ url, sourceUrl: candidate.url || url }] : [];
      });
  const initialKeys = new Set(
    initialResources.map((resource) => canonicalizeUrl(resource.url)),
  );
  if (options.resume)
    for (const resource of previous.resources!) {
      const restored = addResource(
        resource.url,
        resource.source_urls[0] ?? resource.url,
      );
      for (const sourceUrl of resource.source_urls)
        if (!restored.source_urls.includes(sourceUrl))
          restored.source_urls.push(sourceUrl);
    }
  else
    for (const resource of initialResources)
      addResource(resource.url, resource.sourceUrl);
  if (result.resources.length === 0) {
    throw new RetrievalFailure({
      code: "empty_result",
      message: "No selected result has an HTTP(S) resource URL.",
      suggestion:
        "Use a direct URL or choose retrieval sources that expose resource URLs.",
    });
  }
  const linked = new Map<string, Array<{ text: string; url: string }>>();
  let checkpoint = Promise.resolve();
  const persist = () => {
    checkpoint = checkpoint.then(() =>
      writeFileTransactionally(
        manifestPath,
        Buffer.from(JSON.stringify(result, null, 2) + "\n"),
      ),
    );
    return checkpoint;
  };
  const download = async (
    resource: AcquiredResource,
    discoverLinks: boolean,
  ) => {
    try {
      options.signal?.throwIfAborted();
      validatePath(resource.path);
      validateRequest(resource.url);
      const prior = reusable.get(canonicalizeUrl(resource.url));
      let existingSize: number | undefined;
      if (
        !options.refresh &&
        prior?.path === resource.path &&
        !prior.structure_error &&
        (prior.status === "success" || prior.status === "skipped")
      ) {
        try {
          const info = await stat(resource.path);
          if (
            info.isFile() &&
            info.size === prior.size &&
            info.size <= maxBytes
          )
            existingSize = info.size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      if (existingSize !== undefined) {
        Object.assign(resource, {
          status: "skipped",
          size: existingSize,
          contentType: prior!.contentType,
          finalUrl: prior!.finalUrl,
        });
      } else {
        const outcome = await httpDownload(resource.url, resource.path, {
          signal: boundedSignal(options.signal, timeoutMs),
          maxBytes,
          validateRequest,
        });
        Object.assign(resource, outcome);
        if (outcome.status === "failed") return;
      }
      const contentType = resource.contentType ?? "";
      const textual = isTextualContentType(contentType);
      if (textual && (resource.size ?? 0) <= MAX_TEXT_RESOURCE_BYTES) {
        try {
          const document = structureFetchedEvidence({
            sourceUrl: resource.url,
            finalUrl: resource.finalUrl ?? resource.url,
            text: await readFile(resource.path, "utf8"),
            contentType,
            status: 200,
          });
          const documentPath = join(directory, `${resource.id}.document.json`);
          validatePath(documentPath);
          await writeFileTransactionally(
            documentPath,
            Buffer.from(JSON.stringify(document, null, 2) + "\n"),
            { signal: options.signal },
          );
          resource.document_path = documentPath;
          if (discoverLinks)
            linked.set(
              resource.id,
              document.links.filter(
                (link) =>
                  acquisitionUrl(link.url) !== undefined &&
                  (RESOURCE_EXTENSION.test(new URL(link.url).pathname) ||
                    /\bdownload\b|下载/i.test(link.text)),
              ),
            );
        } catch (error) {
          options.signal?.throwIfAborted();
          resource.structure_error =
            error instanceof Error ? error.message : String(error);
        }
      }
    } catch (error) {
      if (
        options.signal?.aborted &&
        (resource.status === "success" || resource.status === "skipped")
      )
        options.signal.throwIfAborted();
      resource.status = options.signal?.aborted ? "cancelled" : "failed";
      resource.code = options.signal?.aborted
        ? "cancelled"
        : error instanceof Error && error.name === "TimeoutError"
          ? "timeout"
          : typeof (error as { code?: unknown })?.code === "string"
            ? (error as { code: string }).code
            : "download_failed";
      resource.error = error instanceof Error ? error.message : String(error);
      options.signal?.throwIfAborted();
    } finally {
      await persist();
    }
  };
  try {
    await mapConcurrent([...result.resources], concurrency, (resource) =>
      download(
        resource,
        !result.selection_complete &&
          initialKeys.has(canonicalizeUrl(resource.url)),
      ),
    );
    if (result.selection_complete) return result;
    const analysis = analyzeRetrievalQuery(query);
    const links = new Map<
      string,
      { url: string; sourceUrls: string[]; score: number; order: number }
    >();
    for (const resource of result.resources) {
      const key = canonicalizeUrl(resource.url);
      if (!initialKeys.has(key))
        links.set(key, {
          url: resource.url,
          sourceUrls: resource.source_urls,
          score: 0,
          order: links.size,
        });
    }
    for (const resource of result.resources)
      for (const link of linked.get(resource.id) ?? []) {
        const key = canonicalizeUrl(link.url);
        if (initialKeys.has(key)) continue;
        const existing = links.get(key);
        if (existing) {
          if (!existing.sourceUrls.includes(resource.url))
            existing.sourceUrls.push(resource.url);
        } else
          links.set(key, {
            url: link.url,
            sourceUrls: [resource.url],
            score: scoreRetrievalCandidate(analysis, {
              title: link.text,
              url: link.url,
            }).score,
            order: links.size,
          });
      }
    result.linked_resources_found = links.size;
    const selected = boundedTopK(
      [...links.entries()]
        .filter(([key]) => !known.has(key))
        .map(([, link]) => link),
      Math.max(0, maxResources - result.linked_resources_selected),
      (left, right) => right.score - left.score || left.order - right.order,
    );
    const resources = selected.map((link) => {
      const resource = addResource(link.url, link.sourceUrls[0]);
      resource.source_urls = link.sourceUrls;
      return resource;
    });
    result.linked_resources_selected += resources.length;
    result.selection_complete =
      result.linked_resources_selected >= maxResources ||
      result.resources
        .filter((resource) => initialKeys.has(canonicalizeUrl(resource.url)))
        .every(
          (resource) =>
            (resource.status === "success" || resource.status === "skipped") &&
            !resource.structure_error,
        );
    await persist();
    await mapConcurrent(resources, concurrency, (resource) =>
      download(resource, false),
    );
    return result;
  } finally {
    for (const resource of result.resources)
      if (resource.status === "pending") {
        resource.status = "cancelled";
        resource.code = "cancelled";
        resource.error = "Acquisition stopped before this resource completed.";
      }
    await persist();
  }
}
