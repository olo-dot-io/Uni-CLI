/**
 * @owner       src::adapters::scholar-artifacts::pdf-read
 * @does        Provides source-agnostic scholarly PDF download and pdftotext extraction helpers for source adapters.
 * @needs       src/engine/executor.ts cancellable download/exec steps, src/engine/download.ts, pdftotext
 * @feeds       src/adapters/scholar-artifacts/pdf.ts and source-specific scholarly read commands
 * @breaks      Invalid PDF URLs, denied download paths, missing pdftotext, or empty extracted text throw before claim text reaches agents.
 * @invariants  Helpers register no commands; callers pass the owning site/command and cancellation signal so operation policy, deadlines, and resource attribution stay source-scoped.
 * @side-effects HTTPS/HTTP egress to the supplied PDF URL; writes one PDF under the requested output directory; executes pdftotext.
 * @perf        O(PDF bytes + extracted page range); page range defaults to first 20 pages.
 * @concurrency Caller-provided unique output directories isolate invocations; the same ref/output pair shares one deterministic artifact path.
 * @test        tests/unit/adapters/scholar-artifacts.test.ts
 * @stability   experimental
 * @since       2026-06-27
 */

import { join, resolve } from "node:path";

import { runPipeline } from "../../engine/executor.js";
import { sanitizeFilename } from "../../engine/download.js";
import { Strategy } from "../../registry.js";

export interface ScholarArtifactDownloadRow {
  id: string;
  title: string;
  source_adapter: string;
  source_url?: string;
  pdf_url: string;
  path?: string;
  _download?: unknown;
}

