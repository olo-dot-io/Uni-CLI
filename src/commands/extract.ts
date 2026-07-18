/**
 * @owner       src::commands::extract
 * @does        Exposes the domain-neutral, one-shot URL-to-EvidenceDocument reader as a stable CLI verb.
 * @needs       commander, evidence-reader, shared envelope formatter, and shared error mapping
 * @feeds       agents that need current web evidence without knowing a domain-specific adapter
 * @breaks      Diverging from ai.read, treating SPA shells or binary bytes as success, or omitting provenance makes cross-domain research unreliable.
 * @invariants  Success emits the shared EvidenceDocument contract plus legacy length/format aliases; all failures use structured, actionable envelopes; rendered output is capped at one million characters.
 * @side-effects Performs the reader-selected network/API operation; PDF reads may create and remove one invocation-local temporary directory.
 * @perf        Direct bodies are bounded by the shared five MB fetch cap and rendered content by --max-chars.
 * @concurrency Invocation state is local; cancellation is owned by the command process.
 * @test        tests/unit/commands/extract.test.ts, tests/unit/engine/evidence-document.test.ts
 * @stability   experimental
 * @since       2026-05-18
 */

import { Command } from "commander";

import {
  readEvidenceDocument,
  type EvidenceReader,
  type EvidenceRepresentation,
} from "../engine/evidence-reader.js";
import { errorToAgentFields, errorTypeToCode } from "../output/error-map.js";
import { printErrorEnvelope } from "../output/error-writer.js";
import type {
  AgentContext,
  AgentError,
  AgentNextAction,
} from "../output/envelope.js";
import { detectFormat, format } from "../output/formatter.js";
import type { OutputFormat } from "../types.js";

const DEFAULT_MAX_CHARS = 50_000;
const DEFAULT_MAX_LINKS = 100;
const MAX_CHARS_HARD_LIMIT = 1_000_000;
const MAX_LINKS_HARD_LIMIT = 1_000;
const MAX_PAGE = 100_000;

interface ExtractOpts {
  maxChars: string;
  maxLinks: string;
  as: string;
  reader: string;
  firstPage: string;
  lastPage: string;
}

export function registerExtractCommand(program: Command): void {
  program
    .command("extract <url>")
    .description(
      "Read a URL into a provenance-bearing EvidenceDocument (HTML, JSON, text, PDF, or GitHub thread)",
    )
    .option(
      "--max-chars <n>",
      `Truncate rendered content at N chars (default ${DEFAULT_MAX_CHARS})`,
      String(DEFAULT_MAX_CHARS),
    )
    .option(
      "--max-links <n>",
      `Retain at most N structured links (default ${DEFAULT_MAX_LINKS})`,
      String(DEFAULT_MAX_LINKS),
    )
    .option(
      "--as <format>",
      "Represent HTML as markdown|text|html (default markdown)",
      "markdown",
    )
    .option(
      "--reader <reader>",
      "Use direct|jina|defuddle; non-direct readers receive the source URL",
      "direct",
    )
    .option("--first-page <n>", "First PDF page to extract", "1")
    .option("--last-page <n>", "Last PDF page to extract", "20")
    .action(async (url: string, opts: ExtractOpts) => {
      const startedAt = Date.now();
      const fmt = detectFormat(
        program.opts().format as OutputFormat | undefined,
      );

      let maxChars: number;
      let maxLinks: number;
      let firstPage: number;
      let lastPage: number;
      let representation: EvidenceRepresentation;
      let reader: EvidenceReader;
      try {
        maxChars = parsePositiveInteger(
          opts.maxChars,
          "--max-chars",
          MAX_CHARS_HARD_LIMIT,
        );
        maxLinks = parsePositiveInteger(
          opts.maxLinks,
          "--max-links",
          MAX_LINKS_HARD_LIMIT,
        );
        firstPage = parsePositiveInteger(
          opts.firstPage,
          "--first-page",
          MAX_PAGE,
        );
        lastPage = parsePositiveInteger(opts.lastPage, "--last-page", MAX_PAGE);
        if (lastPage < firstPage) {
          throw new Error(
            "--last-page must be greater than or equal to --first-page",
          );
        }
        representation = parseRepresentation(opts.as);
        reader = parseReader(opts.reader);
      } catch (error) {
        emitError(
          baseContext(startedAt),
          {
            code: "invalid_input",
            message:
              error instanceof Error ? error.message : "invalid extract option",
            suggestion:
              "Use positive numeric limits, an inclusive page range, --as markdown|text|html, and --reader direct|jina|defuddle.",
            retryable: false,
          },
          fmt,
          url,
        );
        return;
      }

      try {
        const document = await readEvidenceDocument(url, {
          maxChars,
          maxLinks,
          representation,
          reader,
          firstPage,
          lastPage,
        });
        const ctx: AgentContext = {
          command: "core.extract",
          duration_ms: Date.now() - startedAt,
          surface: "web",
          next_actions: successNextActions(
            url,
            representation,
            document.truncated,
            document.original_char_count,
          ),
        };
        const data: Record<string, unknown> = {
          ...document,
          format: document.content_format,
          length: document.char_count,
          original_length: document.original_char_count,
        };
        console.log(format(data, undefined, fmt, ctx));
      } catch (error) {
        const mappedCode = errorTypeToCode(error);
        const code =
          mappedCode === "response_too_large" ? "upstream_error" : mappedCode;
        const fields = errorToAgentFields(
          error,
          "src/commands/extract.ts",
          "web",
          "read",
          hostname(url),
        );
        emitError(
          baseContext(startedAt),
          {
            code,
            message: error instanceof Error ? error.message : String(error),
            ...fields,
          },
          fmt,
          url,
        );
      }
    });
}

