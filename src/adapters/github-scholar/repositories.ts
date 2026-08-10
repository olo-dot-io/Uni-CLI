/**
 * @owner       src::adapters::github-scholar::repositories
 * @does        Finds GitHub repository candidates for a paper and verifies every result against the repository README.
 * @needs       GitHub public REST search and repository README endpoints, optional GITHUB_TOKEN
 * @feeds       src/commands/scholar.ts through scholar.search and scholar.code capability tags
 * @breaks      GitHub API rate limits, search drift, unreadable READMEs, or request timeouts surface as structured errors.
 * @invariants  A result requires an exact normalized DOI in README or strong paper-title term overlap in README; repository ownership or official-code status is never inferred.
 * @side-effects HTTPS egress to api.github.com only
 * @perf        One repository search plus at most ten sequential README requests, each capped at 15 seconds
 * @concurrency safe
 * @test        tests/unit/adapters/github-scholar.test.ts
 * @stability   experimental
 * @since       2026-08-09
 */

import { cli, Strategy } from "../../registry.js";
import type { ScholarlyWorkRecord } from "../../types/scholarly.js";

const API = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_CANDIDATES = 10;
const README_CONCURRENCY = 4;
const API_VERSION = "2022-11-28";
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "based",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "of",
  "on",
  "or",
  "the",
  "to",
  "toward",
  "towards",
  "using",
  "via",
  "with",
  "without",
]);

type GitHubScholarErrorCode =
  | "invalid_input"
  | "empty_result"
  | "auth_error"
  | "rate_limited"
  | "timeout"
  | "upstream_error";

interface ActionableGitHubScholarError extends Error {
  code: GitHubScholarErrorCode;
  suggestion: string;
  retryable: boolean;
  alternatives: string[];
}

interface GitHubRepository {
  full_name?: unknown;
  html_url?: unknown;
  description?: unknown;
  stargazers_count?: unknown;
  updated_at?: unknown;
  default_branch?: unknown;
  license?: { spdx_id?: unknown } | null;
}

interface GitHubSearchResponse {
  total_count?: unknown;
  incomplete_results?: unknown;
  items?: GitHubRepository[];
}

interface GitHubReadmeResponse {
  name?: unknown;
  html_url?: unknown;
  download_url?: unknown;
  content?: unknown;
  encoding?: unknown;
  sha?: unknown;
}

export interface GitHubScholarMatch {
  match_type: "doi_exact" | "title_exact" | "title_overlap";
  confidence: number;
  doi?: string;
  title_overlap: number;
  matched_title_terms: string[];
  evidence_excerpt: string;
}

export interface GitHubScholarRecord extends ScholarlyWorkRecord {
  repository: string;
  repository_description?: string;
  repository_updated_at?: string;
  repository_license?: string;
  match_type: GitHubScholarMatch["match_type"];
  confidence: number;
  evidence: "repository-readme";
  evidence_url: string;
  evidence_excerpt: string;
  title_overlap: number;
  matched_title_terms?: string[];
  relationship_evidence: string[];
  relationship: "candidate-implementation";
  is_official_code: false;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function githubScholarError(
  code: GitHubScholarErrorCode,
  message: string,
  suggestion: string,
): ActionableGitHubScholarError {
  return Object.assign(new Error(message), {
    code,
    suggestion,
    retryable:
      code === "rate_limited" ||
      code === "timeout" ||
      code === "upstream_error",
    alternatives: [] as string[],
  });
}

export function requireGitHubScholarLimit(value: unknown): number {
  const limit = Number(value ?? 3);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw githubScholarError(
      "invalid_input",
      "github-scholar limit must be an integer in [1, 10].",
      "Choose a result limit from 1 through 10.",
    );
  }
  return limit;
}

export function canonicalDoi(value: unknown): string | undefined {
  const raw = text(value)
    .replace(/^doi:\s*/i, "")
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .trim();
  if (!/^10\.\d{4,9}\/\S+$/i.test(raw)) return undefined;
  return raw.toLowerCase().replace(/[.,;:}\]>"']+$/g, "");
}

export function extractDois(value: string): string[] {
  const matches = value.match(/10\.\d{4,9}\/[A-Z0-9._;()/:+-]+/gi) ?? [];
  return [
    ...new Set(
      matches
        .map((candidate) => canonicalDoi(candidate))
        .filter((candidate): candidate is string => candidate !== undefined),
    ),
  ];
}

