/**
 * SSRF defence — reject request URLs that point at non-http(s) schemes or
 * reserved local address ranges before we issue the fetch.
 *
 * The attack shape this blocks: a YAML adapter takes `${{ args.query }}`
 * and interpolates it into the request URL. An attacker (or a careless
 * template author) feeds a payload like `http://169.254.169.254/latest/meta-data/`
 * (AWS IMDS) or `http://127.0.0.1:19825/internal` (Uni-CLI daemon). Without
 * this guard the runner happily fetches it and returns the response —
 * leaking credentials or driving the daemon.
 *
 * The check is intentionally conservative: only http/https, and no loopback
 * / link-local / private metadata addresses. Set `UNICLI_ALLOW_LOCAL=1` to
 * bypass — useful for local dev / testing where a developer intentionally
 * targets `127.0.0.1` or a docker compose stack on a private subnet.
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