function baseContext(startedAt: number): Omit<AgentContext, "next_actions"> {
  return {
    command: "core.extract",
    duration_ms: Date.now() - startedAt,
    surface: "web",
  };
}

function parsePositiveInteger(
  raw: string,
  label: string,
  maximum: number,
): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer (got "${raw}")`);
  }
  if (value > maximum) {
    throw new Error(`${label} ${value} exceeds hard limit ${maximum}`);
  }
  return value;
}

function parseRepresentation(raw: string): EvidenceRepresentation {
  const value = raw.toLowerCase();
  if (value === "markdown") return "markdown";
  if (value === "text") return "text";
  if (value === "html") return "html";
  throw new Error(`--as must be markdown, text, or html (got "${raw}")`);
}

function parseReader(raw: string): EvidenceReader {
  const value = raw.toLowerCase();
  if (value === "direct" || value === "jina" || value === "defuddle") {
    return value;
  }
  throw new Error(`--reader must be direct, jina, or defuddle (got "${raw}")`);
}

function hostname(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function successNextActions(
  url: string,
  representation: EvidenceRepresentation,
  truncated: boolean,
  originalLength: number,
): AgentNextAction[] {
  const quotedUrl = shellQuote(url);
  const actions: AgentNextAction[] = [];
  if (truncated) {
    const fullCap = Math.min(originalLength, MAX_CHARS_HARD_LIMIT);
    actions.push({
      command: `unicli extract ${quotedUrl} --max-chars ${fullCap}`,
      description: `Re-read with a larger limit (rendered length ${originalLength})`,
      params: {
        "max-chars": {
          value: fullCap,
          description: "Truncation cap in characters",
        },
      },
    });
  }
  if (representation !== "text") {
    actions.push({
      command: `unicli extract ${quotedUrl} --as text`,
      description: "Read as plain text",
    });
  }
  if (representation !== "html") {
    actions.push({
      command: `unicli extract ${quotedUrl} --as html`,
      description: "Read source HTML when that representation exists",
    });
  }
  actions.push({
    command: `unicli do "<natural-language intent>"`,
    description: "Route the intent to a source-specific structured adapter",
  });
  return actions;
}

function errorNextActions(url: string, error: AgentError): AgentNextAction[] {
  const actions: AgentNextAction[] = [
    {
      command: `unicli extract ${shellQuote(url)}`,
      description: "Retry the same evidence read",
    },
    ...(error.alternatives ?? []).map((command) => ({
      command,
      description: "Use a reader alternative supplied by the failed boundary",
    })),
  ];
  if (error.code === "auth_required") {
    actions.push({
      command: "unicli auth setup <site>",
      description: "Authenticate before retrying",
    });
  }
  actions.push({
    command: `unicli search ${shellQuote(`reader for ${hostname(url) ?? url}`)}`,
    description: "Discover a source-specific reader",
  });
  return actions;
}

function emitError(
  base: Omit<AgentContext, "next_actions">,
  error: AgentError,
  fmt: OutputFormat,
  url: string,
): void {
  printErrorEnvelope({
    fmt,
    exitCode: exitCodeFor(error.code),
    ctx: {
      ...base,
      next_actions: errorNextActions(url, error),
      error,
    },
  });
}

function exitCodeFor(code: string): number {
  if (code === "auth_required" || code === "challenge_required") return 77;
  if (code === "rate_limited" || code === "network_error") return 75;
  if (code === "upstream_error") return 69;
  if (code === "empty_result") return 66;
  if (code === "not_found" || code === "invalid_input") return 2;
  return 1;
}
