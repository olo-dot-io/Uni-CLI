/**
 * @owner       src::adapters::openreview::papers
 * @does        Registers OpenReview search, paper, author, venue, review, PDF-download, and PDF-text commands.
 * @needs       api2.openreview.net, optional clearance cookies, OpenReview PDFs, and pdftotext.
 * @feeds       Scholar workflows and registry-driven AI literature intelligence through scholar.* and ai.* capabilities.
 * @breaks      API drift, challenge envelopes, content normalization, or PDF failures must surface instead of hiding review state.
 * @invariants  Search results retain source URLs and review records stay attached to their forum identity.
 * @side-effects HTTPS reads; download/read write PDFs and execute pdftotext.
 * @perf        Bounded API/PDF work by command limits.
 * @concurrency safe across invocations.
 * @test        src/adapters/openreview/papers.test.ts and tests/unit/adapters/scholar-sources.test.ts
 * @stability   experimental
 * @since       2026-05-19
 */

import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { sanitizeFilename } from "../../engine/download.js";
import { cli, Strategy } from "../../registry.js";
import {
  OPENREVIEW_WEB_BASE,
  OpenReviewHttpClient,
  openReviewChallengeUrl,
  openReviewCookieHeader,
} from "./client.js";

const OPENREVIEW_BASE = OPENREVIEW_WEB_BASE;
const FORUM_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;
const PROFILE_ID_RE = /^~(?=.*\p{L})[\p{L}\p{M}0-9._-]+\d+$/u;
const execFileAsync = promisify(execFile);
const REVIEW_SECTION_FIELDS = [
  ["summary", "Summary"],
  ["strengths", "Strengths"],
  ["weaknesses", "Weaknesses"],
  ["questions", "Questions"],
  ["comment", "Comment"],
  ["rebuttal", "Rebuttal"],
  ["decision", "Decision"],
  ["recommendation", "Recommendation"],
  ["title", "Title"],
  ["abstract", "Abstract"],
  ["withdrawal_confirmation", "Withdrawal confirmation"],
] as const;

interface OpenReviewContentValue {
  value?: unknown;
}

type OpenReviewContent = Record<string, OpenReviewContentValue | undefined>;

interface OpenReviewNote {
  id?: unknown;
  forum?: unknown;
  cdate?: unknown;
  pdate?: unknown;
  invitations?: unknown;
  signatures?: unknown;
  content?: OpenReviewContent;
}

interface NotesEnvelope {
  notes?: OpenReviewNote[];
  error?: unknown;
  errors?: unknown;
}

interface GroupsEnvelope {
  groups?: OpenReviewNote[];
}

interface OpenReviewAdapterError extends Error {
  code: "invalid_input" | "empty_result" | "upstream_error";
  suggestion: string;
  retryable?: boolean;
}

function openReviewError(
  code: OpenReviewAdapterError["code"],
  message: string,
  suggestion: string,
  retryable = false,
): OpenReviewAdapterError {
  return Object.assign(new Error(message), {
    code,
    suggestion,
    ...(retryable ? { retryable } : {}),
  });
}

function openReviewInvalidInput(message: string): OpenReviewAdapterError {
  return openReviewError(
    "invalid_input",
    message,
    "Use the declared argument format and bounds for this OpenReview command.",
  );
}

function openReviewEmptyResult(message: string): OpenReviewAdapterError {
  return openReviewError(
    "empty_result",
    message,
    "Verify the forum, profile, or venue identifier, or broaden the search query.",
  );
}

export function requireOpenReviewSearchMatches<T>(
  rows: T[],
  query: string,
  label = "papers",
): T[] {
  if (rows.length === 0) {
    throw openReviewEmptyResult(`No OpenReview ${label} found for "${query}".`);
  }
  return rows;
}

function openReviewUpstreamError(message: string): OpenReviewAdapterError {
  return openReviewError(
    "upstream_error",
    message,
    "Retry after OpenReview is reachable and returns a complete response.",
    true,
  );
}

