/**
 * HttpTransport — wraps Node's native `fetch` behind the TransportAdapter
 * interface.
 *
 * This is the transport for API-level steps: `fetch`, `fetch_text`,
 * `parse_rss`, `html_to_md`, and HTTP-based `download`. The existing
 * `src/engine/yaml-runner.ts` step bodies remain the canonical executor
 * for v0.212 — this wrapper exposes the same primitives through the
 * uniform `action()` / `snapshot()` / `open()` / `close()` contract so
 * the new bus-driven dispatch path works today.
 *
 * Contract:
 *  - `action()` NEVER throws — all failures become an `err()` envelope
 *  - `capability.steps` is the single source of truth for dispatch
 *  - `snapshot()` returns the last HTTP response body as JSON
 */

import { USER_AGENT } from "../../constants.js";
import { err, exitCodeFor, ok } from "../../core/envelope.js";
import type { Envelope } from "../../core/envelope.js";
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
  mutatesHost: false,
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

  async snapshot(opts?: { format?: SnapshotFormat }): Promise<Snapshot> {
    const format = opts?.format ?? "json";
    const payload = this.lastEnvelope ?? { ok: true, data: null };
    if (format === "text") {
      return { format: "text", data: this.lastBodyPreview ?? "" };
    }
    return { format: "json", data: JSON.stringify(payload) };
  }

  async action<T = unknown>(req: ActionRequest): Promise<ActionResult<T>> {
    const start = Date.now();
    try {
      switch (req.kind) {
        case "fetch": {
          const envelope = await this.doFetchJson<T>(req.params as FetchParams);
          this.lastEnvelope = envelope;
          envelope.elapsedMs = Date.now() - start;
          return envelope;
        }
        case "fetch_text": {
          const envelope = await this.doFetchText(req.params as FetchParams);
          this.lastEnvelope = envelope;
          envelope.elapsedMs = Date.now() - start;
          return envelope as ActionResult<T>;
        }
        case "download": {
          const envelope = await this.doDownload(
            req.params as { url?: unknown; dest?: unknown },
          );
          this.lastEnvelope = envelope;
          envelope.elapsedMs = Date.now() - start;
          return envelope as ActionResult<T>;
        }
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
    } catch (e) {
      // Safety net — action() must never throw.
      const msg = e instanceof Error ? e.message : String(e);
      return err({
        transport: "http",
        step: 0,
        action: req.kind,
        reason: `unexpected error in http.${req.kind}: ${msg}`,
        suggestion: "inspect the transport input or file a bug report",
        retryable: false,
      });
    }
  }

  async close(): Promise<void> {
    // Stateless wrapper — nothing to release. Idempotent by construction.
    this.ctx = undefined;
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
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      ...(accept ? { Accept: accept } : {}),
      ...(extra ?? {}),
    };
    if (this.ctx?.cookieHeader) headers["Cookie"] = this.ctx.cookieHeader;
    return headers;
  }

  private async doFetchJson<T>(p: FetchParams): Promise<Envelope<T>> {
    const url = typeof p.url === "string" ? p.url : undefined;
    if (!url) {
      return err({
        transport: "http",
        step: 0,
        action: "fetch",
        reason: "missing required param `url`",
        suggestion: "pass params.url to the fetch action",
        retryable: false,
        exit_code: exitCodeFor("usage_error"),
      });
    }
    const method = typeof p.method === "string" ? p.method : "GET";
    const params =
      p.params && typeof p.params === "object"
        ? (p.params as Record<string, unknown>)
        : undefined;
    const extraHeaders =
      p.headers && typeof p.headers === "object"
        ? (p.headers as Record<string, string>)
        : undefined;
    const headers = this.buildHeaders(extraHeaders, "application/json");

    const init: Record<string, unknown> = { method, headers };
    if (p.body !== undefined && method !== "GET") {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(p.body);
    }

    try {
      const resp = await fetch(this.buildUrl(url, params), init as RequestInit);
      if (!resp.ok) {
        let preview = "";
        try {
          preview = (await resp.text()).slice(0, 200);
        } catch {
          /* ignore */
        }
        this.lastBodyPreview = preview;
        const retryable =
          resp.status === 429 ||
          resp.status === 500 ||
          resp.status === 502 ||
          resp.status === 503;
        return err({
          transport: "http",
          step: 0,
          action: "fetch",
          reason: `HTTP ${resp.status} ${resp.statusText} from ${url}`,
          suggestion:
            resp.status === 401 || resp.status === 403
              ? `authentication required — run \`unicli auth setup <site>\``
              : resp.status === 404
                ? `endpoint not found — check the URL path`
                : `HTTP ${resp.status} — inspect the response or retry later`,
          retryable,
          exit_code:
            resp.status === 401 || resp.status === 403
              ? exitCodeFor("auth_required")
              : retryable
                ? exitCodeFor("temp_failure")
                : exitCodeFor("service_unavailable"),
        });
      }
      const data = (await resp.json()) as T;
      try {
        this.lastBodyPreview = JSON.stringify(data).slice(0, 200);
      } catch {
        this.lastBodyPreview = "";
      }
      return ok(data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const transient =
        /timeout|ETIMEDOUT|ECONNREFUSED|ECONNRESET|socket hang up/i.test(msg);
      return err({
        transport: "http",
        step: 0,
        action: "fetch",
        reason: msg,
        suggestion: transient
          ? "transient network error — retry with backoff"
          : "inspect the URL, DNS, or TLS configuration",
        retryable: transient,
        exit_code: transient
          ? exitCodeFor("temp_failure")
          : exitCodeFor("generic_error"),
      });
    }
  }

  private async doFetchText(p: FetchParams): Promise<Envelope<string>> {
    const url = typeof p.url === "string" ? p.url : undefined;
    if (!url) {
      return err({
        transport: "http",
        step: 0,
        action: "fetch_text",
        reason: "missing required param `url`",
        suggestion: "pass params.url to the fetch_text action",
        retryable: false,
        exit_code: exitCodeFor("usage_error"),
      });
    }
    const method = typeof p.method === "string" ? p.method : "GET";
    const extraHeaders =
      p.headers && typeof p.headers === "object"
        ? (p.headers as Record<string, string>)
        : undefined;
    try {
      const resp = await fetch(url, {
        method,
        headers: this.buildHeaders(extraHeaders),
      });
      if (!resp.ok) {
        return err({
          transport: "http",
          step: 0,
          action: "fetch_text",
          reason: `HTTP ${resp.status} ${resp.statusText} from ${url}`,
          suggestion: `check if the URL is still valid: ${url}`,
          retryable:
            resp.status === 429 ||
            resp.status === 500 ||
            resp.status === 502 ||
            resp.status === 503,
          exit_code: exitCodeFor("service_unavailable"),
        });
      }
      const text = await resp.text();
      this.lastBodyPreview = text.slice(0, 200);
      return ok(text);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err({
        transport: "http",
        step: 0,
        action: "fetch_text",
        reason: msg,
        suggestion: "inspect the URL or the network configuration",
        retryable: /timeout|ETIMEDOUT|ECONNREFUSED|ECONNRESET/i.test(msg),
      });
    }
  }

  private async doDownload(p: {
    url?: unknown;
    dest?: unknown;
  }): Promise<Envelope<{ path: string; size: number }>> {
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
      const { httpDownload } = await import("../../engine/download.js");
      const headers: Record<string, string> = {};
      if (this.ctx?.cookieHeader) headers["Cookie"] = this.ctx.cookieHeader;
      const result = await httpDownload(url, dest, headers);
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
      return ok({ path: result.path, size: result.size ?? 0 });
    } catch (e) {
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
