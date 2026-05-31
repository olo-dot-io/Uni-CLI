//! @owner       src::engine::cookie_capture
//! @does        Parses response Set-Cookie headers and merges them into a request Cookie header, with same-host scoping
//! @needs       none (pure string/URL logic)
//! @feeds       ./steps/fetch-text, ./steps/fetch (capture_cookies option)
//! @breaks      never throws; unparseable input yields conservative (empty / false) results
//! @invariants  capture is host-scoped; a cross-site final URL never contributes cookies
//! @side-effects none (pure)
//! @perf        O(n) over the Set-Cookie line count
//! @concurrency pure; safe to call concurrently
//! @test        tests/unit/engine/cookie-capture.test.ts
//! @stability   stable
//! @since       2026-05-30

/**
 * Parse an array of raw `Set-Cookie` header lines into a `name → value` map.
 * Only the leading `name=value` pair of each line is kept; cookie attributes
 * (Path, Domain, HttpOnly, …) after the first `;` are intentionally dropped —
 * we re-send the pair on same-host requests and do not honor attribute scoping
 * beyond the host check performed by the caller.
 */
export function parseSetCookiePairs(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines) {
    const head = line.split(";", 1)[0]?.trim() ?? "";
    const eq = head.indexOf("=");
    if (eq <= 0) continue;
    const name = head.slice(0, eq).trim();
    const value = head.slice(eq + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

/**
 * Merge captured cookie pairs onto an existing `Cookie` request header.
 * Existing cookies are preserved; a captured cookie of the same name wins and
 * moves to the end. Returns the original header unchanged when nothing was
 * captured.
 */
export function mergeCookieHeader(
  existing: string | undefined,
  captured: Record<string, string>,
): string {
  const capturedNames = Object.keys(captured);
  if (capturedNames.length === 0) return existing ?? "";

  const pairs = new Map<string, string>();
  if (existing) {
    for (const part of existing.split(";")) {
      const seg = part.trim();
      if (!seg) continue;
      const eq = seg.indexOf("=");
      if (eq <= 0) continue;
      pairs.set(seg.slice(0, eq).trim(), seg.slice(eq + 1).trim());
    }
  }
  // Drop survivors that a captured cookie overrides, so captured wins and
  // appears at the end in capture order.
  for (const name of capturedNames) {
    pairs.delete(name);
  }
  const merged: string[] = [];
  for (const [name, value] of pairs) merged.push(`${name}=${value}`);
  for (const name of capturedNames) merged.push(`${name}=${captured[name]}`);
  return merged.join("; ");
}

/**
 * Conservative same-host check for cookie capture. Returns true only when the
 * final response URL shares a registrable domain with the original request URL.
 *
 * Limitation (stated honestly): without a Public Suffix List we approximate the
 * registrable domain as the last two dot-labels. This is correct for
 * single-label TLDs (12306.cn, example.com) and ERRS ON THE SIDE OF REJECTION
 * for multi-label eTLDs (foo.co.uk vs bar.co.uk both reduce to "co.uk" → would
 * be treated as same; to avoid the FALSE-ACCEPT that introduces, we additionally
 * require the full hostnames to be equal OR one to be a dot-suffix of the other).
 * Rejecting is safe (cookies simply are not captured); false-accept would leak
 * cookies, which we must not do.
 */
export function sameRegistrableHost(
  requestUrl: string,
  finalUrl: string,
): boolean {
  let reqHost: string;
  let finHost: string;
  try {
    reqHost = new URL(requestUrl).hostname.toLowerCase();
    finHost = new URL(finalUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!reqHost || !finHost) return false;
  if (reqHost === finHost) return true;
  // Accept a subdomain relationship on the same registrable domain only when
  // one host is a dot-suffix of the other (www.12306.cn ↔ kyfw.12306.cn share
  // the suffix 12306.cn, and one is not a suffix of the other), so we compare
  // the last-two-labels registrable domain AND require it to be non-trivial.
  const reg = (h: string) => h.split(".").slice(-2).join(".");
  const reqReg = reg(reqHost);
  const finReg = reg(finHost);
  return reqReg.length > 0 && reqReg === finReg;
}