export interface ScholarPdfReadOptions {
  site: string;
  command: string;
  defaultOutput: string;
  userAgent: string;
  signal?: AbortSignal;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function requireScholarPdfUrl(value: unknown): string {
  const url = stringField(value);
  if (!url) throw new Error("scholar PDF URL is required.");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`scholar PDF URL "${url}" is not a valid URL.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`scholar PDF URL "${url}" must use http or https.`);
  }
  return parsed.toString();
}

export function requireScholarPageRange(
  firstPage: unknown,
  lastPage: unknown,
): { firstPage: number; lastPage: number } {
  const first = Number(firstPage ?? 1);
  const last = Number(lastPage ?? 20);
  if (!Number.isInteger(first) || first < 1) {
    throw new Error("first-page must be a positive integer.");
  }
  if (!Number.isInteger(last) || last < first) {
    throw new Error(
      "last-page must be an integer greater than or equal to first-page.",
    );
  }
  return { firstPage: first, lastPage: last };
}

export function requireScholarMaxChars(
  value: unknown,
  fallback = 40_000,
): number {
  const raw =
    value === undefined || value === null || value === "" ? fallback : value;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 1_000 || n > 1_000_000) {
    throw new Error(
      `scholar max-chars must be an integer in [1000, 1000000]. Got: ${String(value)}`,
    );
  }
  return n;
}

export function truncateScholarText(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean; originalChars: number } {
  const originalChars = text.length;
  if (originalChars <= maxChars) {
    return { text, truncated: false, originalChars };
  }
  return {
    text: `${text.slice(0, maxChars).trimEnd()}\n\n[truncated at ${maxChars} characters]`,
    truncated: true,
    originalChars,
  };
}

export function scholarArtifactFilename(input: {
  source_adapter?: unknown;
  id?: unknown;
  title?: unknown;
  filename?: unknown;
}): string {
  const explicit = stringField(input.filename);
  if (explicit) {
    const safe = sanitizeFilename(explicit);
    return safe.toLowerCase().endsWith(".pdf") ? safe : `${safe}.pdf`;
  }

  const source = sanitizeFilename(
    stringField(input.source_adapter) || "scholar",
  );
  const id = sanitizeFilename(stringField(input.id) || "paper");
  const title = sanitizeFilename(stringField(input.title))
    .replace(/\s+/g, "_")
    .slice(0, 96);
  const stem = title ? `${source}-${id}-${title}` : `${source}-${id}`;
  return `${stem.slice(0, 180)}.pdf`;
}

function downloadPath(row: unknown): string {
  if (!row || typeof row !== "object") return "";
  const download = (row as { _download?: unknown })._download;
  if (!download || typeof download !== "object") return "";
  return stringField((download as { path?: unknown }).path);
}

function downloadFailure(row: unknown): string {
  if (!row || typeof row !== "object") return "download step returned no row";
  const download = (row as { _download?: unknown })._download;
  if (!download || typeof download !== "object") {
    return "download step returned no _download metadata";
  }
  const status = stringField((download as { status?: unknown }).status);
  const error = stringField((download as { error?: unknown }).error);
  return [status ? `status=${status}` : "", error ? `error=${error}` : ""]
    .filter(Boolean)
    .join(", ");
}

export async function downloadScholarPdf(
  kwargs: Record<string, unknown>,
  options: ScholarPdfReadOptions,
): Promise<ScholarArtifactDownloadRow> {
  const pdfUrl = requireScholarPdfUrl(kwargs.pdf_url);
  const output = resolve(stringField(kwargs.output) || options.defaultOutput);
  const filename = scholarArtifactFilename(kwargs);
  const id = stringField(kwargs.id) || pdfUrl;
  const title = stringField(kwargs.title) || id;
  const sourceAdapter = stringField(kwargs.source_adapter) || options.site;
  const sourceUrl = stringField(kwargs.source_url);

  const rows = await runPipeline(
    [
      {
        download: {
          url: "${{ args.pdf_url }}",
          dir: "${{ args.output }}",
          filename: "${{ args.filename }}",
          type: "document",
          headers: {
            Accept: "application/pdf,*/*",
            "User-Agent": options.userAgent,
          },
        },
      },
    ],
    {
      args: {
        pdf_url: pdfUrl,
        output,
        filename,
      },
      source: "internal",
    },
    undefined,
    {
      site: options.site,
      command: options.command,
      strategy: Strategy.PUBLIC,
      domain: new URL(pdfUrl).hostname,
      surface: "cli",
      signal: options.signal,
    },
  );
  const row = rows[0];
  const path = downloadPath(row);
  if (!path) {
    throw new Error(
      `scholar PDF download failed for ${pdfUrl}: ${downloadFailure(row)}.`,
    );
  }

  return {
    id,
    title,
    source_adapter: sourceAdapter,
    ...(sourceUrl ? { source_url: sourceUrl } : {}),
    pdf_url: pdfUrl,
    path,
    _download:
      row && typeof row === "object"
        ? (row as { _download?: unknown })._download
        : undefined,
  };
}

export async function readScholarPdf(
  kwargs: Record<string, unknown>,
  options: ScholarPdfReadOptions,
): Promise<Record<string, unknown>> {
  const downloaded = await downloadScholarPdf(kwargs, options);
  const { firstPage, lastPage } = requireScholarPageRange(
    kwargs["first-page"] ?? kwargs.firstPage ?? kwargs.first_page,
    kwargs["last-page"] ?? kwargs.lastPage ?? kwargs.last_page,
  );
  const maxChars = requireScholarMaxChars(
    kwargs["max-chars"] ?? kwargs.maxChars ?? kwargs.max_chars,
  );
  const [text] = await runPipeline(
    [
      {
        exec: {
          command: "pdftotext",
          args: [
            "-layout",
            "-enc",
            "UTF-8",
            "-f",
            "${{ args.first_page }}",
            "-l",
            "${{ args.last_page }}",
            "${{ args.file }}",
            "-",
          ],
          parse: "text",
          timeout: 60000,
        },
      },
    ],
    {
      args: {
        file: downloaded.path,
        first_page: firstPage,
        last_page: lastPage,
      },
      source: "internal",
    },
    undefined,
    {
      site: options.site,
      command: options.command,
      strategy: Strategy.PUBLIC,
      surface: "cli",
      signal: options.signal,
    },
  );
  const extracted = stringField(text);
  if (!extracted) {
    throw new Error(
      `pdftotext extracted no text from ${downloaded.path ?? join(".", scholarArtifactFilename(kwargs))}.`,
    );
  }
  const truncated = truncateScholarText(extracted, maxChars);
  return {
    ...downloaded,
    text: truncated.text,
    text_chars: truncated.originalChars,
    text_truncated: truncated.truncated,
    text_source: "pdf",
  };
}
