/**
 * @owner   src/adapters/openreview/papers.ts
 * @does    Register agent-facing OpenReview search, paper, author, venue, and reviews commands.
 * @needs   Public api2.openreview.net notes API, forum/profile id validation, note content normalization.
 * @feeds   surface coverage ledger, scholarly review workflow, agent-readable paper/review rows.
 * @breaks  OpenReview API envelope drift, content.value parsing, or silent empty threads hide paper review state.
 */

import { cli, Strategy } from "../../registry.js";

const OPENREVIEW_API = "https://api2.openreview.net";
const OPENREVIEW_BASE = "https://openreview.net";
const FORUM_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;
const PROFILE_ID_RE = /^~(?=.*\p{L})[\p{L}\p{M}0-9._-]+\d+$/u;
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
    throw new Error(`openreview limit must be an integer in [1, ${max}].`);
  }
  return n;
}

export function requireOpenReviewOffset(value: unknown, fallback = 0): number {
  const n =
    value === undefined || value === null || value === ""
      ? fallback
      : coerceOpenReviewInt(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error("openreview offset must be a non-negative integer.");
  }
  return n;
}

export function requireForumId(value: unknown, label = "id"): string {
  const id = String(value ?? "").trim();
  if (!id) throw new Error(`openreview ${label} is required.`);
  if (!FORUM_ID_RE.test(id)) {
    throw new Error(
      `openreview ${label} "${String(value)}" is not a valid forum id.`,
    );
  }
  return id;
}

export function requireProfileId(value: unknown): string {
  const id = String(value ?? "").trim();
  if (!id) throw new Error("openreview profile is required.");
  if (!PROFILE_ID_RE.test(id)) {
    throw new Error(`openreview profile "${String(value)}" is not valid.`);
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
  return {
    id,
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
    pdate: formatOpenReviewDate(note.pdate ?? note.cdate),
    pdf: absoluteOpenReviewPdf(readContent(content, "pdf")),
    url: id ? `${OPENREVIEW_BASE}/forum?id=${id}` : "",
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
  if (tail.includes("comment")) return "COMMENT";
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

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

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
    const rating = readContent(note.content, "rating");
    const confidence = readContent(note.content, "confidence");
    return {
      type: classifyReviewNote(note, isRoot),
      author: authorFromSignatures(note.signatures),
      rating: rating === undefined || rating === null ? "" : String(rating),
      confidence:
        confidence === undefined || confidence === null
          ? ""
          : String(confidence),
      text: truncate(joinReviewSections(note.content), maxLength),
    };
  });
}

async function fetchOpenReview(
  path: string,
  label: string,
): Promise<NotesEnvelope> {
  const response = await fetch(`${OPENREVIEW_API}${path}`, {
    headers: {
      "User-Agent":
        "unicli-openreview/1.0 (https://github.com/olo-dot-io/Uni-CLI)",
      Accept: "application/json",
    },
  });
  if (response.status === 404) return {};
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `OpenReview API HTTP ${response.status} for ${label}${body ? ` (${body.slice(0, 200)})` : ""}.`,
    );
  }
  const json = (await response.json()) as NotesEnvelope;
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
    throw new Error(`OpenReview API error for ${label}: ${detail}.`);
  }
  return json;
}

