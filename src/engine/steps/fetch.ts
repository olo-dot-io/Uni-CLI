/**
 * @owner       src::engine::steps::fetch
 * @does        Executes validated HTTP requests with retries, caching, proxy routing, and bounded concurrency.
 * @needs       node fs/path/os/crypto, constants, registry/executor, validated fetch/template/cookies/download/resource guard
 * @feeds       step registry action "fetch", fetch_text shared request helpers
 * @breaks      PipelineError preserves network, HTTP, policy, and response-shape failure semantics.
 * @invariants  Initial and redirected request URLs pass request-policy and runtime-resource validation before cache access or network I/O; cross-origin redirects cannot retain caller credentials; an HTTP auth failure never acquires undeclared browser credentials; caller cancellation remains the exact abort reason instead of a retryable network failure.
 * @side-effects Network I/O, optional cache writes, cookie acquisition, and response-cookie capture.
 * @perf        Retry count and fan-out are explicitly bounded by adapter configuration.
 * @concurrency Multi-URL requests use the shared bounded concurrency mapper.
 * @test        tests/unit/engine-features.test.ts, tests/unit/engine/steps/fetch-text-session.test.ts, tests/unit/proxy.test.ts
 * @stability   stable
 * @since       2026-04-15
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { USER_AGENT } from "../../constants.js";
import { registerStep, type StepHandler } from "../step-registry.js";
import { type PipelineContext, PipelineError } from "../executor.js";
import { assertSafeRequestUrl, UnsafeRequestUrlError } from "../ssrf.js";
import { evalTemplate, resolveTemplateDeep } from "../template.js";
import { mapConcurrent } from "../download.js";
import { describeNetworkFailure } from "../proxy.js";
import { assertRuntimeNetworkAllowed } from "../runtime-resource-guard.js";
import {
  fetchWithValidatedRedirects,
  RedirectLimitError,
} from "../validated-fetch.js";

export interface FetchConfig {
  url: string;
  method?: string;
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
  retry?: number;
  backoff?: number;
  cache?: number;
  /**
   * Capture the response `Set-Cookie` header(s) and merge them into the
   * returned `ctx.cookieHeader` so a later step in the same pipeline can send
   * them. Host-scoped: cookies from a cross-site final URL are dropped
   * (see cookie-capture.ts). Default false. Honored by `fetch_text`.
   */
  capture_cookies?: boolean;
  /**
   * Closed set of endpoint URLs tried in order when `rotate_on_field` fires.
   * Each candidate is independently validated by `assertSafeRequestUrl`.
   * Rotation is bounded by the list length — it can never loop forever
   * (keeps adapter control flow decidable). Honored by `fetch_text`.
   */
  rotate_urls?: string[];
  /**
   * Fixed top-level JSON field whose presence in a parsed response body
   * signals "wrong endpoint, try the next `rotate_urls` candidate" (e.g.
   * 12306's `c_url`). A closed key match, not an arbitrary expression.
   */
  rotate_on_field?: string;
}

export function normalizeFetchAttempts(retry: number | undefined): number {
  const attempts = retry ?? 1;
  if (!Number.isFinite(attempts)) return 1;
  return Math.max(1, Math.floor(attempts));
}

export function resolveHeaderTemplates(
  headers: Record<string, string> | undefined,
  ctx: PipelineContext,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    resolved[key] = evalTemplate(value, ctx);
  }
  return resolved;
}

