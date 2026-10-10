/**
 * @owner       src::transport::adapters::http
 * @does        Exposes cancellation-linearized JSON/text HTTP requests and transactional download through the uniform transport envelope contract.
 * @needs       canonical bounded text fetch, pipeline error taxonomy, core envelopes, transport types, download engine
 * @feeds       transport bus and public `@zenalexa/unicli/transport/http` export
 * @breaks      Treating post-dispatch write cancellation as retryable can replay an accepted HTTP mutation; dropped signals allow late network/file work.
 * @invariants  Safe reads cancel exactly; unsafe methods rejected by cancellation after dispatch are outcome-ambiguous; authoritative responses win late cancellation; downloads publish atomically.
 * @side-effects Performs HTTP I/O and optional destination-file writes.
 * @perf        Response previews are capped; downloads stream through the download engine.
 * @concurrency Each request owns its AbortSignal; one instance retains only its latest completed envelope/preview.
 * @test        tests/unit/transport/adapters/http.test.ts, tests/unit/proxy.test.ts
 * @stability   public
 * @since       2026-04-14
 */

import { USER_AGENT } from "../../constants.js";
import { err, exitCodeFor, ok } from "../../core/envelope.js";
import { PipelineError } from "../../engine/executor.js";
import {
  assertSafeRequestUrl,
  UnsafeRequestUrlError,
} from "../../engine/ssrf.js";
import { fetchTextResource } from "../../engine/steps/fetch-text.js";
import { mapErrorToExitCode } from "../../output/error-map.js";
import type { Envelope } from "../../core/envelope.js";
import {
  confirmedEffectVerdict,
  type EffectVerdict,
} from "../../core/effect-verdict.js";
import { settleDispatchedAction } from "../action-settlement.js";
import { isOperationOutcomeAmbiguousError } from "../contained-process.js";
import type {
  ActionRequest,
  ActionResult,
  Capability,
  Snapshot,
  SnapshotFormat,
  TransportAdapter,
  TransportContext,
  TransportKind,
} from "../types.js";

interface FetchParams {
  url?: unknown;
  method?: unknown;
  headers?: unknown;
  params?: unknown;
  body?: unknown;
  timeoutMs?: unknown;
}

/** Steps this transport declares support for. */
const HTTP_STEPS = [
  "fetch",
  "fetch_text",
  "parse_rss",
  "html_to_md",
  "download",
] as const;

const HTTP_CAPABILITY: Capability = {
  steps: HTTP_STEPS,
  snapshotFormats: ["json", "text"] as readonly SnapshotFormat[],
  mutatesHost: true,
};

/**
 * HttpTransport wraps Node's native `fetch` so the bus can route HTTP
 * pipeline steps through a uniform envelope contract.
 */
export class HttpTransport implements TransportAdapter {
  readonly kind: TransportKind = "http";
  readonly capability: Capability = HTTP_CAPABILITY;

  private ctx: TransportContext | undefined;
  private lastEnvelope: Envelope<unknown> | undefined;
  private lastBodyPreview: string | undefined;

  async open(ctx: TransportContext): Promise<void> {
    this.ctx = ctx;
  }

  async snapshot(opts?: {
    format?: SnapshotFormat;
    signal?: AbortSignal;
  }): Promise<Snapshot> {
    opts?.signal?.throwIfAborted();
    const format = opts?.format ?? "json";
    const payload = this.lastEnvelope ?? { ok: true, data: null };
    if (format === "text") {
      return { format: "text", data: this.lastBodyPreview ?? "" };
    }
    return { format: "json", data: JSON.stringify(payload) };
  }

  async action<T = unknown>(req: ActionRequest): Promise<ActionResult<T>> {
    const start = Date.now();
    const signal = requestSignal(req.signal, req.params.timeoutMs);
    try {
      req.signal?.throwIfAborted();
      signal?.throwIfAborted();
      const envelope = await settleDispatchedAction(
        httpOperation(req),
        httpActionCanMutate(req),
        signal,
        () => this.dispatch<T>(req, signal),
      );
      this.lastEnvelope = envelope;
      envelope.elapsedMs = Date.now() - start;
      return envelope;
    } catch (e) {
      if (isOperationOutcomeAmbiguousError(e)) throw e;
      req.signal?.throwIfAborted();
      signal?.throwIfAborted();
      const msg = e instanceof Error ? e.message : String(e);
      const timeout = signal?.aborted === true;
      return err({
        transport: "http",
        step: 0,
        action: req.kind,
        reason: `unexpected error in http.${req.kind}: ${msg}`,
        suggestion: timeout
          ? "HTTP request timed out; retry with backoff or raise timeoutMs"
          : "inspect the transport input or file a bug report",
        retryable: timeout,
        exit_code: timeout
          ? exitCodeFor("temp_failure")
          : exitCodeFor("generic_error"),
      });
    }
  }

