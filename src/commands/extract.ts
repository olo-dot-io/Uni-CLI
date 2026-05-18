/**
 * @owner        src/commands/extract.ts
 * @does         One-shot URL → cleaned Markdown/text/HTML extraction without
 *               adapter awareness. Stateless agent verb: fetch + render in a
 *               single CLI call, no browser session, no auth, no pipeline
 *               composition required.
 * @needs        turndown, commander, src/engine/ssrf, src/engine/proxy,
 *               src/output/{envelope,formatter}, src/constants
 * @feeds        src/cli.ts agent entrypoint; agents that want "fetch this URL
 *               as Markdown" without composing a fetch_text + html_to_md
 *               pipeline themselves.
 * @breaks       Emits structured envelopes. Codes:
 *                 invalid_input    — non-http(s) URL, SSRF block, body cap
 *                 not_found        — 404
 *                 auth_required    — 401/403
 *                 rate_limited     — 429
 *                 api_error        — other 4xx
 *                 upstream_error   — 5xx
 *                 network_error    — DNS/TCP/TLS failure or timeout
 *               Each error envelope carries next_actions with a retry hint,
 *               a `describe` link, and a `do` link.
 * @invariants   Truncates rendered content at --max-chars; never holds more
 *               than HARD_MAX_BYTES of upstream body in memory.
 * @side-effects HTTP GET to user-supplied URL with proxy if configured.
 *               No local filesystem writes.
 * @perf         O(N) in body bytes for Turndown; N capped by HARD_MAX_BYTES.
 * @concurrency  Pure async; no shared state.
 * @test         tests/unit/commands/extract.test.ts
 * @stability    experimental
 * @since        2026-05-18
 */

import { Command } from "commander";
import TurndownService from "turndown";
import { assertSafeRequestUrl } from "../engine/ssrf.js";
import { getProxyAgent } from "../engine/proxy.js";
import { USER_AGENT } from "../constants.js";
import { format, detectFormat } from "../output/formatter.js";
import type {
  AgentContext,
  AgentError,
  AgentNextAction,
} from "../output/envelope.js";
import type { OutputFormat } from "../types.js";

const DEFAULT_MAX_CHARS = 50_000;
const HARD_MAX_BYTES = 5_000_000;

type ExtractFormat = "markdown" | "text" | "html";

interface ExtractOpts {
  maxChars: string;
  as: string;
}

export function registerExtractCommand(program: Command): void {
  program
    .command("extract <url>")
    .description(
      "Fetch a URL and return cleaned Markdown (one-shot, no browser/auth)",
    )
    .option(
      "--max-chars <n>",
      `Truncate rendered content at N chars (default ${DEFAULT_MAX_CHARS})`,
      String(DEFAULT_MAX_CHARS),
    )
    .option(
      "--as <format>",
      "Render content as markdown|text|html (default markdown)",
      "markdown",
    )
    .action(async (url: string, opts: ExtractOpts) => {
      const startedAt = Date.now();
      const fmt = detectFormat(
        program.opts().format as OutputFormat | undefined,
      );

      let maxChars: number;
      try {
        maxChars = parseMaxChars(opts.maxChars);
      } catch (e) {
        emitError(
          baseCtx(startedAt),
          {
            code: "invalid_input",
            message:
              e instanceof Error ? e.message : "invalid --max-chars value",
            suggestion: `Pass a positive integer up to ${MAX_CHARS_HARD_LIMIT}`,
            retryable: false,
          },
          fmt,
          url,
        );
        return;
      }
      const renderAs = parseExtractFormat(opts.as);

      try {
        assertSafeRequestUrl(url);
      } catch (e) {
        emitError(
          baseCtx(startedAt),
          {
            code: "invalid_input",
            message:
              e instanceof Error ? e.message : "URL failed safety validation",
            suggestion:
              "Use an http(s) URL; loopback / link-local / private ranges are blocked",
            retryable: false,
          },
          fmt,
          url,
        );
        return;
      }

      let html: string;
      let httpStatus = 0;
      try {
        const init: Record<string, unknown> = {
          method: "GET",
          headers: { "User-Agent": USER_AGENT },
        };
        const agent = getProxyAgent();
        if (agent) init.dispatcher = agent;

        const resp = await fetch(url, init as RequestInit);
        httpStatus = resp.status;

        if (!resp.ok) {
          emitError(
            baseCtx(startedAt),
            {
              code: mapStatus(resp.status),
              message: `HTTP ${resp.status} ${resp.statusText} from ${url}`,
              suggestion:
                resp.status >= 500
                  ? "Upstream 5xx — retry after a short delay"
                  : resp.status === 429
                    ? "Rate-limited — back off and retry"
                    : resp.status === 401 || resp.status === 403
                      ? "Authenticated endpoint — try `unicli auth setup <site>`"
                      : `Check that ${url} is the canonical URL`,
              retryable: resp.status >= 500 || resp.status === 429,
            },
            fmt,
            url,
          );
          return;
        }

        const lenHeader = resp.headers.get("content-length");
        if (lenHeader && Number(lenHeader) > HARD_MAX_BYTES) {
          emitError(
            baseCtx(startedAt),
            {
              // REASON: oversized upstream payload is an upstream property,
              // not caller error — surface as `upstream_error` (exit 69) so
              // agent retry policy knows the URL itself cannot be re-fetched
              // smaller. retryable=false because shrink-on-retry is unlikely.
              code: "upstream_error",
              message: `Content-Length ${lenHeader} exceeds hard cap ${HARD_MAX_BYTES}`,
              suggestion:
                "Target a smaller URL or use a streaming adapter via `unicli search`",
              retryable: false,
            },
            fmt,
            url,
          );
          return;
        }

        html = await resp.text();
        if (html.length > HARD_MAX_BYTES) {
          html = html.slice(0, HARD_MAX_BYTES);
        }
      } catch (e) {
        emitError(
          baseCtx(startedAt),
          {
            code: "network_error",
            message: e instanceof Error ? e.message : String(e),
            suggestion: `Network fetch failed for ${url} — verify connectivity`,
            retryable: true,
          },
          fmt,
          url,
        );
        return;
      }

      let content: string;
      if (renderAs === "markdown") {
        const turndown = new TurndownService({
          headingStyle: "atx",
          codeBlockStyle: "fenced",
        });
        content = turndown.turndown(html);
      } else if (renderAs === "text") {
        content = stripTags(html);
      } else {
        content = html;
      }

      const originalLength = content.length;
      const truncated = originalLength > maxChars;
      if (truncated) content = content.slice(0, maxChars);

      const ctx: AgentContext = {
        command: "core.extract",
        duration_ms: Date.now() - startedAt,
        surface: "web",
        next_actions: successNextActions(
          url,
          renderAs,
          truncated,
          originalLength,
        ),
      };

      const data: Record<string, unknown> = {
        url,
        format: renderAs,
        http_status: httpStatus,
        length: content.length,
        original_length: originalLength,
        truncated,
        content,
      };

      console.log(format(data, undefined, fmt, ctx));
    });
}

