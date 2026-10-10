/**
 * @owner src/engine/cookie-scope.ts
 * @does Select live request cookies by Chromium domain, path, expiry, and transport metadata.
 * @needs URL and Chromium's microsecond epoch.
 * @feeds Cookie extraction, direct Chromium reads, and browser auth synchronization.
 * @invariants Host-only cookies match one host; domain cookies match label suffixes; duplicate names prefer the longest request path.
 * @side-effects None.
 */

export interface RequestCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  expires?: number;
}

export function chromeExpiresToUnixSeconds(expiresUtc: number): number {
  return expiresUtc / 1_000_000 - 11_644_473_600;
}

export function cookieMatchesRequest(
  cookie: RequestCookie,
  request: URL,
  now = Date.now() / 1000,
): boolean {
  const domain = cookie.domain.toLowerCase();
  const host = domain.replace(/^\./, "");
  if (
    request.hostname !== host &&
    !(domain.startsWith(".") && request.hostname.endsWith(`.${host}`))
  )
    return false;
  if (
    cookie.expires !== undefined &&
    cookie.expires > 0 &&
    cookie.expires <= now
  )
    return false;
  if (cookie.secure && request.protocol !== "https:") return false;
  const path = cookie.path || "/";
  return (
    request.pathname === path ||
    (request.pathname.startsWith(path) &&
      (path.endsWith("/") || request.pathname[path.length] === "/"))
  );
}

export function cookieValuesForUrl(
  cookies: readonly RequestCookie[],
  url: string,
): Record<string, string> {
  const request = new URL(url);
  const result: Record<string, string> = {};
  for (const cookie of cookies
    .filter((candidate) => cookieMatchesRequest(candidate, request))
    .sort(
      (left, right) =>
        (right.path?.length ?? 1) - (left.path?.length ?? 1) ||
        right.domain.replace(/^\./, "").length -
          left.domain.replace(/^\./, "").length,
    )) {
    if (cookie.name && !Object.hasOwn(result, cookie.name)) {
      result[cookie.name] = cookie.value;
    }
  }
  return result;
}
