import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { USER_AGENT } from "../../constants.js";
import { registerStep, type StepHandler } from "../step-registry.js";
import { type PipelineContext, PipelineError } from "../executor.js";
import { assertSafeRequestUrl } from "../ssrf.js";
import { evalTemplate, resolveTemplateDeep } from "../template.js";
import { formatCookieHeader, loadCookiesWithCDP } from "../cookies.js";
import { mapConcurrent } from "../download.js";
import { getProxyAgent } from "../proxy.js";

export interface FetchConfig {
  url: string;
  method?: string;
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
  retry?: number;
  backoff?: number;
  cache?: number;
}

export function normalizeFetchAttempts(retry: number | undefined): number {
  const attempts = retry ?? 1;
  if (!Number.isFinite(attempts)) return 1;
  return Math.max(1, Math.floor(attempts));
}

export async function stepFetch(
  ctx: PipelineContext,
  config: FetchConfig,
): Promise<PipelineContext> {
  let url = evalTemplate(config.url, ctx);
  assertSafeRequestUrl(url);

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
      assertSafeRequestUrl(itemUrl);
      const resolvedConfig = config.body
        ? { ...config, body: resolveTemplateDeep(config.body, itemCtx) }
        : config;
      return fetchJson(itemUrl, resolvedConfig, ctx.cookieHeader);
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
    ? { ...config, body: resolveTemplateDeep(config.body, ctx) }
    : config;

  try {
    const data = await fetchJson(url, resolvedConfig, ctx.cookieHeader);
    return { ...ctx, data };
  } catch (err) {
    if (
      err instanceof PipelineError &&
      (err.detail.statusCode === 401 || err.detail.statusCode === 403) &&
      !ctx.cookieHeader
    ) {
      try {
        const hostname = new URL(url).hostname;
        const siteName = hostname
          .replace(/^www\./, "")
          .split(".")
          .slice(0, -1)
          .join("-");
        const cookies = await loadCookiesWithCDP(siteName);
        if (cookies) {
          const fallbackCookie = formatCookieHeader(cookies);
          const data = await fetchJson(url, resolvedConfig, fallbackCookie);
          return { ...ctx, data, cookieHeader: fallbackCookie };
        }
      } catch {
        // Cookie fallback also failed — throw original
      }
    }
    throw err;
  }
}

const CACHE_DIR = join(homedir(), ".unicli", "cache");

function fetchCacheKey(url: string, method: string): string {
  return createHash("sha256")
    .update(`${method}:${url}`)
    .digest("hex")
    .slice(0, 16);
}

function readFetchCache(
  url: string,
  method: string,
  ttlSeconds: number,
): unknown | null {
  const key = fetchCacheKey(url, method);
  const filePath = join(CACHE_DIR, `${key}.json`);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf-8");
    const entry = JSON.parse(raw) as { ts: number; data: unknown };
    if (Date.now() - entry.ts > ttlSeconds * 1000) return null;
    return entry.data;
  } catch {
    return null;
  }
}

const MAX_CACHE_ENTRY_BYTES = 10 * 1024 * 1024;

function writeFetchCache(url: string, method: string, data: unknown): void {
  try {
    const payload = JSON.stringify({ ts: Date.now(), url, data });
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
  cookieHeader?: string,
): Promise<unknown> {
  const method = config.method ?? "GET";

  if (config.cache && config.cache > 0) {
    const cached = readFetchCache(url, method, config.cache);
    if (cached !== null) return cached;
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
    ...config.headers,
  };

  if (cookieHeader) {
    headers["Cookie"] = cookieHeader;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dispatcher from undici not in standard RequestInit
  const init: Record<string, any> = { method, headers };
  if (config.body && method !== "GET") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(config.body);
  }
  const proxyAgent = getProxyAgent();
  if (proxyAgent) init.dispatcher = proxyAgent;

  const maxAttempts = normalizeFetchAttempts(config.retry);
  const baseDelay = config.backoff ?? 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const resp = await fetch(url, init as RequestInit);

    if (resp.ok) {
      const data = await resp.json();
      if (config.cache && config.cache > 0) writeFetchCache(url, method, data);
      return data;
    }

    const isRetryable = resp.status === 429 || resp.status >= 500;
    const isLastAttempt = attempt === maxAttempts;

    if (isRetryable && !isLastAttempt) {
      await new Promise((r) => setTimeout(r, baseDelay * 2 ** (attempt - 1)));
      continue;
    }

    let preview = "";
    try {
      preview = (await resp.text()).slice(0, 200);
    } catch {
      /* ignore */
    }
    const isRetryableStatus =
      resp.status === 429 ||
      resp.status === 500 ||
      resp.status === 502 ||
      resp.status === 503;
    throw new PipelineError(
      `HTTP ${resp.status} ${resp.statusText} from ${url}`,
      {
        step: -1,
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