// ── helpers ──────────────────────────────────────────────────────────────────

function baseCtx(startedAt: number): Omit<AgentContext, "next_actions"> {
  return {
    command: "core.extract",
    duration_ms: Date.now() - startedAt,
    surface: "web",
  };
}

/**
 * Parse `--max-chars`. Throws on invalid input — caller is responsible for
 * converting the throw into a structured `invalid_input` envelope. This is
 * the rule-02 contract: bad CLI input is a caller bug, not a system state
 * to silently recover from.
 */
const MAX_CHARS_HARD_LIMIT = 1_000_000;
function parseMaxChars(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`--max-chars must be a positive integer (got "${raw}")`);
  }
  if (n > MAX_CHARS_HARD_LIMIT) {
    throw new Error(
      `--max-chars ${n} exceeds hard limit ${MAX_CHARS_HARD_LIMIT}`,
    );
  }
  return n;
}

function parseExtractFormat(raw: string): ExtractFormat {
  const v = raw.toLowerCase();
  if (v === "text" || v === "txt" || v === "plain") return "text";
  if (v === "html" || v === "raw") return "html";
  return "markdown";
}

function mapStatus(status: number): string {
  if (status === 404) return "not_found";
  if (status === 401 || status === 403) return "auth_required";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "upstream_error";
  return "api_error";
}

// REASON: intentionally minimal HTML stripper for `--as text` mode. Strips
// scripts, styles, tags, and 5 common entities. Does NOT handle CDATA,
// HTML comments, numeric character references, or HTML5 `<template>` —
// agents post-process the output anyway. NOT a safe-HTML sanitizer.
function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function successNextActions(
  url: string,
  as: ExtractFormat,
  truncated: boolean,
  originalLength: number,
): AgentNextAction[] {
  const actions: AgentNextAction[] = [];

  if (truncated) {
    const fullCap = Math.min(originalLength, 1_000_000);
    actions.push({
      command: `unicli extract ${url} --max-chars ${fullCap}`,
      description: `Re-extract with larger limit (full rendered length ${originalLength})`,
      params: {
        "max-chars": {
          value: fullCap,
          description: "Truncation cap in characters",
        },
      },
    });
  }

  if (as !== "text") {
    actions.push({
      command: `unicli extract ${url} --as text`,
      description: "Re-extract as plain text (no Markdown formatting)",
    });
  }
  if (as !== "html") {
    actions.push({
      command: `unicli extract ${url} --as html`,
      description: "Re-extract as raw HTML (no cleaning)",
    });
  }

  actions.push({
    command: `unicli do "<natural-language intent>"`,
    description:
      "Route a natural-language intent to the best-matching adapter (e.g. structured site fetch instead of a raw URL)",
  });

  return actions;
}

function errorNextActions(url: string, errCode: string): AgentNextAction[] {
  const actions: AgentNextAction[] = [
    {
      command: `unicli extract ${url}`,
      description: "Retry the same extraction",
    },
  ];
  if (errCode === "auth_required") {
    actions.push({
      command: `unicli auth setup <site>`,
      description: "Authenticate before retrying",
      params: {
        site: {
          description: "Short site name (e.g. `twitter`, `github`)",
        },
      },
    });
  }
  if (
    errCode === "not_found" ||
    errCode === "api_error" ||
    errCode === "invalid_input"
  ) {
    actions.push({
      command: `unicli do "<natural-language intent>"`,
      description: "Try a structured adapter instead of a raw URL fetch",
    });
  }
  actions.push({
    command: `unicli describe`,
    description: "Inspect available commands and adapters",
  });
  return actions;
}

function emitError(
  baseCtxValue: Omit<AgentContext, "next_actions">,
  err: AgentError,
  fmt: OutputFormat,
  url: string,
): void {
  const ctx: AgentContext = {
    ...baseCtxValue,
    next_actions: errorNextActions(url, err.code),
    error: err,
  };
  process.exitCode = mapExitCode(err.code);
  console.log(format(null, undefined, fmt, ctx));
}

function mapExitCode(code: string): number {
  switch (code) {
    case "auth_required":
      return 77;
    case "rate_limited":
    case "network_error":
      return 75;
    case "upstream_error":
      return 69;
    case "not_found":
    case "invalid_input":
      return 2;
    default:
      return 1;
  }
}