function notesFromEnvelope(json: NotesEnvelope): OpenReviewNote[] {
  return Array.isArray(json.notes) ? json.notes : [];
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
  columns: ["rank", "id", "title", "authors", "venue", "pdate", "url"],
  func: async (_page, kwargs) => {
    const query = String(kwargs.query ?? "").trim();
    if (!query) throw new Error("openreview search query cannot be empty.");
    const limit = requireOpenReviewLimit(kwargs.limit, 25, 50);
    const params = new URLSearchParams({
      term: query,
      type: "terms",
      limit: String(limit),
    });
    const notes = notesFromEnvelope(
      await fetchOpenReview(
        `/notes/search?${params.toString()}`,
        "openreview search",
      ),
    );
    if (notes.length === 0)
      throw new Error(`No OpenReview papers found for "${query}".`);
    return notes.slice(0, limit).map((note, index) => {
      const row = mapOpenReviewNoteRow(note);
      return {
        rank: index + 1,
        id: row.id,
        title: row.title,
        authors: row.authors,
        venue: row.venue,
        pdate: row.pdate,
        url: row.url,
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
    "url",
  ],
  func: async (_page, kwargs) => {
    const id = requireForumId(kwargs.id);
    const notes = notesFromEnvelope(
      await fetchOpenReview(
        `/notes?id=${encodeURIComponent(id)}`,
        `openreview paper ${id}`,
      ),
    );
    if (notes.length === 0)
      throw new Error(`No OpenReview paper found with id "${id}".`);
    const row = mapOpenReviewNoteRow(notes[0]);
    return [
      {
        id: row.id,
        title: row.title,
        authors: row.authors,
        keywords: row.keywords,
        venue: row.venue,
        venueid: row.venueid,
        primary_area: row.primary_area,
        abstract: row.abstract,
        pdate: row.pdate,
        pdf: row.pdf,
        url: row.url,
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
  columns: ["rank", "id", "title", "authors", "venue", "pdate", "url"],
  func: async (_page, kwargs) => {
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
      ),
    );
    if (notes.length === 0)
      throw new Error(`No OpenReview submissions found for "${profile}".`);
    return notes.slice(0, limit).map((note, index) => {
      const row = mapOpenReviewNoteRow(note);
      return {
        rank: index + 1,
        id: row.id,
        title: row.title,
        authors: row.authors,
        venue: row.venue,
        pdate: row.pdate,
        url: row.url,
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
    "primary_area",
    "pdate",
    "pdf",
    "url",
  ],
  func: async (_page, kwargs) => {
    const venue = String(kwargs.venue ?? "").trim();
    if (!venue) throw new Error("openreview venue cannot be empty.");
    const limit = requireOpenReviewLimit(kwargs.limit, 25, 200);
    const offset = requireOpenReviewOffset(kwargs.offset);
    const params = new URLSearchParams({
      [venue.includes("/-/") ? "invitation" : "content.venue"]: venue,
      limit: String(limit),
      offset: String(offset),
    });
    const notes = notesFromEnvelope(
      await fetchOpenReview(
        `/notes?${params.toString()}`,
        `openreview venue ${venue}`,
      ),
    );
    if (notes.length === 0)
      throw new Error(`No OpenReview papers found at venue "${venue}".`);
    return notes.slice(0, limit).map((note, index) => {
      const row = mapOpenReviewNoteRow(note);
      return {
        rank: offset + index + 1,
        id: row.id,
        title: row.title,
        authors: row.authors,
        keywords: row.keywords,
        primary_area: row.primary_area,
        pdate: row.pdate,
        pdf: row.pdf,
        url: row.url,
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
      description: "OpenReview forum id",
    },
    {
      name: "max-length",
      type: "int",
      default: 4000,
      description: "Per-row text truncation length",
    },
  ],
  columns: ["type", "author", "rating", "confidence", "text"],
  func: async (_page, kwargs) => {
    const forum = requireForumId(kwargs.forum, "forum");
    const maxLength = coerceOpenReviewInt(
      kwargs["max-length"] ?? kwargs.maxLength ?? 4000,
    );
    if (!Number.isInteger(maxLength) || maxLength < 200) {
      throw new Error(
        "openreview reviews max-length must be an integer >= 200.",
      );
    }
    const rootNotes = notesFromEnvelope(
      await fetchOpenReview(
        `/notes?id=${encodeURIComponent(forum)}`,
        `openreview paper ${forum}`,
      ),
    );
    const root = rootNotes[0];
    if (!root) throw new Error(`No OpenReview forum found with id "${forum}".`);
    const replies = notesFromEnvelope(
      await fetchOpenReview(
        `/notes?forum=${encodeURIComponent(forum)}&details=replies&limit=1000`,
        `openreview reviews ${forum}`,
      ),
    );
    return mapReviewThreadRows(root, replies, forum, maxLength);
  },
});