export function normalizeTitle(value: unknown): string {
  return text(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function significantTitleTerms(value: unknown): string[] {
  return [
    ...new Set(
      normalizeTitle(value)
        .split(" ")
        .filter(
          (token) =>
            token.length >= 3 &&
            !STOP_WORDS.has(token) &&
            !/^\d{4}$/.test(token),
        ),
    ),
  ];
}

function evidencePosition(readme: string, terms: string[]): number {
  const lower = readme.toLowerCase();
  for (const term of terms) {
    const position = lower.indexOf(term.toLowerCase());
    if (position >= 0) return position;
  }
  return 0;
}

function evidenceExcerpt(readme: string, terms: string[]): string {
  const compact = readme.replace(/\s+/g, " ").trim();
  const center = evidencePosition(compact, terms);
  const start = Math.max(0, center - 80);
  const end = Math.min(compact.length, start + 320);
  return `${start > 0 ? "…" : ""}${compact.slice(start, end)}${end < compact.length ? "…" : ""}`;
}

export function implementationRelationshipEvidence(
  query: string,
  readme: string,
  repository: string,
  description: string,
  match: GitHubScholarMatch,
): string[] {
  const identifier = match.doi ?? query;
  const position = evidencePosition(readme, [
    identifier,
    ...match.matched_title_terms,
  ]);
  const start = Math.max(0, position - 500);
  const context = readme.slice(start, position + identifier.length + 500);
  const signals: string[] = [];
  if (
    /\b(?:implementation|implements|implemented|source code|artifact|reproducibility|reproduce|repository for|code for)\b/i.test(
      context,
    )
  ) {
    signals.push("implementation-language-near-paper-reference");
  }

  const repositoryKey = normalizeTitle(repository).replace(/ /g, "");
  const repositoryTerms = match.matched_title_terms.filter(
    (term) =>
      term.length >= 5 && repositoryKey.includes(term.replace(/ /g, "")),
  );
  if (repositoryTerms.length > 0) {
    signals.push("paper-title-term-in-repository-name");
  }

  const descriptionKey = normalizeTitle(description);
  const descriptionTerms = significantTitleTerms(query).filter((term) =>
    new RegExp(`(?:^| )${term}(?: |$)`).test(descriptionKey),
  );
  if (
    descriptionTerms.length >= 3 &&
    /\b(?:implementation|code|artifact|reproducibility|repository)\b/i.test(
      description,
    )
  ) {
    signals.push("implementation-description-with-paper-title-terms");
  }
  return signals;
}

export function evaluateReadmeEvidence(
  query: string,
  readme: string,
): GitHubScholarMatch | undefined {
  const requestedDoi = canonicalDoi(query) ?? extractDois(query)[0];
  if (requestedDoi) {
    const exact = extractDois(readme).includes(requestedDoi);
    if (!exact) return undefined;
    return {
      match_type: "doi_exact",
      confidence: 1,
      doi: requestedDoi,
      title_overlap: 0,
      matched_title_terms: [],
      evidence_excerpt: evidenceExcerpt(readme, [requestedDoi]),
    };
  }

  const normalizedQuery = normalizeTitle(query);
  if (!normalizedQuery) return undefined;
  const normalizedReadme = normalizeTitle(readme);
  const terms = significantTitleTerms(query);
  if (terms.length < 3) return undefined;
  const matched = terms.filter((term) =>
    new RegExp(`(?:^| )${term}(?: |$)`).test(normalizedReadme),
  );
  const overlap = matched.length / terms.length;
  if (normalizedReadme.includes(normalizedQuery)) {
    return {
      match_type: "title_exact",
      confidence: 0.98,
      title_overlap: 1,
      matched_title_terms: terms,
      evidence_excerpt: evidenceExcerpt(readme, [query, ...terms]),
    };
  }
  if (terms.length < 5 || matched.length < 5 || overlap < 0.9) {
    return undefined;
  }
  return {
    match_type: "title_overlap",
    confidence: Number((0.86 + overlap * 0.1).toFixed(2)),
    title_overlap: Number(overlap.toFixed(3)),
    matched_title_terms: matched,
    evidence_excerpt: evidenceExcerpt(readme, matched),
  };
}

export function buildGitHubRepositoryQuery(query: unknown): string {
  const value = text(query);
  if (!value) {
    throw githubScholarError(
      "invalid_input",
      "github-scholar paper title or DOI is required.",
      "Provide a DOI or a paper title with at least three distinctive terms.",
    );
  }
  const doi = canonicalDoi(value) ?? extractDois(value)[0];
  if (doi) return `"${doi}" in:readme`;
  const terms = significantTitleTerms(value);
  if (terms.length < 3) {
    throw githubScholarError(
      "invalid_input",
      "github-scholar paper title is too short for evidence-safe matching.",
      "Provide the complete paper title or its DOI.",
    );
  }
  return `${terms.slice(0, 10).join(" ")} in:readme`;
}

export function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent":
      "unicli-github-scholar/1.0 (https://github.com/olo-dot-io/Uni-CLI)",
    "X-GitHub-Api-Version": API_VERSION,
  };
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function requestGitHub(
  path: string,
  label: string,
  signal?: AbortSignal,
): Promise<Response> {
  signal?.throwIfAborted();
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      headers: githubHeaders(),
      signal: requestSignal,
    });
  } catch (cause) {
    if (signal?.aborted) {
      throw (
        signal.reason ??
        Object.assign(new Error(`${label} was aborted by the caller.`), {
          name: "AbortError",
        })
      );
    }
    const errorName = cause instanceof Error ? cause.name : "";
    if (timeoutSignal.aborted || errorName === "TimeoutError") {
      throw githubScholarError(
        "timeout",
        `${label} exceeded ${String(REQUEST_TIMEOUT_MS)} ms.`,
        "Retry after GitHub is reachable or reduce the requested result limit.",
      );
    }
    throw githubScholarError(
      "upstream_error",
      `${label} failed: ${cause instanceof Error ? cause.message : String(cause)}.`,
      "Retry after the GitHub REST API is reachable.",
    );
  }

  if (response.status === 401) {
    throw githubScholarError(
      "auth_error",
      `${label} returned HTTP 401.`,
      "Remove the invalid GITHUB_TOKEN or replace it with a valid token.",
    );
  }
  if (
    response.status === 429 ||
    (response.status === 403 &&
      response.headers.get("x-ratelimit-remaining") === "0")
  ) {
    throw githubScholarError(
      "rate_limited",
      `${label} reached the GitHub API rate limit.`,
      "Set GITHUB_TOKEN or retry after the GitHub rate-limit reset time.",
    );
  }
  if (response.status === 422) {
    throw githubScholarError(
      "invalid_input",
      `${label} was rejected by GitHub search validation.`,
      "Use a complete paper title or DOI without GitHub search operators.",
    );
  }
  if (!response.ok && response.status !== 404) {
    throw githubScholarError(
      "upstream_error",
      `${label} returned HTTP ${String(response.status)}.`,
      "Retry after the GitHub REST API is healthy.",
    );
  }
  return response;
}

