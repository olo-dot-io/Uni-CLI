/**
 * @owner       src::adapters::openreview::conference
 * @does        Archives one OpenReview venue as resumable per-paper threads, public edit history, attachments, PDFs, and external-link metadata.
 * @needs       OpenReview group/note/edit APIs and the paced authenticated OpenReview client.
 * @feeds       Durable academic review corpora and downstream concern/rebuttal analysis.
 * @breaks      Partial runs remain explicitly in-progress and resume from the last committed API cursor.
 * @invariants  Raw public objects are retained; forum/reply/edit identity is never inferred from display text; external repositories are indexed but never recursively mirrored.
 * @side-effects Creates an archive tree and downloads public OpenReview-hosted artifacts.
 * @perf        Bulk pages up to 1000 records, serial paced network access, idempotent artifact reuse.
 * @concurrency One command owns its venue checkpoint; the OpenReview client serializes network calls in-process.
 * @test        src/adapters/openreview/conference.test.ts
 * @stability   experimental
 * @since       2026-08-02
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";

import { sanitizeFilename } from "../../engine/download.js";
import { publishFileTransactionally } from "../../engine/transactional-file.js";
import { cli, Strategy } from "../../registry.js";
import {
  OPENREVIEW_WEB_BASE,
  OpenReviewHttpClient,
  type OpenReviewApiVersion,
  readOpenReviewContent,
} from "./client.js";

const VENUE_ID_RE =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/;
const FILE_FIELD_RE =
  /(?:pdf|supplement|attachment|appendix|source|code|artifact|rebuttal)/i;
const EXTERNAL_LINK_FIELD_RE =
  /(?:code|data|dataset|project|repository|website|artifact)/i;

interface OpenReviewEntity {
  id?: unknown;
  forum?: unknown;
  replyto?: unknown;
  number?: unknown;
  invitations?: unknown;
  signatures?: unknown;
  readers?: unknown;
  writers?: unknown;
  cdate?: unknown;
  tcdate?: unknown;
  mdate?: unknown;
  tmdate?: unknown;
  pdate?: unknown;
  ddate?: unknown;
  domain?: unknown;
  content?: Record<string, unknown>;
  details?: Record<string, unknown>;
  note?: OpenReviewEntity;
  [key: string]: unknown;
}

interface NotesEnvelope {
  count?: unknown;
  notes?: OpenReviewEntity[];
}

interface EditsEnvelope {
  count?: unknown;
  edits?: OpenReviewEntity[];
}

interface GroupsEnvelope {
  groups?: OpenReviewEntity[];
}

export interface OpenReviewArtifactRef {
  entity_id: string;
  forum_id: string;
  field: string;
  url: string;
  kind: "openreview_file" | "external_link";
  version_timestamp: number;
}

interface ArchiveManifest {
  schema_version: "1";
  venue_id: string;
  api_version: OpenReviewApiVersion;
  submission_invitation: string;
  status: "in_progress" | "complete";
  phase: "submissions" | "edits" | "edits_catchup" | "complete";
  started_at: string;
  updated_at: string;
  completed_at?: string;
  submissions_after?: string;
  edits_offset?: number;
  edits_head_id?: string;
  edits_catchup_offset?: number;
  submission_count: number;
  reply_count: number;
  edit_count: number;
  artifact_count: number;
  external_link_count: number;
  revisions_available: boolean;
  metadata_only: boolean;
  rpm: number;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function publicReaders(value: unknown): boolean {
  return Array.isArray(value) && value.includes("everyone");
}

function publicContent(
  content: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!content) return undefined;
  const visible: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(content)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const readers = (value as { readers?: unknown }).readers;
      if (readers !== undefined && !publicReaders(readers)) continue;
    }
    visible[key] = value;
  }
  return visible;
}

export function sanitizePublicOpenReviewEntity(
  entity: OpenReviewEntity,
): OpenReviewEntity | undefined {
  if (!publicReaders(entity.readers)) return undefined;
  const details = entity.details ? { ...entity.details } : undefined;
  for (const key of ["replies", "directReplies", "revisions"]) {
    if (!Array.isArray(details?.[key])) continue;
    details[key] = (details[key] as OpenReviewEntity[])
      .map((child) => sanitizePublicOpenReviewEntity(child))
      .filter((child): child is OpenReviewEntity => child !== undefined);
  }
  const note = entity.note
    ? sanitizePublicOpenReviewEntity(entity.note)
    : undefined;
  return {
    ...entity,
    ...(entity.content ? { content: publicContent(entity.content) } : {}),
    ...(details ? { details } : {}),
    ...(note ? { note } : entity.note ? { note: undefined } : {}),
  };
}

function isoNow(): string {
  return new Date().toISOString();
}

export function requireOpenReviewVenueId(value: unknown): string {
  const raw = String(value ?? "").trim();
  let venue = raw;
  try {
    const url = new URL(raw);
    if (url.hostname === "openreview.net" && url.pathname === "/group") {
      venue = url.searchParams.get("id") ?? "";
    }
  } catch {
    // A venue id is not a URL.
  }
  if (!venue || !VENUE_ID_RE.test(venue) || venue.includes("/-/")) {
    throw new Error(
      `openreview venue "${raw}" is not a valid group id or group URL.`,
    );
  }
  return venue;
}

function invitationTail(entity: OpenReviewEntity): string {
  for (const invitation of arrayValue(entity.invitations)) {
    const match = String(invitation).match(/\/-\/([^/]+)$/);
    if (match) return match[1];
  }
  return "";
}

export function classifyOpenReviewNote(
  entity: OpenReviewEntity,
  isRoot = false,
): string {
  if (isRoot) return "submission";
  const tail = invitationTail(entity).toLowerCase();
  if (/(?:decision|recommendation)/.test(tail)) return "decision";
  if (/(?:withdraw|desk_reject|reject)/.test(tail)) return "status";
  if (/(?:meta[_-]?review|metareview)/.test(tail)) return "meta_review";
  if (/(?:rebuttal|author[_-]?(?:response|reply)|response)/.test(tail))
    return "author_response";
  if (/(?:official[_-]?review|review)/.test(tail)) return "review";
  if (/(?:comment|discussion)/.test(tail)) return "comment";
  return tail || "note";
}

function contentSections(
  content: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const sections: Record<string, unknown> = {};
  for (const key of Object.keys(content ?? {}).sort()) {
    sections[key] = readOpenReviewContent(content, key);
  }
  return sections;
}

function concernSections(
  content: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const concerns: Record<string, unknown> = {};
  for (const key of Object.keys(content ?? {})) {
    if (
      /(?:weakness|concern|question|limitation|shortcoming|issue)/i.test(key)
    ) {
      concerns[key] = readOpenReviewContent(content, key);
    }
  }
  return concerns;
}

function normalizedTimelineRow(
  entity: OpenReviewEntity,
  forumId: string,
  isRoot: boolean,
): Record<string, unknown> {
  const id = stringValue(entity.id) || forumId;
  return {
    forum_id: forumId,
    note_id: id,
    parent_note_id: stringValue(entity.replyto),
    type: classifyOpenReviewNote(entity, isRoot),
    invitations: arrayValue(entity.invitations),
    signatures: arrayValue(entity.signatures),
    created_at_ms: numberValue(entity.tcdate ?? entity.cdate),
    modified_at_ms: numberValue(entity.tmdate ?? entity.mdate),
    source_url:
      id === forumId
        ? `${OPENREVIEW_WEB_BASE}/forum?id=${forumId}`
        : `${OPENREVIEW_WEB_BASE}/forum?id=${forumId}&noteId=${id}`,
    content: contentSections(entity.content),
    concerns: concernSections(entity.content),
  };
}

export function normalizeOpenReviewThread(
  submission: OpenReviewEntity,
): Record<string, unknown> {
  const forumId = stringValue(submission.forum) || stringValue(submission.id);
  const details = submission.details ?? {};
  const replies = [
    ...arrayValue(details.replies),
    ...arrayValue(details.directReplies),
  ].filter(
    (value, index, all) =>
      value &&
      typeof value === "object" &&
      all.findIndex(
        (candidate) =>
          stringValue((candidate as OpenReviewEntity)?.id) ===
          stringValue((value as OpenReviewEntity).id),
      ) === index,
  ) as OpenReviewEntity[];
  const timeline = [
    normalizedTimelineRow(submission, forumId, true),
    ...replies.map((reply) => normalizedTimelineRow(reply, forumId, false)),
  ].sort(
    (left, right) =>
      numberValue(left.created_at_ms) - numberValue(right.created_at_ms),
  );
  return {
    schema_version: "1",
    forum_id: forumId,
    paper_number: submission.number ?? null,
    title: readOpenReviewContent(submission.content, "title") ?? "",
    venue: readOpenReviewContent(submission.content, "venue") ?? "",
    venue_id: readOpenReviewContent(submission.content, "venueid") ?? "",
    source_url: `${OPENREVIEW_WEB_BASE}/forum?id=${forumId}`,
    submission,
    replies,
    timeline,
    revision_directory: "edits",
    artifact_directory: "artifacts",
  };
}

function candidateStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(candidateStrings);
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(candidateStrings);
  }
  return [];
}

function absoluteOpenReviewUrl(value: string): string {
  return new URL(value, OPENREVIEW_WEB_BASE).href;
}

function entityVersionTimestamp(entity: OpenReviewEntity): number {
  return numberValue(
    entity.tmdate ?? entity.mdate ?? entity.tcdate ?? entity.cdate,
  );
}

export function extractOpenReviewArtifacts(
  entity: OpenReviewEntity,
  fallbackForumId = "",
): OpenReviewArtifactRef[] {
  const entityId = stringValue(entity.id) || stringValue(entity.note?.id);
  const forumId =
    stringValue(entity.forum) ||
    stringValue(entity.note?.forum) ||
    stringValue(entity.note?.id) ||
    fallbackForumId ||
    entityId;
  const content = entity.note?.content ?? entity.content;
  const refs: OpenReviewArtifactRef[] = [];
  const seen = new Set<string>();
  for (const [field, wrapped] of Object.entries(content ?? {})) {
    const value =
      wrapped &&
      typeof wrapped === "object" &&
      !Array.isArray(wrapped) &&
      Object.hasOwn(wrapped, "value")
        ? (wrapped as { value?: unknown }).value
        : wrapped;
    for (const candidate of candidateStrings(value)) {
      if (!/^https?:\/\//i.test(candidate) && !candidate.startsWith("/"))
        continue;
      let parsed: URL;
      try {
        parsed = new URL(candidate, OPENREVIEW_WEB_BASE);
      } catch {
        continue;
      }
      const openReviewHosted = [
        "openreview.net",
        "api.openreview.net",
        "api2.openreview.net",
      ].includes(parsed.hostname.toLowerCase());
      const fileLike =
        FILE_FIELD_RE.test(field) ||
        /\/(?:pdf|attachment|references\/pdf)(?:\/|\?|$)/i.test(
          parsed.pathname,
        );
      const kind =
        openReviewHosted && fileLike ? "openreview_file" : "external_link";
      if (kind === "external_link" && !EXTERNAL_LINK_FIELD_RE.test(field))
        continue;
      const url = absoluteOpenReviewUrl(candidate);
      const key = `${field}\0${url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({
        entity_id: entityId,
        forum_id: forumId,
        field,
        url,
        kind,
        version_timestamp: entityVersionTimestamp(entity.note ?? entity),
      });
    }
  }
  return refs;
}

function archiveSlug(venueId: string): string {
  return sanitizeFilename(venueId.replaceAll("/", "_"));
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await publishFileTransactionally(path, (temporaryPath) =>
    writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
    }),
  );
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function recountArchive(archiveRoot: string): Promise<{
  submissions: number;
  replies: number;
  edits: number;
  artifacts: number;
  externalLinks: number;
}> {
  const counts = {
    submissions: 0,
    replies: 0,
    edits: 0,
    artifacts: 0,
    externalLinks: 0,
  };
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (entry.name === "record.json") {
        const record = await readJson<{
          replies?: unknown[];
          external_links?: unknown[];
        }>(path);
        counts.submissions += 1;
        counts.replies += record?.replies?.length ?? 0;
        counts.externalLinks += record?.external_links?.length ?? 0;
      } else if (
        basename(dirname(path)) === "edits" &&
        path.endsWith(".json")
      ) {
        counts.edits += 1;
        const edit = await readJson<OpenReviewEntity>(path);
        if (edit) {
          counts.externalLinks += extractOpenReviewArtifacts(edit).filter(
            (ref) => ref.kind === "external_link",
          ).length;
        }
      } else if (
        path.includes(`${sep}artifacts${sep}`) &&
        path.endsWith(".json")
      ) {
        counts.artifacts += 1;
      }
    }
  }
  const threadsRoot = join(archiveRoot, "threads");
  try {
    await walk(threadsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return counts;
}

function artifactExtension(ref: OpenReviewArtifactRef): string {
  const pathname = new URL(ref.url).pathname;
  const extension = extname(pathname).toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(extension)) return extension;
  if (/pdf/i.test(ref.field) || /\/pdf(?:\/|$)/i.test(pathname)) return ".pdf";
  return ".artifact";
}

async function persistArtifact(
  client: OpenReviewHttpClient,
  archiveRoot: string,
  ref: OpenReviewArtifactRef,
): Promise<boolean> {
  const identity = createHash("sha256")
    .update(`${ref.url}\0${ref.version_timestamp}`)
    .digest("hex")
    .slice(0, 16);
  const entity = sanitizeFilename(ref.entity_id || "unknown");
  const field = sanitizeFilename(ref.field || "artifact");
  const directory = join(
    archiveRoot,
    "threads",
    sanitizeFilename(ref.forum_id),
    "artifacts",
    entity,
  );
  const path = join(directory, `${field}-${identity}${artifactExtension(ref)}`);
  const metadataPath = `${path}.json`;
  const existing = await readJson<{
    source_url?: string;
    sha256?: string;
    size?: number;
  }>(metadataPath);
  if (existing?.source_url === ref.url && existing.sha256) {
    try {
      const info = await stat(path);
      if (
        info.size === existing.size &&
        (await sha256File(path)) === existing.sha256
      ) {
        return false;
      }
    } catch {
      // Missing or corrupt artifacts are fetched again.
    }
  }
  const result = await client.download(
    ref.url,
    path,
    `openreview artifact ${ref.entity_id}/${ref.field}`,
  );
  if (!result) {
    throw new Error(`OpenReview artifact returned 404: ${ref.url}`);
  }
  await writeJsonAtomic(metadataPath, { ...ref, ...result });
  return true;
}

function pageCursor(rows: OpenReviewEntity[]): string | undefined {
  return stringValue(rows.at(-1)?.id);
}

function queryPath(
  endpoint: string,
  params: Record<string, string | number | boolean | undefined>,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  return `${endpoint}?${query.toString()}`;
}

function groupContentString(group: OpenReviewEntity, key: string): string {
  return stringValue(readOpenReviewContent(group.content, key));
}

async function resolveVenue(
  venueId: string,
  rpm: number,
): Promise<{
  client: OpenReviewHttpClient;
  group: OpenReviewEntity;
  submissionInvitation: string;
}> {
  for (const apiVersion of [2, 1] as const) {
    const client = new OpenReviewHttpClient({ apiVersion, rpm });
    const envelope = await client.json<GroupsEnvelope>(
      queryPath("/groups", { id: venueId }),
      `openreview venue group ${venueId} (API v${apiVersion})`,
    );
    const group = envelope?.groups?.[0];
    if (!group) continue;
    const submissionInvitation =
      groupContentString(group, "submission_id") || `${venueId}/-/Submission`;
    return { client, group, submissionInvitation };
  }
  throw Object.assign(
    new Error(`OpenReview venue group not found: ${venueId}.`),
    {
      code: "not_found",
      suggestion: "Verify the group URL and whether the venue is public.",
      retryable: false,
      alternatives: [],
    },
  );
}

async function archiveSubmissionPage(
  client: OpenReviewHttpClient,
  archiveRoot: string,
  rows: OpenReviewEntity[],
  metadataOnly: boolean,
): Promise<{
  submissions: number;
  replies: number;
  artifacts: number;
  externalLinks: number;
}> {
  let replies = 0;
  let artifacts = 0;
  let externalLinks = 0;
  const publicRows = rows
    .map((row) => sanitizePublicOpenReviewEntity(row))
    .filter((row): row is OpenReviewEntity => row !== undefined);
  for (const submission of publicRows) {
    const thread = normalizeOpenReviewThread(submission);
    const forumId = stringValue(thread.forum_id);
    const threadRoot = join(archiveRoot, "threads", sanitizeFilename(forumId));
    const replyRows = thread.replies as OpenReviewEntity[];
    replies += replyRows.length;
    const refs = [submission, ...replyRows].flatMap((entity) =>
      extractOpenReviewArtifacts(entity, forumId),
    );
    const external = refs.filter((ref) => ref.kind === "external_link");
    externalLinks += external.length;
    await writeJsonAtomic(join(threadRoot, "record.json"), {
      ...thread,
      external_links: external,
      openreview_artifacts: refs.filter(
        (ref) => ref.kind === "openreview_file",
      ),
    });
    if (!metadataOnly) {
      for (const ref of refs) {
        if (ref.kind !== "openreview_file") continue;
        if (await persistArtifact(client, archiveRoot, ref)) artifacts += 1;
      }
    }
  }
  return {
    submissions: publicRows.length,
    replies,
    artifacts,
    externalLinks,
  };
}

async function archiveEditPage(
  client: OpenReviewHttpClient,
  archiveRoot: string,
  edits: OpenReviewEntity[],
  metadataOnly: boolean,
): Promise<{ edits: number; artifacts: number; externalLinks: number }> {
  let artifacts = 0;
  let externalLinks = 0;
  const publicEdits = edits
    .map((edit) => sanitizePublicOpenReviewEntity(edit))
    .filter((edit): edit is OpenReviewEntity => edit !== undefined);
  for (const edit of publicEdits) {
    const note = edit.note ?? {};
    const forumId =
      stringValue(note.forum) || stringValue(note.id) || "venue-unlinked";
    const editId = stringValue(edit.id);
    await writeJsonAtomic(
      join(
        archiveRoot,
        "threads",
        sanitizeFilename(forumId),
        "edits",
        `${sanitizeFilename(editId || "unknown")}.json`,
      ),
      edit,
    );
    const refs = extractOpenReviewArtifacts(edit, forumId);
    externalLinks += refs.filter((ref) => ref.kind === "external_link").length;
    if (!metadataOnly) {
      for (const ref of refs) {
        if (ref.kind !== "openreview_file") continue;
        if (await persistArtifact(client, archiveRoot, ref)) artifacts += 1;
      }
    }
  }
  return { edits: publicEdits.length, artifacts, externalLinks };
}

async function archiveConference(
  venueId: string,
  output: string,
  rpm: number,
  metadataOnly: boolean,
): Promise<Record<string, unknown>> {
  const archiveRoot = join(resolve(output), archiveSlug(venueId));
  const manifestPath = join(archiveRoot, "manifest.json");
  await mkdir(archiveRoot, { recursive: true });
  const { client, group, submissionInvitation } = await resolveVenue(
    venueId,
    rpm,
  );
  await writeJsonAtomic(join(archiveRoot, "group.json"), group);

  const previous = await readJson<ArchiveManifest>(manifestPath);
  const canResume =
    previous?.status === "in_progress" &&
    previous.venue_id === venueId &&
    previous.api_version === client.apiVersion &&
    previous.submission_invitation === submissionInvitation &&
    previous.metadata_only === metadataOnly;
  const now = isoNow();
  const manifest: ArchiveManifest = canResume
    ? { ...previous, updated_at: now, rpm }
    : {
        schema_version: "1",
        venue_id: venueId,
        api_version: client.apiVersion,
        submission_invitation: submissionInvitation,
        status: "in_progress",
        phase: "submissions",
        started_at: now,
        updated_at: now,
        submission_count: 0,
        reply_count: 0,
        edit_count: 0,
        artifact_count: 0,
        external_link_count: 0,
        revisions_available: client.apiVersion === 2,
        metadata_only: metadataOnly,
        rpm,
      };
  await writeJsonAtomic(manifestPath, manifest);

  if (manifest.phase === "submissions") {
    let after = manifest.submissions_after;
    for (;;) {
      const envelope = await client.json<NotesEnvelope>(
        queryPath("/notes", {
          invitation: submissionInvitation,
          details: "replies,revisions",
          domain: venueId,
          sort: "id",
          limit: 1000,
          count: after ? undefined : true,
          after,
        }),
        `openreview submissions ${venueId}${after ? ` after ${after}` : ""}`,
      );
      const rows = envelope?.notes ?? [];
      if (rows.length === 0) break;
      const delta = await archiveSubmissionPage(
        client,
        archiveRoot,
        rows,
        metadataOnly,
      );
      manifest.submission_count += delta.submissions;
      manifest.reply_count += delta.replies;
      manifest.artifact_count += delta.artifacts;
      manifest.external_link_count += delta.externalLinks;
      const next = pageCursor(rows);
      if (!next || next === after) {
        throw new Error(`OpenReview submission pagination did not advance.`);
      }
      after = next;
      manifest.submissions_after = after;
      manifest.updated_at = isoNow();
      await writeJsonAtomic(manifestPath, manifest);
      if (rows.length < 1000) break;
    }
    manifest.phase = client.apiVersion === 2 ? "edits" : "complete";
    manifest.updated_at = isoNow();
    await writeJsonAtomic(manifestPath, manifest);
  }

  if (manifest.phase === "edits") {
    let offset = manifest.edits_offset ?? 0;
    for (;;) {
      const envelope = await client.json<EditsEnvelope>(
        queryPath("/notes/edits", {
          domain: venueId,
          limit: 1000,
          count: offset === 0 ? true : undefined,
          offset,
        }),
        `openreview note edits ${venueId} at offset ${offset}`,
      );
      const edits = envelope?.edits ?? [];
      if (edits.length === 0) break;
      if (!manifest.edits_head_id) {
        manifest.edits_head_id = stringValue(edits[0]?.id);
      }
      const reportedCount = Number(envelope?.count);
      if (Number.isInteger(reportedCount) && reportedCount >= 0) {
        manifest.edit_count = Math.max(manifest.edit_count, reportedCount);
      }
      const delta = await archiveEditPage(
        client,
        archiveRoot,
        edits,
        metadataOnly,
      );
      manifest.artifact_count += delta.artifacts;
      manifest.external_link_count += delta.externalLinks;
      const nextOffset = offset + edits.length;
      if (nextOffset <= offset) {
        throw new Error(`OpenReview edit pagination did not advance.`);
      }
      offset = nextOffset;
      manifest.edits_offset = offset;
      manifest.updated_at = isoNow();
      await writeJsonAtomic(manifestPath, manifest);
      if (edits.length < 1000) break;
    }
    manifest.phase = "edits_catchup";
    manifest.edits_catchup_offset = 0;
    manifest.updated_at = isoNow();
    await writeJsonAtomic(manifestPath, manifest);
  }

  if (manifest.phase === "edits_catchup") {
    let offset = manifest.edits_catchup_offset ?? 0;
    for (;;) {
      const envelope = await client.json<EditsEnvelope>(
        queryPath("/notes/edits", {
          domain: venueId,
          limit: 1000,
          count: offset === 0 ? true : undefined,
          offset,
        }),
        `openreview edit catch-up ${venueId} at offset ${offset}`,
      );
      const edits = envelope?.edits ?? [];
      const reportedCount = Number(envelope?.count);
      if (Number.isInteger(reportedCount) && reportedCount >= 0) {
        manifest.edit_count = Math.max(manifest.edit_count, reportedCount);
      }
      if (edits.length === 0) break;
      const boundaryIndex = manifest.edits_head_id
        ? edits.findIndex(
            (edit) => stringValue(edit.id) === manifest.edits_head_id,
          )
        : -1;
      const catchupRows =
        boundaryIndex >= 0 ? edits.slice(0, boundaryIndex + 1) : edits;
      const delta = await archiveEditPage(
        client,
        archiveRoot,
        catchupRows,
        metadataOnly,
      );
      manifest.artifact_count += delta.artifacts;
      manifest.external_link_count += delta.externalLinks;
      if (boundaryIndex >= 0) break;
      offset += edits.length;
      manifest.edits_catchup_offset = offset;
      manifest.updated_at = isoNow();
      await writeJsonAtomic(manifestPath, manifest);
      if (edits.length < 1000) break;
    }
    manifest.phase = "complete";
  }

  manifest.status = "complete";
  manifest.phase = "complete";
  const counts = await recountArchive(archiveRoot);
  manifest.submission_count = counts.submissions;
  manifest.reply_count = counts.replies;
  manifest.edit_count = counts.edits;
  manifest.artifact_count = counts.artifacts;
  manifest.external_link_count = counts.externalLinks;
  manifest.updated_at = isoNow();
  manifest.completed_at = manifest.updated_at;
  await writeJsonAtomic(manifestPath, manifest);
  return {
    venue_id: venueId,
    api_version: client.apiVersion,
    submission_invitation: submissionInvitation,
    status: manifest.status,
    submissions: manifest.submission_count,
    replies: manifest.reply_count,
    edits: manifest.edit_count,
    downloaded_artifacts: manifest.artifact_count,
    external_links: manifest.external_link_count,
    metadata_only: metadataOnly,
    path: archiveRoot,
    manifest: manifestPath,
    source_url: `${OPENREVIEW_WEB_BASE}/group?id=${encodeURIComponent(venueId)}`,
  };
}

cli({
  site: "openreview",
  name: "conference",
  description:
    "Create or resume an archive of every public paper, review thread, rebuttal, decision, edit revision, PDF, supplementary file, and code/data link for an OpenReview venue",
  domain: "openreview.net",
  strategy: Strategy.COOKIE,
  args: [
    {
      name: "venue",
      type: "str",
      required: true,
      positional: true,
      description: "Venue group id or OpenReview group URL",
      "x-unicli-kind": "id",
      "x-unicli-accepts": ["url"],
    },
    {
      name: "output",
      type: "str",
      default: "./openreview-archives",
      description: "Archive root directory",
      "x-unicli-kind": "path",
    },
    {
      name: "rpm",
      type: "int",
      default: 20,
      description: "Strict maximum OpenReview requests per minute (1-180)",
    },
    {
      name: "metadata-only",
      type: "bool",
      default: false,
      description:
        "Archive notes, edits, and file/link metadata without binaries",
    },
  ],
  columns: [
    "venue_id",
    "api_version",
    "status",
    "submissions",
    "replies",
    "edits",
    "downloaded_artifacts",
    "external_links",
    "path",
    "manifest",
  ],
  operation_effect: "download_file",
  execution_operator: "structured-api",
  capabilities: [
    "http.fetch",
    "http.download",
    "scholar.venue",
    "scholar.review",
    "scholar.pdf",
  ],
  minimum_capability: "http.download",
  func: async (_page, kwargs) => {
    const venueId = requireOpenReviewVenueId(kwargs.venue);
    const rpm = Number(kwargs.rpm ?? 20);
    if (!Number.isInteger(rpm) || rpm < 1 || rpm > 180) {
      throw new Error(
        "openreview conference rpm must be an integer in [1, 180].",
      );
    }
    const metadataOnly =
      kwargs["metadata-only"] === true || kwargs.metadataOnly === true;
    return [
      await archiveConference(
        venueId,
        String(kwargs.output ?? "./openreview-archives"),
        rpm,
        metadataOnly,
      ),
    ];
  },
});
