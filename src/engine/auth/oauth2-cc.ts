/**
 * @owner       src::engine::auth::oauth2-cc
 * @does        OAuth 2.0 client_credentials token broker with LRU cache — issues, caches, and refreshes bearer tokens for adapters that authenticate against EPO OPS, PatSnap Eureka, Lens.org, and similar APIs.
 * @needs       node:crypto (Basic-auth + cache-key digest), global fetch
 * @feeds       src/engine/steps/oauth2-token.ts (pipeline step), src/adapters/epo/*, src/adapters/patsnap/*, src/adapters/lens/*
 * @breaks      throws Oauth2Error on token-endpoint 4xx/5xx; caller decides retry vs propagate via the patent envelope
 * @invariants  one in-flight refresh per (token_url, client_id) tuple; cache key is salted with client_id hash; tokens are evicted on TTL expiry minus the configured buffer
 * @side-effects network egress to the token endpoint; in-process Map cache (no disk persistence in v1)
 * @perf        amortized O(1) per request; first call per (token_url, client_id) blocks on network, subsequent in-window calls return cached lease
 * @concurrency safe under Node single-threaded event loop; in-flight refresh deduplicated via Promise cache
 * @test        tests/unit/engine/auth/oauth2-cc.test.ts
 * @stability   stable — internal engine surface; not exported from package root
 * @since       2026-05-18
 */

import { createHash } from "node:crypto";

export interface Oauth2ClientCredentialsConfig {
  /** Token endpoint URL (e.g. https://ops.epo.org/3.2/auth/accesstoken). */
  token_url: string;
  /** OAuth2 client identifier issued by the upstream service. */
  client_id: string;
  /** OAuth2 client secret issued by the upstream service. */
  client_secret: string;
  /** Optional OAuth2 scope string. */
  scope?: string;
  /**
   * How many seconds before the upstream-reported expiry to treat the token
   * as expired anyway. Protects against clock drift and in-flight latency.
   * Default 60.
   */
  ttl_buffer_seconds?: number;
}

export interface Oauth2TokenLease {
  /** Bearer token to put in the `Authorization` header. */
  access_token: string;
  /** Token type — always `Bearer` in practice. */
  token_type: string;
  /** Epoch milliseconds when this lease is considered expired (after buffer). */
  expires_at_ms: number;
  /** Optional OAuth2 scope echoed back by the issuer. */
  scope?: string;
}

export class Oauth2Error extends Error {
  constructor(
    public readonly token_url: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "Oauth2Error";
  }
}

interface CacheEntry {
  lease: Oauth2TokenLease;
  token_url: string;
  client_id_hash: string;
}

const leaseCache = new Map<string, CacheEntry>();
const inflightCache = new Map<string, Promise<Oauth2TokenLease>>();

function cacheKey(token_url: string, client_id: string): string {
  return createHash("sha256").update(`${token_url}:${client_id}`).digest("hex");
}

function clientIdHash(client_id: string): string {
  return createHash("sha256").update(client_id).digest("hex");
}

interface TokenResponseBody {
  access_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

/**
 * Obtain a (possibly cached) bearer-token lease via OAuth2 client_credentials.
 *
 * @throws Oauth2Error when the token endpoint refuses the credentials or
 *         returns a non-2xx status.
 */
export async function obtainClientCredentialsToken(
  config: Oauth2ClientCredentialsConfig,
): Promise<Oauth2TokenLease> {
  const { token_url, client_id, client_secret, scope } = config;
  const ttl_buffer_seconds = config.ttl_buffer_seconds ?? 60;
  const key = cacheKey(token_url, client_id);

  const cached = leaseCache.get(key);
  if (cached && cached.lease.expires_at_ms > Date.now()) {
    return cached.lease;
  }

  const inflight = inflightCache.get(key);
  if (inflight) return inflight;

  const refresh = (async (): Promise<Oauth2TokenLease> => {
    const basic = Buffer.from(`${client_id}:${client_secret}`).toString(
      "base64",
    );
    const body = new URLSearchParams({ grant_type: "client_credentials" });
    if (scope) body.set("scope", scope);

    const response = await fetch(token_url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Oauth2Error(
        token_url,
        response.status,
        `OAuth2 token endpoint returned ${response.status}: ${text.slice(0, 500)}`,
      );
    }

    const parsed = (await response.json()) as TokenResponseBody;
    const access_token =
      typeof parsed.access_token === "string" ? parsed.access_token : "";
    if (!access_token) {
      throw new Oauth2Error(
        token_url,
        response.status,
        "OAuth2 token endpoint returned 2xx without access_token",
      );
    }
    const token_type =
      typeof parsed.token_type === "string" ? parsed.token_type : "Bearer";
    const expires_in =
      typeof parsed.expires_in === "number" && parsed.expires_in > 0
        ? parsed.expires_in
        : 3600;
    const responded_scope =
      typeof parsed.scope === "string" ? parsed.scope : undefined;

    const lease: Oauth2TokenLease = {
      access_token,
      token_type,
      expires_at_ms: Date.now() + (expires_in - ttl_buffer_seconds) * 1000,
      ...(responded_scope ? { scope: responded_scope } : {}),
    };

    leaseCache.set(key, {
      lease,
      token_url,
      client_id_hash: clientIdHash(client_id),
    });
    return lease;
  })().finally(() => {
    inflightCache.delete(key);
  });

  inflightCache.set(key, refresh);
  return refresh;
}

/**
 * Drop every cached lease. Test-only helper; production code should never need
 * this because TTL eviction is automatic.
 */
export function resetOauth2Cache(): void {
  leaseCache.clear();
  inflightCache.clear();
}

/**
 * Inspect the cache for debugging / `unicli patent doctor`. Returns one entry
 * per cached lease with the access_token redacted.
 */
export function describeOauth2Cache(): Array<{
  token_url: string;
  client_id_hash: string;
  expires_at_ms: number;
}> {
  const entries: Array<{
    token_url: string;
    client_id_hash: string;
    expires_at_ms: number;
  }> = [];
  for (const [, entry] of leaseCache) {
    entries.push({
      token_url: entry.token_url,
      client_id_hash: entry.client_id_hash,
      expires_at_ms: entry.lease.expires_at_ms,
    });
  }
  return entries;
}
