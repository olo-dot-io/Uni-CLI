/**
 * @owner       src::engine::http-response
 * @does        Own validated HTTP retries, server retry windows, and response failure classification.
 * @needs       validated-fetch, proxy, executor, node timers
 * @feeds       JSON and text pipeline requests, HTTP transport, OpenReview retry parsing
 * @invariants  Failed response bodies are released before retry; cancellation preserves its original reason; challenge responses never become successful content.
 * @side-effects Network requests and cancellable retry waits.
 * @test        tests/scenarios/internet-access.ts
 */

import { setTimeout as delay } from "node:timers/promises";
import { OperationOutcomeAmbiguousError } from "../transport/contained-process.js";
import { PipelineError } from "./executor.js";
import { describeNetworkFailure } from "./proxy.js";
import { UnsafeRequestUrlError } from "./ssrf.js";
import {
  fetchWithValidatedRedirects,
  RedirectLimitError,
} from "./validated-fetch.js";

export function retryAfterMilliseconds(
  value: string | null,
  now = Date.now(),
): number | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const milliseconds = Math.ceil(Number(raw) * 1000);
    return Number.isFinite(milliseconds) ? milliseconds : undefined;
  }
  if (!/[a-z]/i.test(raw)) return undefined;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : undefined;
}

export function isHtmlVerificationChallenge(html: string): boolean {
  if (!/^\s*(?:<!doctype\s+html|<!--|<(?:html|head|title|body)\b)/i.test(html))
    return false;
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  const heading = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? "";
  const label = `${title} ${heading}`.replace(/<[^>]*>/g, " ");
  const verificationHeading =
    /(?:verifying|checking) your browser|just a moment|making sure you(?:'|&#39;|&apos;|’)?re not a bot/i.test(
      label,
    );
  return (
    verificationHeading &&
    /enable javascript and cookies|complete the check|security verification|performing security verification|anubis_challenge|anubis_version|\/\.within\.website\/x\/cmd\/anubis\//i.test(
      html,
    )
  );
}

export function challengeRequiredError(
  url: string,
  action: string,
  step: number,
  statusCode?: number,
): PipelineError {
  return new PipelineError(
    "The source returned a browser-verification challenge instead of document content.",
    {
      step,
      action,
      config: { url },
      url,
      statusCode,
      errorType: "challenge_required",
      preserveErrorCode: true,
      retryable: false,
      suggestion:
        "Use an available official API or a browser reader. Retry with refreshed browser credentials only through an adapter that declares and consumes them.",
      alternatives: ["unicli browser doctor --json"],
    },
  );
}

function retryableStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    (status >= 520 && status <= 524)
  );
}

function httpFailureSuggestion(response: Response, requestUrl: string): string {
  if (response.status === 429) {
    const window = response.headers.get("retry-after")?.trim();
    return `Wait for ${window ? `the upstream Retry-After window (${window})` : "the upstream retry window"}, then retry ${requestUrl}`;
  }
  if (response.status === 401 || response.status === 403) {
    return `Refresh the source's declared header, cookie, or token credentials and account access, then retry ${requestUrl}`;
  }
  if (response.status === 402)
    return "Add provider credits or quota before retrying this request.";
  if (response.status === 404 || response.status === 410)
    return `Check whether the canonical source URL moved or was removed ${requestUrl}`;
  if (response.status >= 500)
    return `The upstream service failed. Check its recovery status before retrying ${requestUrl}`;
  return `Inspect the HTTP ${response.status} response and request contract for ${requestUrl}`;
}

async function waitForRetry(
  milliseconds: number,
  signal: AbortSignal | null | undefined,
): Promise<void> {
  let remaining = Math.max(0, milliseconds);
  // Node clamps larger delays to 1 ms; chunk them to preserve the server's minimum wait.
  do {
    signal?.throwIfAborted();
    const chunk = Math.min(remaining, 2_147_483_647);
    try {
      await delay(chunk, undefined, { signal: signal ?? undefined });
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    }
    remaining -= chunk;
  } while (remaining > 0);
}