  async close(): Promise<void> {
    // Stateless wrapper — nothing to release. Idempotent by construction.
    this.ctx = undefined;
  }

  private async dispatch<T>(
    req: ActionRequest,
    signal?: AbortSignal,
  ): Promise<ActionResult<T>> {
    switch (req.kind) {
      case "fetch":
      case "fetch_text":
        return (await this.doFetch(
          req.kind,
          req.params as FetchParams,
          signal,
        )) as ActionResult<T>;
      case "download":
        return (await this.doDownload(
          req.params as { url?: unknown; dest?: unknown },
          signal,
        )) as ActionResult<T>;
      default:
        return err({
          transport: "http",
          step: 0,
          action: req.kind,
          reason: `unsupported action "${req.kind}" for http transport`,
          suggestion: `http transport supports: ${HTTP_STEPS.join(", ")}`,
          minimum_capability: `http.${req.kind}`,
          exit_code: exitCodeFor("usage_error"),
        });
    }
  }

  // ── internals ────────────────────────────────────────────────────

  private buildUrl(raw: string, params?: Record<string, unknown>): string {
    if (!params) return raw;
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      sp.set(k, String(v));
    }
    return raw + (raw.includes("?") ? "&" : "?") + sp.toString();
  }

  private buildHeaders(
    extra?: Record<string, string>,
    accept?: string,
  ): Record<string, string> {
    const headers = new Headers({
      "User-Agent": USER_AGENT,
      ...(accept ? { Accept: accept } : {}),
    });
    for (const [name, value] of Object.entries(extra ?? {})) {
      headers.set(name, value);
    }
    if (this.ctx?.cookieHeader) headers.set("Cookie", this.ctx.cookieHeader);
    return Object.fromEntries(headers);
  }

  private async doFetch(
    action: "fetch" | "fetch_text",
    p: FetchParams,
    signal?: AbortSignal,
  ): Promise<Envelope<unknown>> {
    const url = typeof p.url === "string" ? p.url : undefined;
    if (!url) {
      return err({
        transport: "http",
        step: 0,
        action,
        reason: "missing required param `url`",
        suggestion: `pass params.url to the ${action} action`,
        retryable: false,
        exit_code: exitCodeFor("usage_error"),
      });
    }
    const method =
      typeof p.method === "string" ? p.method.toUpperCase() : "GET";
    const params =
      p.params && typeof p.params === "object"
        ? (p.params as Record<string, unknown>)
        : undefined;
    const extraHeaders =
      p.headers && typeof p.headers === "object"
        ? (p.headers as Record<string, string>)
        : undefined;
    const headers = this.buildHeaders(
      extraHeaders,
      action === "fetch" ? "application/json" : undefined,
    );
    try {
      const requestUrl = this.buildUrl(url, params);
      const resource = await fetchTextResource(
        requestUrl,
        { url: requestUrl, method, body: p.body },
        headers,
        0,
        { signal },
      );
      this.lastBodyPreview = resource.text.slice(0, 200);
      const data =
        action === "fetch" ? JSON.parse(resource.text) : resource.text;
      return ok(data, authoritativeHttpEffect(method, resource.status, url));
    } catch (error) {
      if (isOperationOutcomeAmbiguousError(error)) throw error;
      signal?.throwIfAborted();
      if (error instanceof PipelineError) {
        this.lastBodyPreview = error.detail.responsePreview ?? "";
        return err({
          transport: "http",
          step: 0,
          action,
          reason: error.message,
          suggestion: error.detail.suggestion,
          retryable: error.detail.retryable,
          exit_code: mapErrorToExitCode(error),
        });
      }
      return err({
        transport: "http",
        step: 0,
        action,
        reason: error instanceof Error ? error.message : String(error),
        suggestion:
          error instanceof UnsafeRequestUrlError
            ? "remove loopback/metadata hosts or set UNICLI_ALLOW_LOCAL=1 for local development"
            : "inspect the response content and requested representation",
        retryable: false,
        exit_code:
          error instanceof UnsafeRequestUrlError
            ? exitCodeFor("config_error")
            : mapErrorToExitCode(error),
      });
    }
  }

  private async doDownload(
    p: {
      url?: unknown;
      dest?: unknown;
    },
    signal?: AbortSignal,
  ): Promise<Envelope<{ path: string; size: number }>> {
    const url = typeof p.url === "string" ? p.url : undefined;
    const dest = typeof p.dest === "string" ? p.dest : undefined;
    if (!url || !dest) {
      return err({
        transport: "http",
        step: 0,
        action: "download",
        reason: "download requires params.url and params.dest",
        suggestion: "pass both `url` and `dest` (absolute file path)",
        retryable: false,
        exit_code: exitCodeFor("usage_error"),
      });
    }
    try {
      assertSafeRequestUrl(url);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err({
        transport: "http",
        step: 0,
        action: "download",
        reason: msg,
        suggestion:
          "download target must be a public http(s) URL — set UNICLI_ALLOW_LOCAL=1 to override",
        retryable: false,
        exit_code: exitCodeFor("config_error"),
      });
    }
    try {
      const { httpDownload } = await import("../../engine/download.js");
      const headers: Record<string, string> = {};
      if (this.ctx?.cookieHeader) headers["Cookie"] = this.ctx.cookieHeader;
      const result = await httpDownload(url, dest, { headers, signal });
      if (result.status !== "success" || !result.path) {
        return err({
          transport: "http",
          step: 0,
          action: "download",
          reason:
            result.error ?? `download failed with status ${result.status}`,
          suggestion: "inspect the URL, dest path, and network",
          retryable: false,
        });
      }
      return ok(
        { path: result.path, size: result.size ?? 0 },
        {
          effect_verdict: confirmedEffectVerdict(
            "postcondition_observation",
            "the download committed an addressable destination file",
            "protocol-result",
          ),
        },
      );
    } catch (e) {
      signal?.throwIfAborted();
      const msg = e instanceof Error ? e.message : String(e);
      return err({
        transport: "http",
        step: 0,
        action: "download",
        reason: msg,
        suggestion:
          "verify url reachability and destination directory permissions",
        retryable: /timeout|ETIMEDOUT|ECONNREFUSED|ECONNRESET/i.test(msg),
      });
    }
  }
}