const openReviewApi = new OpenReviewHttpClient({ apiVersion: 2 });

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function coerceOpenReviewInt(value: unknown): number {
  if (value === undefined || value === null || value === "") return Number.NaN;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && Number.isInteger(n) ? n : Number.NaN;
}

export function requireOpenReviewLimit(
  value: unknown,
  fallback: number,
  max: number,
): number {
  const n =
    value === undefined || value === null || value === ""
      ? fallback
      : coerceOpenReviewInt(value);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw openReviewInvalidInput(
      `openreview limit must be an integer in [1, ${max}].`,
    );
  }
  return n;
}

export function requireOpenReviewOffset(value: unknown, fallback = 0): number {
  const n =
    value === undefined || value === null || value === ""
      ? fallback
      : coerceOpenReviewInt(value);
  if (!Number.isInteger(n) || n < 0) {
    throw openReviewInvalidInput(
      "openreview offset must be a non-negative integer.",
    );
  }
  return n;
}

export function requireForumId(value: unknown, label = "id"): string {
  const raw = String(value ?? "").trim();
  const id =
    raw.match(/^https?:\/\/openreview\.net\/forum\?id=([^&#]+)/i)?.[1] ?? raw;
  if (!id) throw openReviewInvalidInput(`openreview ${label} is required.`);
  if (!FORUM_ID_RE.test(id)) {
    throw openReviewInvalidInput(
      `openreview ${label} "${String(value)}" is not a valid forum id.`,
    );
  }
  return id;
}

export function requireOpenReviewPageRange(
  firstPage: unknown,
  lastPage: unknown,
): { firstPage: number; lastPage: number } {
  const first = coerceOpenReviewInt(firstPage ?? 1);
  const last = coerceOpenReviewInt(lastPage ?? 20);
  if (!Number.isInteger(first) || first < 1) {
    throw openReviewInvalidInput(
      "openreview first-page must be an integer >= 1.",
    );
  }
  if (!Number.isInteger(last) || last < first) {
    throw openReviewInvalidInput(
      "openreview last-page must be an integer >= first-page.",
    );
  }
  return { firstPage: first, lastPage: last };
}

export function requireOpenReviewMaxChars(
  value: unknown,
  fallback = 40_000,
): number {
  const raw =
    value === undefined || value === null || value === "" ? fallback : value;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 1_000 || n > 1_000_000) {
    throw openReviewInvalidInput(
      `openreview max-chars must be an integer in [1000, 1000000]. Got: ${String(value)}`,
    );
  }
  return n;
}

export function openReviewPdfFilename(id: string, title: unknown): string {
  const slug = stringField(title)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return sanitizeFilename(`${id}${slug ? `-${slug}` : ""}.pdf`);
}

export function requireProfileId(value: unknown): string {
  const id = String(value ?? "").trim();
  if (!id) throw openReviewInvalidInput("openreview profile is required.");
  if (!PROFILE_ID_RE.test(id)) {
    throw openReviewInvalidInput(
      `openreview profile "${String(value)}" is not valid.`,
    );
  }
  return id;
}

export function readContent(
  content: OpenReviewContent | undefined,
  key: string,
): unknown {
  return content?.[key]?.value;
}

export function formatOpenReviewDate(value: unknown): string {
  const n = numberField(value);
  return n && n > 0 ? new Date(n).toISOString().slice(0, 10) : "";
}

export function absoluteOpenReviewPdf(value: unknown): string {
  const pdf = stringField(value);
  if (!pdf) return "";
  if (/^https?:\/\//i.test(pdf)) return pdf;
  return pdf.startsWith("/")
    ? `${OPENREVIEW_BASE}${pdf}`
    : `${OPENREVIEW_BASE}/${pdf}`;
}

function authorIdToName(value: unknown): string {
  return String(value ?? "")
    .replace(/^~/, "")
    .replace(/\d+$/, "")
    .replace(/_/g, " ")
    .trim();
}

export function mapOpenReviewNoteRow(
  note: OpenReviewNote,
): Record<string, unknown> {
  const content = note.content ?? {};
  const id = stringField(note.id);
  const authors = readContent(content, "authors");
  const authorIds = readContent(content, "authorids");
  const authorList =
    Array.isArray(authors) && authors.length > 0
      ? authors.map(stringField).filter(Boolean).join(", ")
      : Array.isArray(authorIds)
        ? authorIds.map(authorIdToName).filter(Boolean).join(", ")
        : "";
  const keywords = readContent(content, "keywords");
  const keywordList = Array.isArray(keywords)
    ? keywords.map(stringField).filter(Boolean).join(", ")
    : stringField(keywords);
  const pdate = formatOpenReviewDate(note.pdate ?? note.cdate);
  const pdfUrl = absoluteOpenReviewPdf(readContent(content, "pdf"));
  const sourceUrl = id ? `${OPENREVIEW_BASE}/forum?id=${id}` : "";
  return {
    id,
    openreview_id: id,
    title: stringField(readContent(content, "title")).replace(/\s+/g, " "),
    authors: authorList,
    keywords: keywordList,
    venue: stringField(readContent(content, "venue")),
    venueid: stringField(readContent(content, "venueid")),
    primary_area: stringField(readContent(content, "primary_area")),
    abstract: stringField(readContent(content, "abstract")).replace(
      /\s+/g,
      " ",
    ),
    pdate,
    date: pdate,
    pdf: pdfUrl,
    pdf_url: pdfUrl,
    url: sourceUrl,
    source_url: sourceUrl,
    landing_url: sourceUrl,
    source_adapter: "openreview",
    retrieved_at: new Date().toISOString(),
  };
}

function invitationTail(note: OpenReviewNote): string {
  const invitations = Array.isArray(note.invitations) ? note.invitations : [];
  for (const invitation of invitations) {
    const match = String(invitation).match(/\/-\/([^/]+)$/);
    if (match) return match[1];
  }
  return "";
}

function lastInvitation(note: OpenReviewNote): string {
  const invitations = Array.isArray(note.invitations) ? note.invitations : [];
  return invitations.length > 0 ? String(invitations.at(-1)) : "";
}

export function classifyReviewNote(
  note: OpenReviewNote,
  isRoot: boolean,
): string {
  if (isRoot) return "PAPER";
  const tail = invitationTail(note).toLowerCase();
  if (tail.includes("decision")) return "DECISION";
  if (tail.includes("withdrawal")) return "WITHDRAWAL";
  if (tail.includes("rebuttal")) return "REBUTTAL";
  if (tail.includes("meta")) return "META_REVIEW";
  if (tail.includes("review")) return "REVIEW";
  if (tail.includes("comment")) {
    return authorFromSignatures(note.signatures) === "Authors"
      ? "AUTHOR_RESPONSE"
      : "COMMENT";
  }
  return tail ? tail.toUpperCase() : "NOTE";
}

export function authorFromSignatures(signatures: unknown): string {
  if (!Array.isArray(signatures) || signatures.length === 0) return "";
  const signature = String(signatures[0]);
  if (signature.startsWith("~")) return authorIdToName(signature);
  const parts = signature.split("/");
  return parts.at(-1) ?? signature;
}

function joinReviewSections(content: OpenReviewContent | undefined): string {
  const parts: string[] = [];
  for (const [key, label] of REVIEW_SECTION_FIELDS) {
    const value = readContent(content, key);
    if (value === undefined || value === null) continue;
    const text = Array.isArray(value) ? value.join(", ") : String(value);
    const trimmed = text.replace(/\r\n/g, "\n").trim();
    if (trimmed) parts.push(`${label}: ${trimmed}`);
  }
  return parts.join("\n\n");
}

function truncateText(
  text: string,
  maxLength: number,
): { text: string; truncated: boolean; originalChars: number } {
  const originalChars = text.length;
  if (originalChars <= maxLength) {
    return { text, truncated: false, originalChars };
  }
  return {
    text: `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`,
    truncated: true,
    originalChars,
  };
}

function openReviewNoteUrl(forum: string, noteId: string): string {
  const forumUrl = `${OPENREVIEW_BASE}/forum?id=${forum}`;
  return noteId && noteId !== forum ? `${forumUrl}&noteId=${noteId}` : forumUrl;
}

export function openReviewClearanceCookieHeader(
  cookies: Record<string, string> | null,
): string | undefined {
  return openReviewCookieHeader(cookies);
}

export { openReviewChallengeUrl };

export function mapReviewThreadRows(
  root: OpenReviewNote,
  replies: OpenReviewNote[],
  forum: string,
  maxLength: number,
): Array<Record<string, unknown>> {
  const sorted = [...replies]
    .filter((note) => note.id !== forum)
    .sort((a, b) => (numberField(a.cdate) ?? 0) - (numberField(b.cdate) ?? 0));
  return [root, ...sorted].map((note) => {
    const isRoot = note.id === forum;
    const noteId = stringField(note.id);
    const rating = readContent(note.content, "rating");
    const confidence = readContent(note.content, "confidence");
    const text = truncateText(joinReviewSections(note.content), maxLength);
    return {
      forum,
      note_id: noteId,
      type: classifyReviewNote(note, isRoot),
      author: authorFromSignatures(note.signatures),
      invitation: lastInvitation(note),
      created_at: formatOpenReviewDate(note.pdate ?? note.cdate),
      source_url: openReviewNoteUrl(forum, noteId),
      rating: rating === undefined || rating === null ? "" : String(rating),
      confidence:
        confidence === undefined || confidence === null
          ? ""
          : String(confidence),
      text: text.text,
      text_chars: text.originalChars,
      text_truncated: text.truncated,
    };
  });
}

async function fetchOpenReview(
  path: string,
  label: string,
  signal?: AbortSignal,
): Promise<NotesEnvelope> {
  const json =
    (await openReviewApi.json<NotesEnvelope>(path, label, signal)) ?? {};
  const errors = Array.isArray(json.errors) ? json.errors : [];
  const error = stringField(json.error);
  if (errors.length > 0 || error) {
    const detail =
      error ||
      errors
        .map((entry) =>
          typeof entry === "string"
            ? entry
            : JSON.stringify(entry).slice(0, 200),
        )
        .join("; ");
    throw openReviewUpstreamError(
      `OpenReview API error for ${label}: ${detail}.`,
    );
  }
  return json;
}

function notesFromEnvelope(json: NotesEnvelope): OpenReviewNote[] {
  return Array.isArray(json.notes) ? json.notes : [];
}

function openReviewTabId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function resolveOpenReviewVenueQuery(
  value: string,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  const raw = value.trim();
  let groupId = "";
  let tabId = "";
  try {
    const url = new URL(raw);
    if (url.hostname === "openreview.net" && url.pathname === "/group") {
      groupId = url.searchParams.get("id") ?? "";
      tabId = url.hash.replace(/^#tab-/, "");
    }
  } catch {
    if (!raw.includes("/-/") && raw.endsWith("/Conference")) groupId = raw;
  }

  if (!groupId) {
    return { [raw.includes("/-/") ? "invitation" : "content.venue"]: raw };
  }
  const groupEnvelope = await openReviewApi.json<GroupsEnvelope>(
    `/groups?id=${encodeURIComponent(groupId)}`,
    `openreview venue group ${groupId}`,
    signal,
  );
  const group = groupEnvelope?.groups?.[0];
  if (!group)
    throw openReviewEmptyResult(
      `No OpenReview venue group found for "${groupId}".`,
    );
  const submissionId = stringField(readContent(group.content, "submission_id"));
  const decisionHeadingMap = readContent(group.content, "decision_heading_map");
  if (
    tabId &&
    decisionHeadingMap &&
    typeof decisionHeadingMap === "object" &&
    !Array.isArray(decisionHeadingMap)
  ) {
    const match = Object.entries(decisionHeadingMap).find(
      ([, heading]) => openReviewTabId(String(heading)) === tabId,
    );
    if (match) {
      return {
        ...(submissionId ? { invitation: submissionId } : {}),
        "content.venue": match[0],
      };
    }
  }
  return submissionId
    ? { invitation: submissionId }
    : { "content.venueid": groupId };
}

async function fetchOpenReviewPaperRow(
  id: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const notes = notesFromEnvelope(
    await fetchOpenReview(
      `/notes?id=${encodeURIComponent(id)}`,
      `openreview paper ${id}`,
      signal,
    ),
  );
  if (notes.length === 0)
    throw openReviewEmptyResult(`No OpenReview paper found with id "${id}".`);
  return mapOpenReviewNoteRow(notes[0]);
}

function hasPaperContent(note: OpenReviewNote): boolean {
  const content = note.content ?? {};
  return (
    stringField(readContent(content, "title")).length > 0 ||
    stringField(readContent(content, "abstract")).length > 0 ||
    stringField(readContent(content, "pdf")).length > 0
  );
}

async function paperRowsFromSearchNotes(
  notes: OpenReviewNote[],
  limit: number,
  signal?: AbortSignal,
): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  let firstHydrationError: Error | undefined;

  for (const note of notes) {
    const rawId = hasPaperContent(note) ? note.id : note.forum;
    const idText = stringField(rawId);
    if (!idText || seen.has(idText) || !FORUM_ID_RE.test(idText)) continue;
    seen.add(idText);
    try {
      const row = hasPaperContent(note)
        ? mapOpenReviewNoteRow(note)
        : await fetchOpenReviewPaperRow(idText, signal);
      if (stringField(row.title) || stringField(row.pdf_url)) rows.push(row);
    } catch (error) {
      if (!firstHydrationError) {
        firstHydrationError =
          error instanceof Error ? error : new Error(String(error));
      }
    }
    if (rows.length >= limit) break;
  }

  if (rows.length === 0 && firstHydrationError) throw firstHydrationError;
  return rows;
}

async function downloadOpenReviewPdf(
  row: Record<string, unknown>,
  output: unknown,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const id = requireForumId(row.id);
  const pdfUrl = stringField(row.pdf_url);
  if (!pdfUrl) {
    throw openReviewEmptyResult(
      `OpenReview paper "${id}" does not expose a PDF URL.`,
    );
  }
  const outputDir = resolve(String(output ?? "./openreview-downloads"));
  const path = join(outputDir, openReviewPdfFilename(id, row.title));
  const download = await openReviewApi.download(
    `/attachment?id=${encodeURIComponent(id)}&name=pdf`,
    path,
    `openreview PDF ${id}`,
    signal,
  );
  if (!download)
    throw openReviewEmptyResult(
      `OpenReview PDF download returned 404 for ${id}.`,
    );
  return {
    ...row,
    path: download.path,
    _download: download,
  };
}

cli({
  site: "openreview",
  name: "search",
  description: "Search OpenReview papers by free-text query",
  domain: "openreview.net",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "query",
      type: "str",
      required: true,
      positional: true,
      description: "Search keyword",
    },
    { name: "limit", type: "int", default: 25, description: "Max results" },
  ],
  columns: [
    "rank",
    "id",
    "title",
    "authors",
    "venue",
    "pdate",
    "pdf_url",
    "source_url",
  ],
  operation_effect: "read",
  execution_operator: "structured-api",
  retrieval: {
    operation: "discover",
    result_kind: "paper",
    source_class: "hosted-artifact",
    arguments: { query: "query", limit: "limit" },
  },
  capabilities: ["http.fetch", "scholar.search", "scholar.review"],
  func: async (_page, kwargs, context) => {
    const query = String(kwargs.query ?? "").trim();
    if (!query)
      throw openReviewInvalidInput("openreview search query cannot be empty.");
    const limit = requireOpenReviewLimit(kwargs.limit, 25, 50);
    const searchLimit = Math.min(limit * 5, 50);
    const params = new URLSearchParams({
      term: query,
      type: "terms",
      limit: String(searchLimit),
    });
    const notes = notesFromEnvelope(
      await fetchOpenReview(
        `/notes/search?${params.toString()}`,
        "openreview search",
        context.signal,
      ),
    );
    requireOpenReviewSearchMatches(notes, query);
    const paperRows = requireOpenReviewSearchMatches(
      await paperRowsFromSearchNotes(notes, limit, context.signal),
      query,
      "paper notes",
    );
    return paperRows.map((row, index) => {
      return {
        rank: index + 1,
        id: row.id,
        title: row.title,
        authors: row.authors,
        venue: row.venue,
        pdate: row.pdate,
        pdf_url: row.pdf_url,
        source_url: row.source_url,
        source_adapter: row.source_adapter,
        openreview_id: row.openreview_id,
      };
    });
  },
});

cli({
  site: "openreview",
  name: "paper",
  description: "Show full metadata for a single OpenReview paper",
  domain: "openreview.net",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "id",
      type: "str",
      required: true,
      positional: true,
      description: "OpenReview note id",
    },
  ],
  columns: [
    "id",
    "title",
    "authors",
    "keywords",
    "venue",
    "venueid",
    "primary_area",
    "abstract",
    "pdate",
    "pdf",
    "pdf_url",
    "url",
    "source_url",
  ],
  capabilities: ["http.fetch", "scholar.get", "scholar.pdf", "scholar.review"],
  func: async (_page, kwargs, context) => {
    const id = requireForumId(kwargs.id);
    const row = await fetchOpenReviewPaperRow(id, context.signal);
    return [
      {
        id: row.id,
        openreview_id: row.openreview_id,
        title: row.title,
        authors: row.authors,
        keywords: row.keywords,
        venue: row.venue,
        venueid: row.venueid,
        primary_area: row.primary_area,
        abstract: row.abstract,
        pdate: row.pdate,
        date: row.date,
        pdf: row.pdf,
        pdf_url: row.pdf_url,
        url: row.url,
        source_url: row.source_url,
        source_adapter: row.source_adapter,
        retrieved_at: row.retrieved_at,
      },
    ];
  },
});