async function responsePreview(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let preview = "";
  try {
    while (preview.length < 200) {
      const { value, done } = await reader.read();
      if (done) break;
      preview += decoder.decode(value.subarray(0, 800), { stream: true });
    }
    return preview.slice(0, 200);
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

export async function fetchHttpResource<T>(
  url: string,
  init: RequestInit,
  options: {
    action: "fetch" | "fetch_text";
    step: number;
    retry?: number;
    backoff?: number;
    validateRequest?: (url: string) => void;
  },
  consume: (response: Response, finalUrl: string) => Promise<T>,
): Promise<T> {
  const { action, step } = options;
  const attempts = Number.isFinite(options.retry ?? 1)
    ? Math.max(1, Math.floor(options.retry ?? 1))
    : 1;
  const backoff = Number.isFinite(options.backoff ?? 1000)
    ? Math.max(0, options.backoff ?? 1000)
    : 1000;
  const signal = init.signal;
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    let result;
    try {
      result = await fetchWithValidatedRedirects(url, init, {
        validateRequest: options.validateRequest,
      });
      const { response, finalUrl } = result;
      if (response.headers.get("cf-mitigated")?.toLowerCase() === "challenge") {
        await response.body?.cancel();
        signal?.throwIfAborted();
        throw challengeRequiredError(url, action, step, response.status);
      }
      if (response.ok) return await consume(response, finalUrl);
    } catch (error) {
      signal?.throwIfAborted();
      if (
        error instanceof PipelineError ||
        error instanceof UnsafeRequestUrlError
      )
        throw error;
      if (error instanceof RedirectLimitError) {
        throw new PipelineError(error.message, {
          step,
          action,
          config: { url },
          url,
          errorType: "http_error",
          retryable: false,
          suggestion:
            "Use a canonical source URL with a bounded redirect chain.",
        });
      }
      if (
        result?.response.ok &&
        !["GET", "HEAD", "OPTIONS"].includes(
          (init.method ?? "GET").toUpperCase(),
        )
      ) {
        const detail = new PipelineError(
          `The server accepted ${init.method} ${url}, then the response body was interrupted.`,
          {
            step,
            action,
            config: { url, method: init.method },
            url,
            statusCode: result.response.status,
            errorType: "operation_outcome_ambiguous",
            preserveErrorCode: true,
            retryable: false,
            suggestion:
              "Read the current resource state before deciding whether to repeat this operation.",
          },
        );
        throw new OperationOutcomeAmbiguousError(
          `${init.method} ${url}`,
          detail,
        );
      }
      if (attempt < attempts) {
        await waitForRetry(backoff * 2 ** (attempt - 1), signal);
        continue;
      }
      throw new PipelineError(
        `Network request failed for ${url}: ${describeNetworkFailure(error)}`,
        {
          step,
          action,
          config: { url, method: init.method },
          url,
          errorType: "network_error",
          retryable: true,
          suggestion: `Check proxy configuration and connectivity to ${new URL(url).origin}.`,
        },
      );
    }
    const { response } = result;
    const retryable = retryableStatus(response.status);
    if (retryable && attempt < attempts) {
      await response.body?.cancel();
      const serverDelay =
        retryAfterMilliseconds(response.headers.get("retry-after")) ?? 0;
      await waitForRetry(
        Math.max(serverDelay, backoff * 2 ** (attempt - 1)),
        signal,
      );
      continue;
    }
    let preview = "";
    try {
      preview = await responsePreview(response);
    } catch {
      signal?.throwIfAborted();
    }
    signal?.throwIfAborted();
    throw new PipelineError(
      `HTTP ${response.status} ${response.statusText} from ${url}`,
      {
        step,
        action,
        config: { url, method: init.method },
        url,
        statusCode: response.status,
        responsePreview: preview,
        errorType: "http_error",
        retryable,
        suggestion: httpFailureSuggestion(response, url),
        alternatives:
          response.status === 401 || response.status === 403
            ? ["unicli auth setup <site>"]
            : [],
      },
    );
  }
}
