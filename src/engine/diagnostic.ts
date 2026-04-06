/**
 * RepairContext Diagnostic Module — structured error context for agent self-repair.
 *
 * When UNICLI_DIAGNOSTIC=1, pipeline failures emit a RepairContext JSON block
 * to stderr, giving agents everything they need to diagnose and fix the adapter:
 *   - Error details with hints
 *   - Full adapter source (YAML/TS)
 *   - Browser page state (URL, DOM snapshot, network, console errors)
 */

import { readFileSync } from "node:fs";
import { ExitCode } from "../types.js";
import type { BrowserPage } from "../browser/page.js";

export interface RepairContext {
  error: {
    code: string;
    message: string;
    hint?: string;
    stack?: string;
  };
  adapter: {
    site: string;
    command: string;
    sourcePath?: string;
    source?: string;
  };
  page?: {
    url: string;
    snapshot: string;
    networkRequests: Array<{
      url: string;
      method: string;
      status: number;
      type: string;
      headers?: Record<string, string>;
      body?: unknown;
    }>;
    consoleErrors: string[];
  };
  timestamp: string;
}

/** Map ExitCode numeric values to their symbolic names. */
const EXIT_CODE_NAMES: Record<number, string> = {};
for (const [name, code] of Object.entries(ExitCode)) {
  EXIT_CODE_NAMES[code] = name;
}

// ── Size limits ───────────────────────────────────────────────────────

export const MAX_DIAGNOSTIC_BYTES = 256 * 1024;
const STACK_TRACE_MAX = 5000;
const ADAPTER_SOURCE_MAX = 50_000;

// ── Sensitive patterns ────────────────────────────────────────────────

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "proxy-authorization",
  "x-csrf-token",
  "x-client-data",
]);

const SENSITIVE_PARAMS = new Set([
  "access_token",
  "api_key",
  "auth",
  "authenticity_token",
  "client_id",
  "client_secret",
  "code",
  "code_challenge",
  "code_verifier",
  "csrf",
  "id_token",
  "key",
  "password",
  "refresh_token",
  "secret",
  "session",
  "state",
  "token",
]);

const JWT_REGEX =
  /\b(ey[A-Za-z0-9\-_=]+)\.(ey[A-Za-z0-9\-_=]+)\.[A-Za-z0-9\-_.+/=]+\b/g;

// ── Redaction functions ───────────────────────────────────────────────

/**
 * Redact sensitive HTTP headers, replacing values with [REDACTED].
 * Case-insensitive match. Returns a new object (does not mutate input).
 */
export function redactHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = SENSITIVE_HEADERS.has(key.toLowerCase())
      ? "[REDACTED]"
      : value;
  }
  return result;
}

/**
 * Redact sensitive query parameters from a URL.
 * Case-insensitive match against SENSITIVE_PARAMS.
 * Handles both absolute and relative URLs.
 * Returns the sanitized URL string, or the original on parse failure.
 */
export function redactUrl(url: string): string {
  let parsed: URL;
  let isRelative = false;
  const PLACEHOLDER = "http://placeholder";

  try {
    parsed = new URL(url);
  } catch {
    // Try treating it as a relative URL
    try {
      parsed = new URL(url, PLACEHOLDER);
      isRelative = true;
    } catch {
      return url;
    }
  }

  let modified = false;
  for (const [key, value] of parsed.searchParams.entries()) {
    if (SENSITIVE_PARAMS.has(key.toLowerCase()) && value !== "[REDACTED]") {
      parsed.searchParams.set(key, "[REDACTED]");
      modified = true;
    }
  }

  if (!modified) return url;

  if (isRelative) {
    // Strip the placeholder origin to reconstruct as a relative URL
    const full = parsed.toString();
    return full.startsWith(PLACEHOLDER) ? full.slice(PLACEHOLDER.length) : full;
  }

  return parsed.toString();
}

/**
 * Redact JWT signatures in a string.
 * Preserves header.payload for debugging, strips the signature component.
 */
export function redactJwt(text: string): string {
  return text.replace(JWT_REGEX, "$1.$2.[sig-redacted]");
}

/**
 * Recursively redact sensitive keys from a body value.
 * - String: apply JWT redaction
 * - Object: redact values of keys matching SENSITIVE_PARAMS, recurse
 * - Array: map each element recursively
 * Returns a new structure (does not mutate input).
 */
export function redactBody(body: unknown): unknown {
  return _redactBody(body, new WeakSet());
}

function _redactBody(body: unknown, seen: WeakSet<object>): unknown {
  if (typeof body === "string") {
    return redactJwt(body);
  }

  if (Array.isArray(body)) {
    if (seen.has(body)) return "[circular]";
    seen.add(body);
    return body.map((item) => _redactBody(item, seen));
  }

  if (body !== null && typeof body === "object") {
    if (seen.has(body)) return "[circular]";
    seen.add(body);
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(
      body as Record<string, unknown>,
    )) {
      result[key] = SENSITIVE_PARAMS.has(key.toLowerCase())
        ? "[REDACTED]"
        : _redactBody(value, seen);
    }
    return result;
  }

  return body;
}

/**
 * Apply all redaction passes to a RepairContext.
 * Returns a new context (does not mutate input).
 */