cli({
  site: "openreview",
  name: "download",
  description: "Download an OpenReview paper PDF by forum id",
  domain: "openreview.net",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "id",
      type: "str",
      required: true,
      positional: true,
      description: "OpenReview forum id or forum URL",
      "x-unicli-kind": "id",
      "x-unicli-accepts": ["url"],
    },
    {
      name: "output",
      type: "str",
      default: "./openreview-downloads",
      description: "Output directory",
      "x-unicli-kind": "path",
    },
  ],
  columns: ["id", "title", "pdf_url", "path", "_download"],
  capabilities: ["http.fetch", "http.download", "scholar.pdf"],
  minimum_capability: "http.download",
  func: async (_page, kwargs, context) => {
    const id = requireForumId(kwargs.id);
    const downloaded = await downloadOpenReviewPdf(
      await fetchOpenReviewPaperRow(id, context.signal),
      kwargs.output,
      context.signal,
    );
    return [
      {
        id: downloaded.id,
        title: downloaded.title,
        pdf_url: downloaded.pdf_url,
        path: downloaded.path,
        _download: downloaded._download,
        source_adapter: downloaded.source_adapter,
        source_url: downloaded.source_url,
        openreview_id: downloaded.openreview_id,
      },
    ];
  },
});

cli({
  site: "openreview",
  name: "read",
  description: "Download and extract text from an OpenReview paper PDF",
  domain: "openreview.net",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "id",
      type: "str",
      required: true,
      positional: true,
      description: "OpenReview forum id or forum URL",
      "x-unicli-kind": "id",
      "x-unicli-accepts": ["url"],
    },
    {
      name: "output",
      type: "str",
      default: "./openreview-downloads",
      description: "Output directory for the PDF used for extraction",
      "x-unicli-kind": "path",
    },
    {
      name: "first-page",
      type: "int",
      default: 1,
      description: "First page to extract",
    },
    {
      name: "last-page",
      type: "int",
      default: 20,
      description: "Last page to extract",
    },
    {
      name: "max-chars",
      type: "int",
      default: 40000,
      description: "Maximum extracted text characters",
    },
  ],
  columns: [
    "id",
    "title",
    "pdf_url",
    "path",
    "text",
    "text_chars",
    "text_truncated",
  ],
  operation_family: "download",
  operation_effect: "download_file",
  capabilities: [
    "http.fetch",
    "http.download",
    "subprocess.exec",
    "scholar.pdf",
    "scholar.fulltext",
  ],
  minimum_capability: "subprocess.exec",
  func: async (_page, kwargs, context) => {
    const id = requireForumId(kwargs.id);
    const { firstPage, lastPage } = requireOpenReviewPageRange(
      kwargs["first-page"] ?? kwargs.firstPage,
      kwargs["last-page"] ?? kwargs.lastPage,
    );
    const maxChars = requireOpenReviewMaxChars(
      kwargs["max-chars"] ?? kwargs.maxChars,
    );
    const downloaded = await downloadOpenReviewPdf(
      await fetchOpenReviewPaperRow(id, context.signal),
      kwargs.output,
      context.signal,
    );
    const path = stringField(downloaded.path);
    if (!path)
      throw openReviewUpstreamError(
        "OpenReview PDF download produced no path.",
      );
    const { stdout } = await execFileAsync(
      "pdftotext",
      [
        "-layout",
        "-enc",
        "UTF-8",
        "-f",
        String(firstPage),
        "-l",
        String(lastPage),
        path,
        "-",
      ],
      {
        timeout: 60000,
        maxBuffer: 10 * 1024 * 1024,
        signal: context.signal,
      },
    );
    const text = stdout.trim();
    if (!text) {
      throw openReviewEmptyResult(
        `pdftotext returned no text for OpenReview paper ${id} pages ${firstPage}-${lastPage}.`,
      );
    }
    const truncated = truncateText(text, maxChars);
    return [
      {
        id: downloaded.id,
        title: downloaded.title,
        pdf_url: downloaded.pdf_url,
        path,
        text: truncated.text,
        text_chars: truncated.originalChars,
        text_truncated: truncated.truncated,
        source_adapter: downloaded.source_adapter,
        source_url: downloaded.source_url,
        openreview_id: downloaded.openreview_id,
      },
    ];
  },
});

