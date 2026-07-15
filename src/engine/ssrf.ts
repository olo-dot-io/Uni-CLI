/**
 * @owner       src/engine/ssrf.ts
 * @does        Reject non-HTTP schemes and reserved local/metadata addresses before adapter fetches execute.
 * @needs       WHATWG URL, UNICLI_ALLOW_LOCAL explicit development override
 * @feeds       src/engine/executor.ts and transport HTTP request guards
 * @breaks      Invalid or disallowed URLs throw before any network request is issued.
 * @invariants  Only http/https pass; loopback, link-local, private metadata, and private IPv4 ranges stay blocked unless explicitly enabled.
 * @side-effects Reads one environment flag and performs no I/O.
 * @perf        O(URL length) parsing and bounded prefix checks.
 * @concurrency Pure apart from the process environment read.
 * @test        tests/unit/ssrf.test.ts
 * @stability   stable
 * @since       2026-04-01
 */
export function assertSafeRequestUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`invalid URL for pipeline fetch: ${raw.slice(0, 120)}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(
      `disallowed URL scheme for pipeline fetch: ${u.protocol} (only http/https)`,
    );
  }
  if (process.env.UNICLI_ALLOW_LOCAL === "1") return;
  // Node's URL.hostname keeps the IPv6 brackets (`[::1]`) around the
  // zero-compressed literal; strip them before comparing.
  const hostnameLower = u.hostname.toLowerCase();
  const host =
    hostnameLower.startsWith("[") && hostnameLower.endsWith("]")
      ? hostnameLower.slice(1, -1)
      : hostnameLower;
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::" ||
    host === "::1" ||
    host === "metadata.google.internal" ||
    host === "metadata" ||
    // IPv6 link-local (fe80::/10) and unique-local (fc00::/7 → fc/fd prefix)
    host.startsWith("fe80:") ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    // IPv4 CIDR check — crude but covers the most common SSRF vectors.
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("169.254.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    throw new Error(
      `blocked fetch to reserved/local address ${host} — set UNICLI_ALLOW_LOCAL=1 to override`,
    );
  }
}
