//! @owner       src::engine::steps::fetch_text
//! @does        HTTP request returning size-bounded validated textual content; rejects binary MIME/magic before downstream text conversion, preserves status-specific recovery, and supports optional session-cookie capture and bounded endpoint rotation
//! @needs       ./fetch (FetchConfig), ../proxy, ../cookie-capture, ../ssrf, ../template, ../runtime-resource-guard
//! @feeds       ./index (barrel), pipeline executor via registry "fetch_text"
//! @breaks      PipelineError on HTTP/network failures or unsupported binary content; wrong status guidance can make agents repair valid URLs instead of respecting auth, rate-limit, or upstream retry boundaries
//! @invariants  every fetched URL passes SSRF validation and the canonical proxy boundary; response bodies never exceed MAX_TEXT_RESOURCE_BYTES; non-text MIME and recognizable binary responses never become successful text; 429 never reports URL staleness; cookie capture is host-scoped; rotation is bounded
//! @side-effects network I/O
//! @perf        one fetch per attempt; rotation adds at most rotate_urls.length fetches
//! @concurrency stateless per call
//! @test        tests/unit/engine/steps/fetch-text-session.test.ts
//! @stability   stable
//! @since       2026-05-30 (capture/rotation added)

import { USER_AGENT } from "../../constants.js";
import { setTimeout as delay } from "node:timers/promises";
import { registerStep, type StepHandler } from "../step-registry.js";
import { type PipelineContext, PipelineError } from "../executor.js";
import { UnsafeRequestUrlError } from "../ssrf.js";
import { evalTemplate } from "../template.js";
import { describeNetworkFailure } from "../proxy.js";
import { assertRuntimeNetworkAllowed } from "../runtime-resource-guard.js";
import {
  fetchWithValidatedRedirects,
  RedirectLimitError,
} from "../validated-fetch.js";
import {
  parseSetCookiePairs,
  mergeCookieHeader,
  sameRegistrableHost,
} from "../cookie-capture.js";
import {
  networkAccessForMethod,
  normalizeFetchAttempts,
  resolveHeaderTemplates,
  type FetchConfig,
} from "./fetch.js";

export interface TextResource {
  text: string;
  /** Final response URL after redirects; falls back to the request URL. */
  finalUrl: string;
  contentType: string;
  status: number;
  /** Raw Set-Cookie lines from the response, empty when none. */
  setCookieLines: string[];
}

export interface FetchTextResourceOptions {
  signal?: AbortSignal;
  validateRequest?: (url: string) => void;
}

export const MAX_TEXT_RESOURCE_BYTES = 5_000_000;

const TEXTUAL_CONTENT_TYPE =
  /^(?:text\/|application\/(?:json|xml|xhtml\+xml|javascript|x-javascript|graphql|yaml|x-yaml|toml|x-toml|ndjson|x-ndjson|json-seq|csv|markdown|sql|x-www-form-urlencoded|[a-z0-9.+-]+\+(?:json|xml))$)/i;

const BINARY_SIGNATURES: ReadonlyArray<{
  bytes: readonly number[];
  contentType: string;
}> = [
  { bytes: [0x25, 0x50, 0x44, 0x46, 0x2d], contentType: "application/pdf" },
  { bytes: [0x50, 0x4b, 0x03, 0x04], contentType: "application/zip" },
  { bytes: [0x1f, 0x8b], contentType: "application/gzip" },
  {
    bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],
    contentType: "application/x-7z-compressed",
  },
  { bytes: [0x52, 0x61, 0x72, 0x21], contentType: "application/vnd.rar" },
  { bytes: [0x00, 0x61, 0x73, 0x6d], contentType: "application/wasm" },
  {
    bytes: [0xd0, 0xcf, 0x11, 0xe0],
    contentType: "application/x-ole-storage",
  },
  { bytes: [0x7f, 0x45, 0x4c, 0x46], contentType: "application/x-elf" },
];

function binarySignature(bytes: Uint8Array): string | undefined {
  return BINARY_SIGNATURES.find(({ bytes: signature }) =>
    signature.every((byte, index) => bytes[index] === byte),
  )?.contentType;
}

function unsupportedContentTypeError(
  requestUrl: string,
  contentType: string,
  stepIndex: number,
): PipelineError {
  const isPdf = /^application\/pdf\b/i.test(contentType);
  return new PipelineError(
    `fetch_text rejected non-text content type "${contentType || "unknown binary"}" from ${requestUrl}.`,
    {
      step: stepIndex,
      action: "fetch_text",
      config: { url: requestUrl },
      errorType: "unsupported_content_type",
      url: requestUrl,
      suggestion: isPdf
        ? "Use the registered PDF reader so page text is extracted instead of decoding binary bytes."
        : "Use a registered reader for this content type; fetch_text accepts textual responses only.",
      retryable: false,
      alternatives: isPdf
        ? [
            `unicli scholar-artifacts read-pdf '${requestUrl.replaceAll("'", "'\\''")}'`,
          ]
        : [],
      preserveErrorCode: true,
    },
  );
}