cli({
  site: "openreview",
  name: "author",
  description: "List OpenReview submissions by author profile id",
  domain: "openreview.net",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "profile",
      type: "str",
      required: true,
      positional: true,
      description: "OpenReview profile id",
    },
    { name: "limit", type: "int", default: 50, description: "Max submissions" },
  ],
  columns: [
    "rank",
    "id",
    "title",
    "authors",
    "venue",
    "pdate",
    "pdf_url",
    "source_url",
  ],
  capabilities: ["http.fetch", "scholar.author", "scholar.search"],
  func: async (_page, kwargs, context) => {
    const profile = requireProfileId(kwargs.profile);
    const limit = requireOpenReviewLimit(kwargs.limit, 50, 1000);
    const params = new URLSearchParams({
      "content.authorids": profile,
      limit: String(limit),
      sort: "cdate:desc",
    });
    const notes = notesFromEnvelope(
      await fetchOpenReview(
        `/notes?${params.toString()}`,
        `openreview author ${profile}`,
        context.signal,
      ),
    );
    if (notes.length === 0)
      throw openReviewEmptyResult(
        `No OpenReview submissions found for "${profile}".`,
      );
    return notes.slice(0, limit).map((note, index) => {
      const row = mapOpenReviewNoteRow(note);
      return {
        rank: index + 1,
        id: row.id,
        title: row.title,
        authors: row.authors,
        venue: row.venue,
        pdate: row.pdate,
        pdf_url: row.pdf_url,
        source_url: row.source_url,
        source_adapter: row.source_adapter,
        openreview_id: row.openreview_id,
      };
    });
  },
});

