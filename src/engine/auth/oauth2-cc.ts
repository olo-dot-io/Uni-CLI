/**
 * @owner       src::engine::auth::oauth2-cc
 * @does        OAuth 2.0 client_credentials token broker with LRU cache — issues, caches, and refreshes bearer tokens for adapters that authenticate against EPO OPS, PatSnap Eureka, Lens.org, and similar APIs.
 * @needs       node:crypto (Basic-auth payload), global fetch
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

/**
 * Obtain a (possibly cached) bearer-token lease via OAuth2 client_credentials.
 *
 * @throws Oauth2Error when the token endpoint refuses the credentials or
 *         returns a non-2xx status.
 */
export async function obtainClientCredentialsToken(
  _config: Oauth2ClientCredentialsConfig,
): Promise<Oauth2TokenLease> {
  throw new Error(
    "oauth2-cc: obtainClientCredentialsToken not yet implemented (M0 stub — wave-1-subagent-A will fill body)",
  );
}

/**
 * Drop every cached lease. Test-only helper; production code should never need
 * this because TTL eviction is automatic.
 */
export function resetOauth2Cache(): void {
  throw new Error(
    "oauth2-cc: resetOauth2Cache not yet implemented (M0 stub — wave-1-subagent-A will fill body)",
  );
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
  throw new Error(
    "oauth2-cc: describeOauth2Cache not yet implemented (M0 stub — wave-1-subagent-A will fill body)",
  );
}
