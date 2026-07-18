/**
 * @owner       src::engine::ssrf
 * @does        Rejects non-HTTP schemes, known metadata hostnames, and non-globally-routable IP literals before adapter fetches execute.
 * @needs       node:net BlockList/isIP, WHATWG URL, UNICLI_ALLOW_LOCAL explicit development override
 * @feeds       validated-fetch and transport HTTP request guards
 * @breaks      Invalid, special-purpose, mapped, local, link-local, private, benchmark, documentation, multicast, and reserved IP literals throw before network I/O.
 * @invariants  Only http/https pass; IANA non-global IPv4/IPv6 literal ranges stay blocked unless explicitly enabled; ordinary DNS names are not claimed to be resolution-pinned.
 * @side-effects Reads one environment flag and performs no I/O.
 * @perf        O(URL length) parsing plus bounded stdlib address-block checks.
 * @concurrency Module block lists are immutable after initialization.
 * @test        tests/unit/audit-hardening.test.ts, tests/unit/engine/steps/fetch-text-session.test.ts
 * @stability   stable
 * @since       2026-04-01
 */

import { BlockList, isIP } from "node:net";

type AddressFamily = "ipv4" | "ipv6";
type AddressBlock = readonly [address: string, prefix: number];

const NON_GLOBAL_IPV4: readonly AddressBlock[] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const GLOBALLY_REACHABLE_IPV4_EXCEPTIONS: readonly AddressBlock[] = [
  ["192.0.0.9", 32],
  ["192.0.0.10", 32],
];

const NON_GLOBAL_IPV6: readonly AddressBlock[] = [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["100:0:0:1::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
];

const GLOBALLY_REACHABLE_IPV6_EXCEPTIONS: readonly AddressBlock[] = [
  ["2001:1::1", 128],
  ["2001:1::2", 128],
  ["2001:1::3", 128],
  ["2001:3::", 32],
  ["2001:4:112::", 48],
  ["2001:20::", 28],
  ["2001:30::", 28],
];

function blockList(
  family: AddressFamily,
  blocks: readonly AddressBlock[],
): BlockList {
  const list = new BlockList();
  for (const [address, prefix] of blocks) {
    list.addSubnet(address, prefix, family);
  }
  return list;
}

const NON_GLOBAL = {
  ipv4: blockList("ipv4", NON_GLOBAL_IPV4),
  ipv6: blockList("ipv6", NON_GLOBAL_IPV6),
} as const;

const GLOBAL_EXCEPTIONS = {
  ipv4: blockList("ipv4", GLOBALLY_REACHABLE_IPV4_EXCEPTIONS),
  ipv6: blockList("ipv6", GLOBALLY_REACHABLE_IPV6_EXCEPTIONS),
} as const;

export class UnsafeRequestUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeRequestUrlError";
  }
}

function isNonGlobalIp(host: string): boolean {
  const version = isIP(host);
  if (version === 0) return false;
  const family: AddressFamily = version === 4 ? "ipv4" : "ipv6";
  if (GLOBAL_EXCEPTIONS[family].check(host, family)) return false;
  return NON_GLOBAL[family].check(host, family);
}

export function assertSafeRequestUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeRequestUrlError(
      `invalid URL for pipeline fetch: ${raw.slice(0, 120)}`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeRequestUrlError(
      `disallowed URL scheme for pipeline fetch: ${url.protocol} (only http/https)`,
    );
  }
  if (process.env.UNICLI_ALLOW_LOCAL === "1") return;
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const host =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  const metadataHostname =
    host === "metadata" ||
    host === "metadata.google.internal" ||
    host === "instance-data";
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    metadataHostname ||
    isNonGlobalIp(host)
  ) {
    throw new UnsafeRequestUrlError(
      `blocked fetch to reserved/local address ${host} — set UNICLI_ALLOW_LOCAL=1 to override`,
    );
  }
}