function httpActionCanMutate(req: ActionRequest): boolean {
  // Download writes through an owned staging file and atomically renames only
  // after full receipt; cancellation removes staging and leaves the prior
  // destination intact, so direct transport cancellation is contained.
  if (req.kind === "download") return req.canMutate === true;
  if (req.kind !== "fetch" && req.kind !== "fetch_text") {
    return req.canMutate === true;
  }
  const method =
    typeof req.params.method === "string"
      ? req.params.method.toUpperCase()
      : "GET";
  return (
    !new Set(["GET", "HEAD", "OPTIONS", "TRACE"]).has(method) ||
    req.canMutate === true
  );
}

function authoritativeHttpEffect(
  method: string,
  status: number,
  url: string,
): { effect_verdict?: EffectVerdict } {
  const normalized = method.toUpperCase();
  if (
    !["POST", "PUT", "PATCH", "DELETE"].includes(normalized) ||
    (status !== 201 && status !== 204)
  ) {
    return {};
  }
  return {
    effect_verdict: confirmedEffectVerdict(
      "authoritative_response",
      `${normalized} ${url} returned authoritative HTTP ${String(status)}`,
      "protocol-result",
    ),
  };
}

function httpOperation(req: ActionRequest): string {
  const method =
    typeof req.params.method === "string"
      ? req.params.method.toUpperCase()
      : "GET";
  return req.kind === "fetch" || req.kind === "fetch_text"
    ? `HTTP ${method}`
    : `HTTP ${req.kind}`;
}

function requestSignal(
  callerSignal: AbortSignal | undefined,
  timeoutValue: unknown,
): AbortSignal | undefined {
  const timeoutMs =
    typeof timeoutValue === "number"
      ? timeoutValue
      : typeof timeoutValue === "string"
        ? Number(timeoutValue)
        : undefined;
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
    return callerSignal;
  }
  const timeoutSignal = AbortSignal.timeout(Math.max(1, timeoutMs));
  return callerSignal
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal;
}
