/**
 * @owner src/engine/request-credentials.ts
 * @does Resolves site-scoped cookie credentials after a direct URL reports authentication failure.
 * @needs Adapter domain metadata and the shared cookie acquisition owner.
 * @feeds Evidence readers and resource downloads.
 * @invariants Public reads perform no browser I/O; explicit request credentials remain caller-owned.
 * @side-effects Reads only the requested site's credential source when called.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { getAllAdapters } from "../registry.js";
import { acquireCookies, formatCookieHeader } from "./cookies.js";

const recoveryEnabled = new AsyncLocalStorage<boolean>();

export function credentialRecoveryEnabled(): boolean {
  return recoveryEnabled.getStore() !== false;
}

export function withCredentialRecovery<T>(
  enabled: boolean | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  return recoveryEnabled.run(enabled ?? credentialRecoveryEnabled(), operation);
}

export async function acquireRequestCookieHeader(
  url: string,
  options: { fresh?: boolean; signal?: AbortSignal } = {},
): Promise<string | undefined> {
  options.signal?.throwIfAborted();
  if (!credentialRecoveryEnabled()) return undefined;
  const target = new URL(url);
  let bestDomain = "";
  const sites = new Set<string>();
  for (const adapter of getAllAdapters()) {
    const domains = [
      adapter.domain,
      ...Object.values(adapter.commands).map((command) => command.domain),
    ];
    for (const value of domains) {
      if (!value) continue;
      const domain = value.toLowerCase().replace(/^\./, "");
      if (target.hostname !== domain && !target.hostname.endsWith(`.${domain}`))
        continue;
      if (domain.length < bestDomain.length) continue;
      if (domain.length > bestDomain.length) {
        bestDomain = domain;
        sites.clear();
      }
      sites.add(adapter.name);
    }
  }
  const site = sites.size === 1 ? [...sites][0] : target.hostname;
  const outcome = await acquireCookies(site, target.hostname, {
    ...(options.fresh ? { source: "browser" as const } : {}),
    url: target.toString(),
    signal: options.signal,
  });
  options.signal?.throwIfAborted();
  if (outcome.status !== "loaded") return undefined;
  return formatCookieHeader(outcome.cookies) || undefined;
}
