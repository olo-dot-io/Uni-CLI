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

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { USER_AGENT } from "../../constants.js";
import { registerStep, type StepHandler } from "../step-registry.js";
import { type PipelineContext, PipelineError } from "../executor.js";
import { assertSafeRequestUrl } from "../ssrf.js";
import { evalTemplate, resolveTemplateDeep } from "../template.js";
import { mapConcurrent } from "../download.js";
import { assertRuntimeNetworkAllowed } from "../runtime-resource-guard.js";
import {
  fetchHttpResource,
  isHtmlVerificationChallenge,
  challengeRequiredError,
} from "../http-response.js";
import { writeFileTransactionally } from "../transactional-file.js";

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
      const resolvedConfig =
        config.body !== undefined
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

  const resolvedConfig =
    config.body !== undefined
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

function fetchCacheKey(url: string, method: string, headers: Headers): string {
  return createHash("sha256")
    .update(JSON.stringify([method, url, [...headers.entries()]]))
    .digest("hex")
    .slice(0, 16);
}

interface FetchCacheEntry {
  schema_version: "fetch-cache.v2";
  stored_at: number;
  expires_at: number;
  requested_url: string;
  final_url: string;
  method: string;
  data: unknown;
}

function readFetchCache(
  url: string,
  method: string,
  ttlSeconds: number,
  headers: Headers,
): FetchCacheEntry | null {
  const key = fetchCacheKey(url, method, headers);
  const filePath = join(CACHE_DIR, `${key}.json`);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf-8");
    const entry = JSON.parse(raw) as Partial<FetchCacheEntry>;
    const age = Date.now() - (entry.stored_at ?? Number.NaN);
    if (
      entry.schema_version !== "fetch-cache.v2" ||
      !Number.isSafeInteger(entry.stored_at) ||
      age < 0 ||
      age > ttlSeconds * 1000 ||
      !Number.isSafeInteger(entry.expires_at) ||
      Date.now() >= (entry.expires_at ?? 0) ||
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

async function writeFetchCache(
  url: string,
  finalUrl: string,
  method: string,
  data: unknown,
  headers: Headers,
  ttlSeconds: number,
): Promise<void> {
  try {
    const payload = JSON.stringify({
      schema_version: "fetch-cache.v2",
      stored_at: Date.now(),
      expires_at: Date.now() + Math.floor(ttlSeconds * 1000),
      requested_url: url,
      final_url: finalUrl,
      method,
      data,
    } satisfies FetchCacheEntry);
    if (payload.length > MAX_CACHE_ENTRY_BYTES) return;
    mkdirSync(CACHE_DIR, { recursive: true });
    const key = fetchCacheKey(url, method, headers);
    await writeFileTransactionally(
      join(CACHE_DIR, `${key}.json`),
      Buffer.from(payload),
      { mode: 0o600 },
    );
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

  const headers = new Headers({
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  });
  for (const [key, value] of Object.entries(config.headers ?? {}))
    headers.set(key, value);
  if (cookieHeader) headers.set("cookie", cookieHeader);
  const cacheSeconds =
    method === "GET" && Number.isFinite(config.cache)
      ? Math.max(0, config.cache ?? 0)
      : 0;
  if (cacheSeconds > 0) {
    const cached = readFetchCache(url, method, cacheSeconds, headers);
    if (cached !== null) {
      signal?.throwIfAborted();
      assertSafeRequestUrl(cached.final_url);
      options.validateRequest(cached.final_url);
      signal?.throwIfAborted();
      return cached.data;
    }
  }
  const init: RequestInit = { method, headers, signal };
  if (config.body !== undefined && method !== "GET" && method !== "HEAD") {
    if (!headers.has("content-type"))
      headers.set("content-type", "application/json");
    init.body = JSON.stringify(config.body);
  }
  const { response, finalUrl, data } = await fetchHttpResource(
    url,
    init,
    {
      ...config,
      action: "fetch",
      step: stepIndex,
      validateRequest: options.validateRequest,
    },
    async (response, finalUrl) => {
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        signal?.throwIfAborted();
        throw error;
      }
      signal?.throwIfAborted();
      if (
        !/json/i.test(response.headers.get("content-type") ?? "") &&
        isHtmlVerificationChallenge(text)
      )
        throw challengeRequiredError(url, "fetch", stepIndex, response.status);
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw new PipelineError(
          `Expected JSON from ${url}, received ${response.headers.get("content-type") ?? "untyped content"}.`,
          {
            step: stepIndex,
            action: "fetch",
            config: { url, method },
            errorType: "invalid_content",
            preserveErrorCode: true,
            url,
            statusCode: response.status,
            retryable: false,
            suggestion:
              "Use the source's JSON API or read textual documents with unicli extract.",
          },
        );
      }
      return { response, finalUrl, data };
    },
  );
  if (cacheSeconds > 0) {
    const policy = response.headers.get("cache-control") ?? "";
    const age = Math.max(0, Number(response.headers.get("age") ?? 0));
    const maxAge = /(?:^|,)\s*max-age\s*=\s*"?(\d+)/i.exec(policy)?.[1];
    const ttl = Math.min(
      cacheSeconds,
      maxAge === undefined ? cacheSeconds : Math.max(0, Number(maxAge) - age),
    );
    if (
      ttl > 0 &&
      Number.isFinite(ttl) &&
      !/(?:^|,)\s*(?:no-store|no-cache|private)\b/i.test(policy) &&
      response.headers.get("vary")?.trim() !== "*"
    ) {
      await writeFetchCache(url, finalUrl, method, data, headers, ttl);
    }
  }
  signal?.throwIfAborted();
  return data;
}

registerStep("fetch", stepFetch as StepHandler);