export async function stepFetch(
  ctx: PipelineContext,
  config: FetchConfig,
  stepIndex = -1,
): Promise<PipelineContext> {
  let url = evalTemplate(config.url, ctx);
  const validateRequest = (requestUrl: string): void =>
    assertRuntimeNetworkAllowed(ctx, {
      action: "fetch",
      step: stepIndex,
      config,
      url: requestUrl,
      access: networkAccessForMethod(config.method),
    });

  // Fan-out with concurrency limit when data is an array of items.
  if (Array.isArray(ctx.data)) {
    const items = ctx.data as Array<Record<string, unknown>>;
    const concurrency = (config as unknown as Record<string, unknown>)
      .concurrency
      ? Number((config as unknown as Record<string, unknown>).concurrency)
      : 5;
    const results = await mapConcurrent(items, concurrency, async (item) => {
      const itemCtx = { ...ctx, data: item };
      const itemUrl = evalTemplate(config.url, itemCtx);
      const resolvedConfig = config.body
        ? {
            ...config,
            body: resolveTemplateDeep(config.body, itemCtx),
            headers: resolveHeaderTemplates(config.headers, itemCtx),
          }
        : {
            ...config,
            headers: resolveHeaderTemplates(config.headers, itemCtx),
          };
      return fetchJson(itemUrl, resolvedConfig, {
        cookieHeader: ctx.cookieHeader,
        stepIndex,
        signal: ctx.signal,
        validateRequest,
      });
    });
    return { ...ctx, data: results };
  }

  if (config.params) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(config.params)) {
      const val = evalTemplate(String(v), ctx);
      params.set(k, val);
    }
    url += (url.includes("?") ? "&" : "?") + params.toString();
  }

  const resolvedConfig = config.body
    ? {
        ...config,
        body: resolveTemplateDeep(config.body, ctx),
        headers: resolveHeaderTemplates(config.headers, ctx),
      }
    : { ...config, headers: resolveHeaderTemplates(config.headers, ctx) };

  const data = await fetchJson(url, resolvedConfig, {
    cookieHeader: ctx.cookieHeader,
    stepIndex,
    signal: ctx.signal,
    validateRequest,
  });
  return { ...ctx, data };
}

export function networkAccessForMethod(method = "GET"): "read" | "write" {
  const normalized = method.toUpperCase();
  return normalized === "GET" ||
    normalized === "HEAD" ||
    normalized === "OPTIONS"
    ? "read"
    : "write";
}

const CACHE_DIR = join(homedir(), ".unicli", "cache");

function fetchCacheKey(url: string, method: string): string {
  return createHash("sha256")
    .update(`${method}:${url}`)
    .digest("hex")
    .slice(0, 16);
}

interface FetchCacheEntry {
  schema_version: "fetch-cache.v1";
  stored_at: number;
  requested_url: string;
  final_url: string;
  method: string;
  data: unknown;
}

function readFetchCache(
  url: string,
  method: string,
  ttlSeconds: number,
): FetchCacheEntry | null {
  const key = fetchCacheKey(url, method);
  const filePath = join(CACHE_DIR, `${key}.json`);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf-8");
    const entry = JSON.parse(raw) as Partial<FetchCacheEntry>;
    const age = Date.now() - (entry.stored_at ?? Number.NaN);
    if (
      entry.schema_version !== "fetch-cache.v1" ||
      !Number.isSafeInteger(entry.stored_at) ||
      age < 0 ||
      age > ttlSeconds * 1000 ||
      entry.requested_url !== url ||
      entry.method !== method ||
      typeof entry.final_url !== "string" ||
      !Object.prototype.hasOwnProperty.call(entry, "data")
    ) {
      return null;
    }
    return entry as FetchCacheEntry;
  } catch {
    return null;
  }
}

const MAX_CACHE_ENTRY_BYTES = 10 * 1024 * 1024;

function writeFetchCache(
  url: string,
  finalUrl: string,
  method: string,
  data: unknown,
): void {
  try {
    const payload = JSON.stringify({
      schema_version: "fetch-cache.v1",
      stored_at: Date.now(),
      requested_url: url,
      final_url: finalUrl,
      method,
      data,
    } satisfies FetchCacheEntry);
    if (payload.length > MAX_CACHE_ENTRY_BYTES) return;
    mkdirSync(CACHE_DIR, { recursive: true });
    const key = fetchCacheKey(url, method);
    writeFileSync(join(CACHE_DIR, `${key}.json`), payload);
  } catch {
    /* cache write failure is non-fatal */
  }
}

