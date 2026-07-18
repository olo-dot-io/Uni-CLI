/**
 * @owner       src::engine::evidence-reader
 * @does        Reads public URLs through bounded, format-aware direct and registered readers, then emits one EvidenceDocument contract.
 * @needs       evidence-document, validated text fetch, HTML challenge detection, adapter registry/command contracts/kernel, and scholar-artifacts PDF extraction
 * @feeds       top-level extract and AI read enrichment
 * @breaks      Returning SPA shells, binary bytes, unbounded bodies, or reader-specific output shapes creates false evidence.
 * @invariants  Direct reads are bounded and request-policy validated; caller cancellation retains its exact identity; challenges, dynamic shells, unsupported representations, malformed declared JSON, and empty content fail closed; registered readers remain read-only or confine downloads to a caller-owned temporary root, and stay within the fixed reader capability set; third-party readers are explicit.
 * @side-effects Performs network reads; PDF reads create and remove one invocation-local temporary directory; registered reader paths cannot create durable external effects.
 * @perf        Direct reads are capped at five MB and 30 seconds; PDF extraction is capped at 60 seconds.
 * @concurrency Request state and temporary directories are invocation-local.
 * @test        tests/unit/engine/evidence-document.test.ts, tests/unit/commands/extract.test.ts, tests/unit/commands/ai.test.ts
 * @stability   experimental
 * @since       2026-07-17
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildCommandContract } from "../core/command-contract.js";
import { getAllAdapters } from "../registry.js";
import type { AdapterCommand } from "../types.js";
import {
  canonicalizeUrl,
  isDynamicDocumentShell,
  structureEvidenceDocument,
  type EvidenceDocument,
} from "./evidence-document.js";
import { resolveArgs } from "./args.js";
import { PipelineError } from "./executor.js";
import { htmlToMarkdown } from "./html-to-markdown.js";
import { buildInvocation, execute } from "./kernel/execute.js";
import { fetchTextResource } from "./steps/fetch-text.js";
import { isHtmlVerificationChallenge } from "./steps/html-to-md.js";

export type EvidenceRepresentation = "markdown" | "text" | "html";
export type EvidenceReader = "direct" | "jina" | "defuddle";

type EvidenceReadFailureInit = {
  code: string;
  message: string;
  suggestion: string;
  retryable?: boolean;
  alternatives?: string[];
};

export class EvidenceReadFailure extends Error {
  readonly code: string;
  readonly suggestion: string;
  readonly retryable: boolean;
  readonly alternatives: string[];

  constructor(init: EvidenceReadFailureInit) {
    super(init.message);
    this.name = "EvidenceReadFailure";
    this.code = init.code;
    this.suggestion = init.suggestion;
    this.retryable = init.retryable ?? false;
    this.alternatives = init.alternatives ?? [];
  }
}

export interface ReadEvidenceOptions {
  maxChars?: number;
  maxLinks?: number;
  reader?: EvidenceReader;
  representation?: EvidenceRepresentation;
  firstPage?: number;
  lastPage?: number;
  signal?: AbortSignal;
}

const DIRECT_READ_TIMEOUT_MS = 30_000;
const PDF_READ_TIMEOUT_MS = 60_000;
const REGISTERED_READER_CAPABILITIES = new Set([
  "http.fetch",
  "http.download",
  "subprocess.exec",
  "auth.executable.gh",
]);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function boundedSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
}

function parseHttpUrl(raw: string): URL {
  const canonical = canonicalizeUrl(raw);
  let parsed: URL;
  try {
    parsed = new URL(canonical);
  } catch {
    throw new EvidenceReadFailure({
      code: "invalid_input",
      message: "url must be an absolute HTTP(S) URL.",
      suggestion: "Pass an absolute public http:// or https:// URL.",
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new EvidenceReadFailure({
      code: "invalid_input",
      message: "url must use HTTP or HTTPS.",
      suggestion: "Pass an absolute public http:// or https:// URL.",
    });
  }
  return parsed;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new EvidenceReadFailure({
      code: "invalid_input",
      message: `${label} must be an integer between 1 and ${maximum}.`,
      suggestion: `Choose ${label} from 1 to ${maximum}.`,
    });
  }
  return resolved;
}

function declaredArgs(
  command: AdapterCommand,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const schema = command.adapterArgs ?? [];
  const names = new Set(schema.map((arg) => arg.name));
  const filtered = Object.fromEntries(
    Object.entries(args).filter(
      ([name, value]) => names.has(name) && value !== undefined,
    ),
  );
  const resolved = resolveArgs({
    opts: filtered,
    positionals: [],
    schema: schema.map((arg) => ({ ...arg, positional: false })),
    stdinIsTTY: true,
  });
  return Object.fromEntries(
    Object.entries(resolved.args).filter(([name]) => names.has(name)),
  );
}

async function executeReaderCommand(input: {
  site: string;
  commandName: string;
  args: Record<string, unknown>;
  signal: AbortSignal;
  callerSignal?: AbortSignal;
  ephemeralOutput?: { argument: string; root: string };
}): Promise<unknown[]> {
  input.callerSignal?.throwIfAborted();
  const adapter = getAllAdapters().find(
    (candidate) => candidate.name === input.site,
  );
  const command = adapter?.commands[input.commandName];
  if (!adapter || !command) {
    throw new EvidenceReadFailure({
      code: "reader_unavailable",
      message: `Registered ${input.site}.${input.commandName} reader is unavailable.`,
      suggestion: `Restore the reader or inspect \`unicli describe ${input.site} ${input.commandName}\`.`,
    });
  }
  const contract = buildCommandContract({
    adapter,
    commandName: input.commandName,
    command,
  });
  const args = declaredArgs(command, input.args);
  const ephemeralOutputValue = input.ephemeralOutput
    ? args[input.ephemeralOutput.argument]
    : undefined;
  const confinesDownload =
    contract.effect.operation_effect === "download_file" &&
    input.ephemeralOutput !== undefined &&
    typeof ephemeralOutputValue === "string" &&
    resolve(ephemeralOutputValue) === resolve(input.ephemeralOutput.root);
  if (!contract.effect.read_only && !confinesDownload) {
    throw new EvidenceReadFailure({
      code: "reader_contract_invalid",
      message: `Registered ${input.site}.${input.commandName} reader has an uncontained ${contract.effect.operation_effect} effect.`,
      suggestion:
        "Use a read-only command or bind its download output to an invocation-owned temporary root.",
    });
  }
  const uncontainedCapabilities = (command.capabilities ?? []).filter(
    (capability) => !REGISTERED_READER_CAPABILITIES.has(capability),
  );
  if (uncontainedCapabilities.length > 0) {
    throw new EvidenceReadFailure({
      code: "reader_contract_invalid",
      message: `Registered ${input.site}.${input.commandName} reader requires unsupported capabilities: ${uncontainedCapabilities.join(", ")}.`,
      suggestion:
        "Declare only the bounded evidence-reader capability set or remove this reader route.",
    });
  }
  const invocation = buildInvocation(
    "cli",
    input.site,
    input.commandName,
    { args, source: "internal" },
    { approved: true, signal: input.signal },
  );
  if (!invocation) {
    throw new EvidenceReadFailure({
      code: "reader_unavailable",
      message: `Could not build ${input.site}.${input.commandName} invocation.`,
      suggestion: `Inspect \`unicli describe ${input.site} ${input.commandName}\`.`,
    });
  }
  const result = await execute(invocation);
  input.callerSignal?.throwIfAborted();
  if (result.error) {
    throw new EvidenceReadFailure({
      code: result.error.code,
      message: result.error.message,
      suggestion:
        result.error.suggestion ??
        `Repair or retry ${input.site}.${input.commandName}.`,
      retryable: result.error.retryable ?? false,
      alternatives: result.error.alternatives,
    });
  }
  return result.results;
}

async function readGithubThread(
  parsedUrl: URL,
  match: RegExpExecArray,
  options: Required<
    Pick<ReadEvidenceOptions, "maxChars" | "maxLinks" | "representation">
  > & { signal?: AbortSignal },
): Promise<EvidenceDocument> {
  if (options.representation === "html") {
    throw new EvidenceReadFailure({
      code: "unsupported_representation",
      message:
        "Structured GitHub threads do not have a raw HTML representation.",
      suggestion: "Use --as markdown or --as text for structured threads.",
    });
  }
  const commandName = match[3] === "issues" ? "issue-thread" : "pr-thread";
  const rows = await executeReaderCommand({
    site: "gh",
    commandName,
    args: { ref: parsedUrl.toString() },
    signal: boundedSignal(options.signal, DIRECT_READ_TIMEOUT_MS),
    callerSignal: options.signal,
  });
  const thread = rows.find(
    (value): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value),
  );
  if (!thread) {
    throw new EvidenceReadFailure({
      code: "empty_result",
      message: `gh.${commandName} returned no structured thread.`,
      suggestion: "Verify that the GitHub issue or pull request still exists.",
    });
  }
  const content = JSON.stringify(thread, null, 2);
  const title = typeof thread.title === "string" ? thread.title : "";
  return structureEvidenceDocument({
    sourceUrl: parsedUrl.toString(),
    content,
    outline: title ? `# ${title}` : content,
    contentType: "application/vnd.github+json",
    contentFormat: "github-thread",
    sourceAdapter: "gh",
    sourceCommand: commandName,
    reader: "github-api",
    retrievedAt: new Date().toISOString(),
    maxChars: options.maxChars,
    maxLinks: options.maxLinks,
    structuredData: thread,
  });
}

async function readPdf(
  parsedUrl: URL,
  options: Required<
    Pick<
      ReadEvidenceOptions,
      "maxChars" | "maxLinks" | "representation" | "firstPage" | "lastPage"
    >
  > & { signal?: AbortSignal },
): Promise<EvidenceDocument> {
  if (options.representation === "html") {
    throw new EvidenceReadFailure({
      code: "unsupported_representation",
      message: "PDF extraction cannot produce source HTML.",
      suggestion: "Use --as markdown or --as text for PDF text extraction.",
    });
  }
  const output = mkdtempSync(join(tmpdir(), "unicli-evidence-pdf-"));
  try {
    const results = await executeReaderCommand({
      site: "scholar-artifacts",
      commandName: "read-pdf",
      args: {
        pdf_url: parsedUrl.toString(),
        output,
        "first-page": options.firstPage,
        "last-page": options.lastPage,
        "max-chars": options.maxChars,
      },
      signal: boundedSignal(options.signal, PDF_READ_TIMEOUT_MS),
      callerSignal: options.signal,
      ephemeralOutput: { argument: "output", root: output },
    });
    const artifact = results.find(
      (value): value is Record<string, unknown> =>
        typeof value === "object" && value !== null && !Array.isArray(value),
    );
    const text = typeof artifact?.text === "string" ? artifact.text : "";
    if (!text.trim()) {
      throw new EvidenceReadFailure({
        code: "empty_result",
        message: "PDF extraction returned no text.",
        suggestion:
          "Choose a text-bearing page range; OCR-only PDFs are not supported by this reader.",
      });
    }
    const textChars =
      typeof artifact?.text_chars === "number"
        ? artifact.text_chars
        : text.length;
    return structureEvidenceDocument({
      sourceUrl: parsedUrl.toString(),
      content: text,
      contentType: "application/pdf",
      contentFormat: "pdf-text",
      sourceAdapter: "scholar-artifacts",
      sourceCommand: "read-pdf",
      reader: "pdftotext",
      retrievedAt: new Date().toISOString(),
      maxChars: options.maxChars,
      maxLinks: options.maxLinks,
      originalCharCount: textChars,
      pageRange: { first: options.firstPage, last: options.lastPage },
      textChars,
      textTruncated:
        typeof artifact?.text_truncated === "boolean"
          ? artifact.text_truncated
          : text.length > options.maxChars,
    });
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}

async function readProviderMarkdown(
  parsedUrl: URL,
  reader: Exclude<EvidenceReader, "direct">,
  options: Required<
    Pick<ReadEvidenceOptions, "maxChars" | "maxLinks" | "representation">
  > & { signal?: AbortSignal },
): Promise<EvidenceDocument> {
  if (options.representation === "html") {
    throw new EvidenceReadFailure({
      code: "unsupported_representation",
      message: `${reader} returns a derived document, not source HTML.`,
      suggestion:
        "Use --as markdown or choose --reader direct for source HTML.",
    });
  }
  const results = await executeReaderCommand({
    site: reader,
    commandName: "read",
    args: { url: parsedUrl.toString() },
    signal: boundedSignal(options.signal, DIRECT_READ_TIMEOUT_MS),
    callerSignal: options.signal,
  });
  const markdown = results
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean)
    .join("\n\n");
  if (!markdown) {
    throw new EvidenceReadFailure({
      code: "empty_result",
      message: `${reader}.read returned no document content.`,
      suggestion: `Inspect \`unicli repair ${reader} read\` or choose the direct reader.`,
    });
  }
  const content =
    options.representation === "text"
      ? markdown
          .replace(/^#{1,6}\s+/gm, "")
          .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
          .trim()
      : markdown;
  return structureEvidenceDocument({
    sourceUrl: parsedUrl.toString(),
    content,
    outline: markdown,
    contentType: "text/markdown",
    contentFormat: options.representation,
    sourceAdapter: reader,
    sourceCommand: "read",
    reader,
    retrievedAt: new Date().toISOString(),
    maxChars: options.maxChars,
    maxLinks: options.maxLinks,
  });
}

function plainTextFromHtml(html: string): string {
  return htmlToMarkdown(html)
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/!\[([^\]]*)]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/[*_~`>|]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function directContent(input: {
  text: string;
  contentType: string;
  representation: EvidenceRepresentation;
  url: string;
}): {
  content: string;
  outline: string;
  contentFormat: "markdown" | "text" | "html" | "json" | "xml";
  structuredData?: unknown;
} {
  if (/^(?:text\/html|application\/xhtml\+xml)$/i.test(input.contentType)) {
    if (isHtmlVerificationChallenge(input.text)) {
      throw new EvidenceReadFailure({
        code: "challenge_required",
        message:
          "The upstream returned a browser-verification challenge instead of document content.",
        suggestion: `Complete verification for ${new URL(input.url).hostname} in a shared browser session or use a source-specific API.`,
      });
    }
    const markdown = htmlToMarkdown(input.text);
    if (isDynamicDocumentShell(input.text, markdown)) {
      throw new EvidenceReadFailure({
        code: "dynamic_content_required",
        message:
          "The upstream returned an unrendered application shell instead of the requested document.",
        suggestion: `Use a registered API or browser reader for ${new URL(input.url).hostname}; the static response does not contain the document body.`,
      });
    }
    if (!markdown.trim()) {
      throw new EvidenceReadFailure({
        code: "empty_result",
        message: "HTML conversion returned no document content.",
        suggestion: "Use a source-specific API or a browser-rendered reader.",
      });
    }
    return {
      content:
        input.representation === "html"
          ? input.text
          : input.representation === "text"
            ? plainTextFromHtml(input.text)
            : markdown,
      outline: markdown,
      contentFormat: input.representation,
    };
  }

  if (
    /^(?:application\/(?:json|[^;]+\+json)|text\/json)$/i.test(
      input.contentType,
    )
  ) {
    if (input.representation === "html") {
      throw new EvidenceReadFailure({
        code: "unsupported_representation",
        message: "JSON evidence does not have an HTML representation.",
        suggestion: "Use --as markdown or --as text.",
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.text);
    } catch {
      throw new EvidenceReadFailure({
        code: "invalid_content",
        message: "The response declared JSON but the body is not valid JSON.",
        suggestion:
          "Inspect the source-specific API response and content type.",
      });
    }
    const content = JSON.stringify(parsed, null, 2);
    return {
      content,
      outline: content,
      contentFormat: "json",
      structuredData: parsed,
    };
  }

  if (
    /^(?:application\/(?:xml|[^;]+\+xml)|text\/xml)$/i.test(input.contentType)
  ) {
    return {
      content: input.text,
      outline: input.text,
      contentFormat: "xml",
    };
  }

  const isMarkdown = /(?:markdown|mdown)/i.test(input.contentType);
  return {
    content: input.text,
    outline: input.text,
    contentFormat: isMarkdown ? "markdown" : "text",
  };
}

export async function readEvidenceDocument(
  rawUrl: string,
  options: ReadEvidenceOptions = {},
): Promise<EvidenceDocument> {
  options.signal?.throwIfAborted();
  const parsedUrl = parseHttpUrl(rawUrl);
  const maxChars = positiveInteger(
    options.maxChars,
    100_000,
    1_000_000,
    "max_chars",
  );
  const maxLinks = positiveInteger(options.maxLinks, 100, 1_000, "max_links");
  const firstPage = positiveInteger(
    options.firstPage,
    1,
    100_000,
    "first_page",
  );
  const lastPage = positiveInteger(options.lastPage, 20, 100_000, "last_page");
  if (lastPage < firstPage) {
    throw new EvidenceReadFailure({
      code: "invalid_input",
      message: "last_page must be greater than or equal to first_page.",
      suggestion: "Choose an inclusive PDF page range.",
    });
  }
  const reader = options.reader ?? "direct";
  const representation = options.representation ?? "markdown";
  const common = {
    maxChars,
    maxLinks,
    representation,
    firstPage,
    lastPage,
    signal: options.signal,
  };

  const githubThreadMatch =
    parsedUrl.hostname.toLowerCase() === "github.com"
      ? /^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)\/?$/.exec(parsedUrl.pathname)
      : null;
  if (githubThreadMatch) {
    return readGithubThread(parsedUrl, githubThreadMatch, common);
  }
  if (/\.pdf(?:$|[?#])/i.test(parsedUrl.toString())) {
    return readPdf(parsedUrl, common);
  }
  if (reader !== "direct") {
    return readProviderMarkdown(parsedUrl, reader, common);
  }

  let resource;
  try {
    resource = await fetchTextResource(
      parsedUrl.toString(),
      { url: parsedUrl.toString(), method: "GET" },
      {
        Accept:
          "text/html,application/xhtml+xml,application/json,application/xml,text/plain,text/markdown;q=0.9,*/*;q=0.1",
      },
      -1,
      { signal: boundedSignal(options.signal, DIRECT_READ_TIMEOUT_MS) },
    );
  } catch (error) {
    if (
      error instanceof PipelineError &&
      error.detail.errorType === "unsupported_content_type" &&
      /application\/pdf/i.test(error.message)
    ) {
      return readPdf(parsedUrl, common);
    }
    throw error;
  }

  const rendered = directContent({
    text: resource.text,
    contentType: resource.contentType || "text/plain",
    representation,
    url: resource.finalUrl,
  });
  return structureEvidenceDocument({
    sourceUrl: parsedUrl.toString(),
    finalUrl: resource.finalUrl,
    content: rendered.content,
    outline: rendered.outline,
    contentType: resource.contentType || "text/plain",
    contentFormat: rendered.contentFormat,
    sourceAdapter: "web",
    sourceCommand: "read",
    reader: "direct",
    retrievedAt: new Date().toISOString(),
    maxChars,
    maxLinks,
    httpStatus: resource.status,
    structuredData: rendered.structuredData,
  });
}

export function evidenceRetryCommand(url: string): string {
  return `unicli extract ${shellQuote(url)}`;
}
