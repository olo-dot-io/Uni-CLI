/**
 * @owner       src::engine::validated-fetch
 * @does        Executes proxy-aware HTTP requests while validating the initial URL and every redirect target, bounding redirect chains, and stripping credentials across origins.
 * @needs       canonical proxy fetch and SSRF URL validation
 * @feeds       bounded text reads and transactional downloads
 * @breaks      Automatic redirects can cross an approved public URL into a reserved address or leak caller credentials to another origin.
 * @invariants  Every hop is validated before network I/O; only standard redirect statuses follow Location; at most ten redirects follow by default; cross-origin hops remove authorization, proxy-authorization, and cookie headers.
 * @side-effects Performs network I/O through the canonical proxy boundary.
 * @perf        Adds O(redirect count) validation with a fixed upper bound.
 * @concurrency Request and redirect state are invocation-local.
 * @test        tests/unit/engine/steps/fetch-text-session.test.ts and tests/unit/engine/steps/download-cancellation.test.ts
 * @stability   experimental
 * @since       2026-07-17
 */

import { fetchWithProxy } from "./proxy.js";
import { assertSafeRequestUrl } from "./ssrf.js";

const DEFAULT_MAX_REDIRECTS = 10;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class RedirectLimitError extends Error {
  readonly url: string;
  readonly limit: number;

  constructor(url: string, limit: number) {
    super(`request exceeded ${limit} redirects from ${url}`);
    this.name = "RedirectLimitError";
    this.url = url;
    this.limit = limit;
  }
}

export interface ValidatedFetchOptions {
  validateRequest?: (url: string) => void;
  maxRedirects?: number;
  env?: NodeJS.ProcessEnv;
}

function withoutCrossOriginCredentials(
  headers: RequestInit["headers"],
): RequestInit["headers"] {
  if (!headers) return undefined;
  const filtered = new Headers(headers);
  filtered.delete("authorization");
  filtered.delete("proxy-authorization");
  filtered.delete("cookie");
  return filtered;
}

function redirectedRequestInit(
  currentUrl: string,
  nextUrl: string,
  status: number,
  init: RequestInit,
): RequestInit {
  const method = (init.method ?? "GET").toUpperCase();
  const changesToGet =
    (status === 303 && method !== "HEAD") ||
    ((status === 301 || status === 302) && method === "POST");
  const headers =
    new URL(currentUrl).origin === new URL(nextUrl).origin
      ? init.headers
      : withoutCrossOriginCredentials(init.headers);
  if (!changesToGet) return { ...init, headers };
  const normalizedHeaders = new Headers(headers);
  normalizedHeaders.delete("content-encoding");
  normalizedHeaders.delete("content-language");
  normalizedHeaders.delete("content-location");
  normalizedHeaders.delete("content-type");
  return {
    ...init,
    method: "GET",
    headers: normalizedHeaders,
    body: undefined,
  };
}

export async function fetchWithValidatedRedirects(
  requestUrl: string,
  init: RequestInit = {},
  options: ValidatedFetchOptions = {},
): Promise<{ response: Response; finalUrl: string }> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0) {
    throw new TypeError("maxRedirects must be a non-negative integer");
  }
  let currentUrl = requestUrl;
  let currentInit = init;
  for (let redirects = 0; ; redirects += 1) {
    assertSafeRequestUrl(currentUrl);
    options.validateRequest?.(currentUrl);
    const response = await fetchWithProxy(
      currentUrl,
      { ...currentInit, redirect: "manual" },
      options.env,
    );
    const location = response.headers.get("location");
    if (!REDIRECT_STATUSES.has(response.status) || !location) {
      return { response, finalUrl: currentUrl };
    }
    await response.body?.cancel();
    if (redirects >= maxRedirects) {
      throw new RedirectLimitError(requestUrl, maxRedirects);
    }
    const nextUrl = new URL(location, currentUrl).toString();
    currentInit = redirectedRequestInit(
      currentUrl,
      nextUrl,
      response.status,
      currentInit,
    );
    currentUrl = nextUrl;
  }
}