async function fetchJson(
  url: string,
  config: FetchConfig,
  options: {
    cookieHeader?: string;
    stepIndex: number;
    signal?: AbortSignal;
    validateRequest: (url: string) => void;
  },
): Promise<unknown> {
  const method = (config.method ?? "GET").toUpperCase();
  const { cookieHeader, signal, stepIndex } = options;

  signal?.throwIfAborted();
  assertSafeRequestUrl(url);
  options.validateRequest(url);
  signal?.throwIfAborted();

  if (config.cache && config.cache > 0) {
    const cached = readFetchCache(url, method, config.cache);
    if (cached !== null) {
      signal?.throwIfAborted();
      assertSafeRequestUrl(cached.final_url);
      options.validateRequest(cached.final_url);
      signal?.throwIfAborted();
      return cached.data;
    }
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
    ...config.headers,
  };

  if (cookieHeader) {
    headers["Cookie"] = cookieHeader;
  }

  const init: RequestInit = { method, headers, signal };
  if (config.body && method !== "GET") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(config.body);
  }
  const maxAttempts = normalizeFetchAttempts(config.retry);
  const baseDelay = config.backoff ?? 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let resp: Response;
    let finalUrl: string;
    try {
      ({ response: resp, finalUrl } = await fetchWithValidatedRedirects(
        url,
        init,
        {
          validateRequest: options.validateRequest,
        },
      ));
    } catch (error) {
      signal?.throwIfAborted();
      if (
        error instanceof PipelineError ||
        error instanceof UnsafeRequestUrlError
      ) {
        throw error;
      }
      if (error instanceof RedirectLimitError) {
        throw new PipelineError(error.message, {
          step: stepIndex,
          action: "fetch",
          config: { url, method },
          errorType: "http_error",
          url,
          suggestion: "Use a canonical API URL with a bounded redirect chain.",
          retryable: false,
          alternatives: [],
        });
      }
      const isLastAttempt = attempt === maxAttempts;
      if (!isLastAttempt) {
        await delay(baseDelay * 2 ** (attempt - 1), undefined, { signal });
        continue;
      }
      throw new PipelineError(
        `Network request failed for ${url}: ${describeNetworkFailure(error)}`,
        {
          step: stepIndex,
          action: "fetch",
          config: { url, method },
          errorType: "network_error",
          url,
          suggestion: `Check proxy configuration and connectivity to ${new URL(url).origin}.`,
          retryable: true,
          alternatives: [],
        },
      );
    }

    if (resp.ok) {
      const data = await resp.json();
      signal?.throwIfAborted();
      if (config.cache && config.cache > 0) {
        writeFetchCache(url, finalUrl, method, data);
      }
      return data;
    }

    const isRetryable = resp.status === 429 || resp.status >= 500;
    const isLastAttempt = attempt === maxAttempts;

    if (isRetryable && !isLastAttempt) {
      await delay(baseDelay * 2 ** (attempt - 1), undefined, { signal });
      continue;
    }

    let preview = "";
    try {
      preview = (await resp.text()).slice(0, 200);
    } catch {
      /* ignore */
    }
    signal?.throwIfAborted();
    const isRetryableStatus =
      resp.status === 429 ||
      resp.status === 500 ||
      resp.status === 502 ||
      resp.status === 503;
    throw new PipelineError(
      `HTTP ${resp.status} ${resp.statusText} from ${url}`,
      {
        step: stepIndex,
        action: "fetch",
        config: { url, method },
        errorType: "http_error",
        url,
        statusCode: resp.status,
        responsePreview: preview,
        suggestion:
          resp.status === 403
            ? "The API is blocking requests. The endpoint may require authentication (cookie strategy) or the User-Agent may need updating."
            : resp.status === 404
              ? "The API endpoint was not found. The URL path may have changed — check the target site for the current API."
              : resp.status === 429
                ? "Rate limited. Add a delay between requests or reduce the limit parameter."
                : `HTTP ${resp.status} error. Check if the API endpoint is still valid.`,
        retryable: isRetryableStatus,
        alternatives:
          resp.status === 401 || resp.status === 403
            ? ["unicli auth setup <site>"]
            : [],
      },
    );
  }

  throw new Error("fetchJson: unreachable");
}

registerStep("fetch", stepFetch as StepHandler);