function decodeReadme(body: GitHubReadmeResponse): string {
  if (text(body.encoding).toLowerCase() !== "base64") return "";
  const content = text(body.content).replace(/\s+/g, "");
  if (!content) return "";
  return Buffer.from(content, "base64").toString("utf8");
}

async function githubJson<T>(response: Response, label: string): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw githubScholarError(
      "upstream_error",
      `${label} returned invalid JSON.`,
      "Retry after the GitHub REST API returns a valid response.",
    );
  }
}

function repositoryName(repository: GitHubRepository): string {
  const fullName = text(repository.full_name);
  if (!/^[^/\s]+\/[^/\s]+$/.test(fullName)) return "";
  return fullName;
}

async function mapConcurrent<T>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    while (next < values.length) {
      const index = next;
      next += 1;
      await mapper(values[index]!);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () =>
      worker(),
    ),
  );
}

export async function searchGitHubScholarRepositories(
  queryValue: unknown,
  limitValue: unknown = 3,
  signal?: AbortSignal,
): Promise<GitHubScholarRecord[]> {
  const query = text(queryValue);
  const githubQuery = buildGitHubRepositoryQuery(query);
  const limit = requireGitHubScholarLimit(limitValue);
  const candidateLimit = Math.min(Math.max(limit * 2, 5), MAX_CANDIDATES);
  const params = new URLSearchParams({
    q: githubQuery,
    sort: "stars",
    order: "desc",
    per_page: String(candidateLimit),
  });
  const response = await requestGitHub(
    `/search/repositories?${params.toString()}`,
    "GitHub repository search",
    signal,
  );
  const body = await githubJson<GitHubSearchResponse>(
    response,
    "GitHub repository search",
  );
  const repositories = Array.isArray(body.items) ? body.items : [];
  if (repositories.length === 0) {
    throw githubScholarError(
      "empty_result",
      `GitHub returned no repository candidates for "${query}".`,
      "Try the paper DOI or its complete published title.",
    );
  }

  const rows: GitHubScholarRecord[] = [];
  let readableReadmes = 0;
  let firstReadError: ActionableGitHubScholarError | undefined;
  await mapConcurrent(
    repositories.slice(0, candidateLimit),
    README_CONCURRENCY,
    async (repository) => {
      const fullName = repositoryName(repository);
      if (!fullName) return;
      let readmeResponse: Response;
      try {
        const [owner, name] = fullName.split("/");
        readmeResponse = await requestGitHub(
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/readme`,
          `GitHub README ${fullName}`,
          signal,
        );
      } catch (cause) {
        const error = cause as ActionableGitHubScholarError;
        firstReadError ??= error;
        if (
          error.code === "rate_limited" ||
          error.code === "auth_error" ||
          error.code === "timeout"
        ) {
          throw error;
        }
        return;
      }
      if (readmeResponse.status === 404) return;
      const readmeBody = await githubJson<GitHubReadmeResponse>(
        readmeResponse,
        `GitHub README ${fullName}`,
      );
      const readme = decodeReadme(readmeBody);
      if (!readme) return;
      readableReadmes += 1;
      const match = evaluateReadmeEvidence(query, readme);
      if (!match) return;

      const relationshipEvidence = implementationRelationshipEvidence(
        query,
        readme,
        fullName,
        text(repository.description),
        match,
      );
      if (relationshipEvidence.length === 0) return;

      const repositoryUrl =
        text(repository.html_url) || `https://github.com/${fullName}`;
      const evidenceUrl =
        text(readmeBody.html_url) ||
        text(readmeBody.download_url) ||
        `${repositoryUrl}#readme`;
      const title = canonicalDoi(query) ? fullName : query;
      rows.push({
        id: fullName,
        title,
        doi: match.doi,
        code_url: repositoryUrl,
        project_url: repositoryUrl,
        source_adapter: "github-scholar",
        source_url: evidenceUrl,
        retrieved_at: new Date().toISOString(),
        github_stars: number(repository.stargazers_count),
        repository: fullName,
        repository_description: text(repository.description) || undefined,
        repository_updated_at: text(repository.updated_at) || undefined,
        repository_license: text(repository.license?.spdx_id) || undefined,
        match_type: match.match_type,
        verification: match.match_type,
        confidence: match.confidence,
        evidence: "repository-readme",
        evidence_url: evidenceUrl,
        evidence_excerpt: match.evidence_excerpt,
        title_overlap: match.title_overlap,
        matched_title_terms:
          match.matched_title_terms.length > 0
            ? match.matched_title_terms
            : undefined,
        relationship_evidence: relationshipEvidence,
        relationship: "candidate-implementation",
        is_official_code: false,
        search_scope: "github-repository-readme",
        search_scanned_records: Math.min(repositories.length, candidateLimit),
        search_total_records: number(body.total_count),
        search_exhaustive:
          body.incomplete_results === false &&
          Number(body.total_count ?? 0) <= candidateLimit,
        raw: {
          readme_name: text(readmeBody.name) || undefined,
          readme_sha: text(readmeBody.sha) || undefined,
          verification: match.match_type,
          confidence: match.confidence,
          evidence: "repository-readme",
          evidence_url: evidenceUrl,
          evidence_excerpt: match.evidence_excerpt,
          relationship_evidence: relationshipEvidence,
          is_official_code: false,
          relationship_claim:
            "candidate implementation; author or publisher endorsement not verified",
        },
      });
    },
  );

  if (rows.length === 0) {
    if (readableReadmes === 0 && firstReadError) throw firstReadError;
    throw githubScholarError(
      "empty_result",
      `GitHub repository candidates for "${query}" lacked verified README evidence.`,
      "Try an exact DOI or complete paper title; no unverified repository is returned.",
    );
  }
  return rows
    .sort(
      (left, right) =>
        right.confidence - left.confidence ||
        (right.github_stars ?? 0) - (left.github_stars ?? 0),
    )
    .slice(0, limit);
}

cli({
  site: "github-scholar",
  name: "search",
  description:
    "Find GitHub candidate implementations backed by exact DOI or strong paper-title evidence in repository READMEs",
  domain: "api.github.com",
  strategy: Strategy.PUBLIC,
  browser: false,
  target_surface: "web",
  operation_effect: "read",
  idempotency: "guaranteed",
  execution_operator: "structured-api",
  operation_family: "search",
  args: [
    {
      name: "query",
      type: "str",
      required: true,
      positional: true,
      description: "Complete paper title or DOI",
    },
    {
      name: "limit",
      type: "int",
      default: 3,
      minimum: 1,
      maximum: 10,
    },
  ],
  columns: [
    "repository",
    "title",
    "doi",
    "code_url",
    "match_type",
    "confidence",
    "evidence",
    "evidence_url",
    "evidence_excerpt",
    "title_overlap",
    "matched_title_terms",
    "relationship_evidence",
    "github_stars",
    "repository_license",
    "relationship",
    "is_official_code",
  ],
  capabilities: ["http.fetch", "scholar.search", "scholar.code"],
  auth_requirement: "optional",
  retrieval: {
    operation: "discover",
    result_kind: "code",
    source_class: "hosted-artifact",
    arguments: { query: "query", limit: "limit" },
  },
  func: async (_page, kwargs, context) =>
    searchGitHubScholarRepositories(kwargs.query, kwargs.limit, context.signal),
});