export function redactRepairContext(ctx: RepairContext): RepairContext {
  const result: RepairContext = {
    error: {
      ...ctx.error,
      message: redactUrl(ctx.error.message),
      stack: ctx.error.stack ? redactJwt(ctx.error.stack) : undefined,
    },
    adapter: {
      ...ctx.adapter,
      sourcePath: ctx.adapter.sourcePath
        ? redactUrl(ctx.adapter.sourcePath)
        : undefined,
    },
    timestamp: ctx.timestamp,
  };

  if (ctx.page) {
    result.page = {
      url: redactUrl(ctx.page.url),
      snapshot: redactJwt(ctx.page.snapshot),
      consoleErrors: ctx.page.consoleErrors.map((e) => redactJwt(e)),
      networkRequests: ctx.page.networkRequests.map((req) => ({
        ...req,
        url: redactUrl(req.url),
        headers: req.headers ? redactHeaders(req.headers) : undefined,
        body: req.body !== undefined ? redactBody(req.body) : undefined,
      })),
    };
  }

  return result;
}

// ── Internal helpers ──────────────────────────────────────────────────

/**
 * Resolve a human-readable error code name from an Error instance.
 * PipelineError has errorType; generic errors map to GENERIC_ERROR.
 */
function resolveErrorCode(err: Error): string {
  // PipelineError carries a detail.errorType
  if ("detail" in err) {
    const detail = (err as { detail?: { errorType?: string } }).detail;
    if (detail?.errorType) return detail.errorType.toUpperCase();
  }
  return EXIT_CODE_NAMES[ExitCode.GENERIC_ERROR] ?? "GENERIC_ERROR";
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Build a RepairContext from a pipeline error and execution context.
 */
export async function buildRepairContext(opts: {
  error: Error;
  site: string;
  command: string;
  adapterPath?: string;
  page?: BrowserPage;
}): Promise<RepairContext> {
  const { error, site, command, adapterPath, page } = opts;

  // 1. Error section
  const hint =
    "detail" in error
      ? ((error as { detail?: { errorType?: string } }).detail?.errorType ??
        undefined)
      : undefined;

  let stack = error.stack;
  if (stack && stack.length > STACK_TRACE_MAX) {
    stack = stack.slice(0, STACK_TRACE_MAX) + "...[truncated]";
  }

  const errorSection: RepairContext["error"] = {
    code: resolveErrorCode(error),
    message: error.message,
    hint,
    stack,
  };

  // 2. Adapter section
  const adapterSection: RepairContext["adapter"] = {
    site,
    command,
    sourcePath: adapterPath,
  };

  if (adapterPath) {
    try {
      let source = readFileSync(adapterPath, "utf-8");
      if (source.length > ADAPTER_SOURCE_MAX) {
        source = source.slice(0, ADAPTER_SOURCE_MAX) + "...[truncated]";
      }
      adapterSection.source = source;
    } catch {
      // File may not exist or be unreadable
    }
  }

  // 3. Page diagnostics (only when UNICLI_DIAGNOSTIC=1 and page is available)
  let pageSection: RepairContext["page"] | undefined;
  if (page && process.env.UNICLI_DIAGNOSTIC === "1") {
    try {
      const [url, snapshot, networkRequests, consoleRaw] = await Promise.all([
        page.url(),
        page.snapshot({ compact: true }).catch(() => "(snapshot unavailable)"),
        page
          .networkRequests()
          .then((reqs) =>
            reqs.map((r) => ({
              url: r.url,
              method: r.method,
              status: r.status,
              type: r.type,
            })),
          )
          .catch(
            () =>
              [] as Array<{
                url: string;
                method: string;
                status: number;
                type: string;
              }>,
          ),
        page
          .evaluate("JSON.stringify(window.__unicli_console_errors || [])")
          .catch(() => "[]"),
      ]);

      let consoleErrors: string[] = [];
      try {
        consoleErrors = JSON.parse(String(consoleRaw)) as string[];
      } catch {
        // Ignore parse failure
      }

      pageSection = { url, snapshot, networkRequests, consoleErrors };
    } catch {
      // Page diagnostics are best-effort
    }
  }

  return {
    error: errorSection,
    adapter: adapterSection,
    page: pageSection,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Returns true when UNICLI_DIAGNOSTIC env var is set to "1".
 */
export function isDiagnosticEnabled(): boolean {
  return process.env.UNICLI_DIAGNOSTIC === "1";
}

/**
 * Emit RepairContext to stderr wrapped in markers for machine parsing.
 * Applies redaction, then progressive size degradation if the payload
 * exceeds thresholds.
 */
export function emitRepairContext(ctx: RepairContext): void {
  const marker = "___UNICLI_DIAGNOSTIC___";

  // Apply security redaction first
  let redacted = redactRepairContext(ctx);

  let json = JSON.stringify(redacted, null, 2);

  // Progressive size degradation
  if (json.length > 128 * 1024) {
    // Stage 1: strip snapshot and network request bodies
    if (redacted.page) {
      redacted = {
        ...redacted,
        page: {
          ...redacted.page,
          snapshot: "(removed: size limit)",
          networkRequests: redacted.page.networkRequests.map((r) => ({
            url: r.url,
            method: r.method,
            status: r.status,
            type: r.type,
            headers: r.headers,
            // body omitted
          })),
        },
      };
    }
    json = JSON.stringify(redacted, null, 2);
  }

  if (json.length > 192 * 1024) {
    // Stage 2: remove entire page object
    redacted = { ...redacted, page: undefined };
    json = JSON.stringify(redacted, null, 2);
  }

  if (json.length > MAX_DIAGNOSTIC_BYTES) {
    // Stage 3: hard truncate — wrap in a valid JSON envelope so output is always parseable
    const truncated = json.slice(0, MAX_DIAGNOSTIC_BYTES - 100);
    json = JSON.stringify({ _truncated: true, _originalSize: json.length, partial: truncated });
  }

  process.stderr.write(`\n${marker}\n${json}\n${marker}\n`);
}