cli({
  site: "openreview",
  name: "venue",
  description: "List papers at an OpenReview venue or invitation",
  domain: "openreview.net",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "venue",
      type: "str",
      required: true,
      positional: true,
      description: "Venue text or invitation id",
    },
    { name: "limit", type: "int", default: 25, description: "Max results" },
    {
      name: "offset",
      type: "int",
      default: 0,
      description: "Pagination offset",
    },
  ],
  columns: [
    "rank",
    "id",
    "title",
    "authors",
    "keywords",
    "venue",
    "venueid",
    "primary_area",
    "pdate",
    "pdf",
    "pdf_url",
    "url",
    "source_url",
  ],
  capabilities: ["http.fetch", "scholar.venue", "scholar.search"],
  func: async (_page, kwargs, context) => {
    const venue = String(kwargs.venue ?? "").trim();
    if (!venue)
      throw openReviewInvalidInput("openreview venue cannot be empty.");
    const limit = requireOpenReviewLimit(kwargs.limit, 25, 200);
    const offset = requireOpenReviewOffset(kwargs.offset);
    const params = new URLSearchParams({
      ...(await resolveOpenReviewVenueQuery(venue, context.signal)),
      limit: String(limit),
      offset: String(offset),
    });
    const notes = notesFromEnvelope(
      await fetchOpenReview(
        `/notes?${params.toString()}`,
        `openreview venue ${venue}`,
        context.signal,
      ),
    );
    if (notes.length === 0)
      throw openReviewEmptyResult(
        `No OpenReview papers found at venue "${venue}".`,
      );
    return notes.slice(0, limit).map((note, index) => {
      const row = mapOpenReviewNoteRow(note);
      return {
        rank: offset + index + 1,
        id: row.id,
        title: row.title,
        authors: row.authors,
        keywords: row.keywords,
        venue: row.venue,
        venueid: row.venueid,
        primary_area: row.primary_area,
        pdate: row.pdate,
        pdf: row.pdf,
        pdf_url: row.pdf_url,
        url: row.url,
        source_url: row.source_url,
        source_adapter: row.source_adapter,
        openreview_id: row.openreview_id,
      };
    });
  },
});