function responseTooLargeError(
  requestUrl: string,
  observedBytes: number,
  stepIndex: number,
): PipelineError {
  return new PipelineError(
    `fetch_text stopped after ${observedBytes} bytes because the response from ${requestUrl} exceeds the ${MAX_TEXT_RESOURCE_BYTES}-byte text limit.`,
    {
      step: stepIndex,
      action: "fetch_text",
      config: { url: requestUrl },
      errorType: "response_too_large",
      url: requestUrl,
      suggestion:
        "Use a range-capable or source-specific artifact reader instead of loading the full response as text.",
      retryable: false,
      alternatives: [],
      preserveErrorCode: true,
    },
  );
}

async function readBoundedBody(
  response: Response,
  requestUrl: string,
  stepIndex: number,
): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_TEXT_RESOURCE_BYTES
  ) {
    await response.body?.cancel();
    throw responseTooLargeError(requestUrl, declaredLength, stepIndex);
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_TEXT_RESOURCE_BYTES) {
        await reader.cancel();
        throw responseTooLargeError(requestUrl, total, stepIndex);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
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

function httpFailureSuggestion(response: Response, requestUrl: string): string {
  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after")?.trim();
    const window = retryAfter
      ? `the upstream Retry-After window (${retryAfter})`
      : "the upstream retry window";
    return `Wait for ${window}, then retry the same request: ${requestUrl}`;
  }
  if (response.status === 401 || response.status === 403) {
    return `Authenticate at the source's declared credential boundary, then retry: ${requestUrl}`;
  }
  if (response.status === 404 || response.status === 410) {
    return `Check whether the canonical source URL moved or was removed: ${requestUrl}`;
  }
  if (response.status >= 500) {
    return `The upstream service failed; retry after its recovery window: ${requestUrl}`;
  }
  return `Inspect the HTTP ${response.status} response and request contract for: ${requestUrl}`;
}

/** One request with the existing retry/backoff/error contract. */
export async function fetchTextResource(
  requestUrl: string,
  config: FetchConfig,
  headers: Record<string, string>,
  stepIndex: number,
  options: FetchTextResourceOptions = {},
): Promise<TextResource> {
  const method = config.method ?? "GET";
  const fetchInit: RequestInit = {
    method,
    headers,
    ...(options.signal ? { signal: options.signal } : {}),
  };

  const maxAttempts = normalizeFetchAttempts(config.retry);
  const baseDelay = config.backoff ?? 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const { response: resp, finalUrl } = await fetchWithValidatedRedirects(
        requestUrl,
        fetchInit,
        { validateRequest: options.validateRequest },
      );
      if (resp.ok) {
        const contentType = (resp.headers.get("content-type") ?? "")
          .split(";", 1)[0]
          .trim();
        if (contentType && !TEXTUAL_CONTENT_TYPE.test(contentType)) {
          await resp.body?.cancel();
          throw unsupportedContentTypeError(requestUrl, contentType, stepIndex);
        }
        const bytes = await readBoundedBody(resp, requestUrl, stepIndex);
        const inferredBinaryType = binarySignature(bytes);
        if (inferredBinaryType) {
          throw unsupportedContentTypeError(
            requestUrl,
            `${inferredBinaryType} (magic bytes)`,
            stepIndex,
          );
        }
        const text = new TextDecoder().decode(bytes);
        const getSetCookie = (
          resp.headers as Headers & { getSetCookie?: () => string[] }
        ).getSetCookie;
        const setCookieLines =
          typeof getSetCookie === "function"
            ? getSetCookie.call(resp.headers)
            : [];
        return {
          text,
          finalUrl,
          contentType,
          status: resp.status,
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
        await delay(baseDelay * 2 ** (attempt - 1), undefined, {
          signal: options.signal,
        });
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
          suggestion: httpFailureSuggestion(resp, requestUrl),
          retryable,
          alternatives:
            resp.status === 401 || resp.status === 403
              ? ["unicli auth setup <site>"]
              : [],
        },
      );
    } catch (err) {
      options.signal?.throwIfAborted();
      const isLastAttempt = attempt === maxAttempts;
      if (
        err instanceof PipelineError ||
        err instanceof UnsafeRequestUrlError
      ) {
        throw err;
      }
      if (err instanceof RedirectLimitError) {
        throw new PipelineError(err.message, {
          step: stepIndex,
          action: "fetch_text",
          config: { url: requestUrl },
          errorType: "http_error",
          url: requestUrl,
          suggestion:
            "Use a canonical source URL with a bounded redirect chain.",
          retryable: false,
          alternatives: [],
        });
      }
      if (isLastAttempt) {
        const message = describeNetworkFailure(err);
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
      await delay(baseDelay * 2 ** (attempt - 1), undefined, {
        signal: options.signal,
      });
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
    ...resolveHeaderTemplates(config.headers, ctx),
  };
  if (ctx.cookieHeader) {
    headers["Cookie"] = ctx.cookieHeader;
  }

  let cookieHeader = ctx.cookieHeader;
  let lastResult: TextResource | null = null;

  for (let i = 0; i < candidates.length; i += 1) {
    const requestUrl = withParams(candidates[i] as string, config, ctx);

    if (cookieHeader) headers["Cookie"] = cookieHeader;
    const result = await fetchTextResource(
      requestUrl,
      config,
      headers,
      stepIndex,
      {
        signal: ctx.signal,
        validateRequest: (url) =>
          assertRuntimeNetworkAllowed(ctx, {
            action: "fetch_text",
            step: stepIndex,
            config,
            url,
            access: networkAccessForMethod(config.method),
          }),
      },
    );
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
