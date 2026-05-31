//! @owner       src::engine::steps::fetch_text
//! @does        HTTP request returning raw text; optional session-cookie capture and bounded endpoint rotation
//! @needs       ./fetch (FetchConfig), ../cookie-capture, ../ssrf, ../template, ../runtime-resource-guard
//! @feeds       ./index (barrel), pipeline executor via registry "fetch_text"
//! @breaks      PipelineError on http_error / network_error after retries
//! @invariants  every fetched URL (incl. rotation candidates) passes assertSafeRequestUrl; cookie capture is host-scoped; rotation bounded by rotate_urls.length
//! @side-effects network I/O
//! @perf        one fetch per attempt; rotation adds at most rotate_urls.length fetches
//! @concurrency stateless per call
//! @test        tests/unit/engine/steps/fetch-text-session.test.ts
//! @stability   stable
//! @since       2026-05-30 (capture/rotation added)

import { USER_AGENT } from "../../constants.js";
import { registerStep, type StepHandler } from "../step-registry.js";
import { type PipelineContext, PipelineError } from "../executor.js";
import { assertSafeRequestUrl } from "../ssrf.js";
import { evalTemplate } from "../template.js";
import { getProxyAgent } from "../proxy.js";
import { assertRuntimeNetworkAllowed } from "../runtime-resource-guard.js";
import {
  parseSetCookiePairs,
  mergeCookieHeader,
  sameRegistrableHost,
} from "../cookie-capture.js";
import {
  networkAccessForMethod,
  normalizeFetchAttempts,
  type FetchConfig,
} from "./fetch.js";

interface TextResult {
  text: string;
  /** Final response URL after redirects; falls back to the request URL. */
  finalUrl: string;
  /** Raw Set-Cookie lines from the response, empty when none. */
  setCookieLines: string[];
}

/** Append resolved `params` to a URL, preserving an existing query string. */
function withParams(
  url: string,
  config: FetchConfig,
  ctx: PipelineContext,
): string {
  if (!config.params) return url;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(config.params)) {
    params.set(k, evalTemplate(String(v), ctx));
  }
  return url + (url.includes("?") ? "&" : "?") + params.toString();
}

/** One request with the existing retry/backoff/error contract. */
async function fetchTextOnce(
  requestUrl: string,
  config: FetchConfig,
  headers: Record<string, string>,
  stepIndex: number,
): Promise<TextResult> {
  const method = config.method ?? "GET";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dispatcher from undici not in standard RequestInit
  const fetchInit: Record<string, any> = { method, headers };
  const ftAgent = getProxyAgent();
  if (ftAgent) fetchInit.dispatcher = ftAgent;

  const maxAttempts = normalizeFetchAttempts(config.retry);
  const baseDelay = config.backoff ?? 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const resp = await fetch(requestUrl, fetchInit as RequestInit);
      if (resp.ok) {
        const text = await resp.text();
        const getSetCookie = (
          resp.headers as Headers & { getSetCookie?: () => string[] }
        ).getSetCookie;
        const setCookieLines =
          typeof getSetCookie === "function"
            ? getSetCookie.call(resp.headers)
            : [];
        return {
          text,
          finalUrl: resp.url || requestUrl,
          setCookieLines,
        };
      }

      const retryable =
        resp.status === 429 ||
        resp.status === 500 ||
        resp.status === 502 ||
        resp.status === 503;
      const isLastAttempt = attempt === maxAttempts;
      if (retryable && !isLastAttempt) {
        await new Promise((r) => setTimeout(r, baseDelay * 2 ** (attempt - 1)));
        continue;
      }

      throw new PipelineError(
        `HTTP ${resp.status} ${resp.statusText} from ${requestUrl}`,
        {
          step: stepIndex,
          action: "fetch_text",
          config: { url: requestUrl, method },
          errorType: "http_error",
          url: requestUrl,
          statusCode: resp.status,
          suggestion: `Check if the URL is still valid: ${requestUrl}`,
          retryable,
          alternatives:
            resp.status === 401 || resp.status === 403
              ? ["unicli auth setup <site>"]
              : [],
        },
      );
    } catch (err) {
      const isLastAttempt = attempt === maxAttempts;
      if (err instanceof PipelineError) {
        throw err;
      }
      if (isLastAttempt) {
        const message = err instanceof Error ? err.message : String(err);
        throw new PipelineError(
          `fetch_text failed for ${requestUrl}: ${message}`,
          {
            step: stepIndex,
            action: "fetch_text",
            config: { url: requestUrl, method },
            errorType: "network_error",
            url: requestUrl,
            suggestion: `Network fetch failed. Retry or check connectivity to: ${requestUrl}`,
            retryable: true,
            alternatives: [],
          },
        );
      }
      await new Promise((r) => setTimeout(r, baseDelay * 2 ** (attempt - 1)));
    }
  }

  throw new Error("fetch_text: unreachable");
}

/** Does the parsed body carry the rotation signal field? */
function hasRotationSignal(text: string, field: string): boolean {
  try {
    const parsed = JSON.parse(text);
    return (
      parsed !== null &&
      typeof parsed === "object" &&
      field in (parsed as Record<string, unknown>)
    );
  } catch {
    return false;
  }
}

export async function stepFetchText(
  ctx: PipelineContext,
  config: FetchConfig,
  stepIndex = -1,
): Promise<PipelineContext> {
  const baseUrl = evalTemplate(config.url, ctx);

  // Build the ordered candidate list. Without rotate_urls it is a single URL.
  const candidates =
    config.rotate_urls && config.rotate_urls.length > 0
      ? config.rotate_urls.map((u) => evalTemplate(u, ctx))
      : [baseUrl];

  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    ...config.headers,
  };
  if (ctx.cookieHeader) {
    headers["Cookie"] = ctx.cookieHeader;
  }

  let cookieHeader = ctx.cookieHeader;
  let lastResult: TextResult | null = null;

  for (let i = 0; i < candidates.length; i += 1) {
    const requestUrl = withParams(candidates[i] as string, config, ctx);
    assertSafeRequestUrl(requestUrl);
    assertRuntimeNetworkAllowed(ctx, {
      action: "fetch_text",
      step: stepIndex,
      config,
      url: requestUrl,
      access: networkAccessForMethod(config.method),
    });

    if (cookieHeader) headers["Cookie"] = cookieHeader;
    const result = await fetchTextOnce(requestUrl, config, headers, stepIndex);
    lastResult = result;

    // Capture session cookies (host-scoped) so later steps can send them.
    if (config.capture_cookies && result.setCookieLines.length > 0) {
      if (sameRegistrableHost(requestUrl, result.finalUrl)) {
        const captured = parseSetCookiePairs(result.setCookieLines);
        const merged = mergeCookieHeader(cookieHeader, captured);
        cookieHeader = merged === "" ? cookieHeader : merged;
      }
    }

    // Rotation: if the body signals the wrong endpoint and another candidate
    // remains, advance. Bounded by candidates.length — cannot loop forever.
    const isLastCandidate = i === candidates.length - 1;
    if (
      config.rotate_on_field &&
      !isLastCandidate &&
      hasRotationSignal(result.text, config.rotate_on_field)
    ) {
      continue;
    }
    break;
  }

  const out: PipelineContext = { ...ctx, data: lastResult?.text ?? "" };
  if (cookieHeader !== undefined) out.cookieHeader = cookieHeader;
  return out;
}

registerStep("fetch_text", stepFetchText as StepHandler);