cli({
  site: "openreview",
  name: "reviews",
  description:
    "Show paper, reviews, decisions, and comments for an OpenReview forum",
  domain: "openreview.net",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "forum",
      type: "str",
      required: true,
      positional: true,
      description: "OpenReview forum id or forum URL",
      "x-unicli-kind": "id",
      "x-unicli-accepts": ["url"],
    },
    {
      name: "max-length",
      type: "int",
      default: 4000,
      description: "Per-row text truncation length",
    },
  ],
  columns: [
    "forum",
    "note_id",
    "type",
    "author",
    "invitation",
    "created_at",
    "source_url",
    "rating",
    "confidence",
    "text",
    "text_chars",
    "text_truncated",
  ],
  capabilities: ["http.fetch", "scholar.review"],
  func: async (_page, kwargs, context) => {
    const forum = requireForumId(kwargs.forum, "forum");
    const maxLength = coerceOpenReviewInt(
      kwargs["max-length"] ?? kwargs.maxLength ?? 4000,
    );
    if (!Number.isInteger(maxLength) || maxLength < 200) {
      throw openReviewInvalidInput(
        "openreview reviews max-length must be an integer >= 200.",
      );
    }
    const rootNotes = notesFromEnvelope(
      await fetchOpenReview(
        `/notes?id=${encodeURIComponent(forum)}`,
        `openreview paper ${forum}`,
        context.signal,
      ),
    );
    const root = rootNotes[0];
    if (!root)
      throw openReviewEmptyResult(
        `No OpenReview forum found with id "${forum}".`,
      );
    const replies = notesFromEnvelope(
      await fetchOpenReview(
        `/notes?forum=${encodeURIComponent(forum)}&details=replies&limit=1000`,
        `openreview reviews ${forum}`,
        context.signal,
      ),
    );
    return mapReviewThreadRows(root, replies, forum, maxLength);
  },
});
