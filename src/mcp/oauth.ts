/**
 * @owner       src::mcp::oauth
 * @does        Provide local OAuth 2.1 Authorization Code + PKCE and bind each authenticated HTTP request to its stable client principal.
 * @needs       node:crypto, node:http
 * @feeds       simple and Streamable MCP HTTP transports
 * @breaks      Treating any valid bearer as the same principal lets one authorized client adopt another client's MCP session and durable tasks.
 * @invariants  Authorization codes are single-use/short-lived; PKCE is S256; tokens are bounded and compared in constant time; successful middleware records the issuing clientId on exactly that request.
 * @side-effects Owns in-memory authorization-code/token stores and a weak request-to-principal association.
 * @perf        Bearer validation scans the bounded resident token set to avoid match-position timing leakage.
 * @concurrency Node's event loop serializes store mutation; request principals are immutable after authentication.
 * @test        tests/unit/mcp-oauth.test.ts, tests/unit/streamable-http.test.ts
 * @stability   stable
 * @since       2026-04-01
 */

import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

function isLocalhostRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    return (
      (u.hostname === "localhost" || u.hostname === "127.0.0.1") &&
      u.protocol === "http:"
    );
  } catch {
    return false;
  }
}

interface AuthCode {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  resource: string;
  expiresAt: number;
}
interface Token {
  clientId: string;
  resource: string;
  expiresAt: number;
}
interface ConsentTransaction extends AuthCode {
  state?: string;
}

const authCodes = new Map<string, AuthCode>();
const tokens = new Map<string, Token>();
const consentTransactions = new Map<string, ConsentTransaction>();
const requestPrincipals = new WeakMap<IncomingMessage, string>();
const AUTH_CODE_TTL_MS = 60_000;
const CONSENT_TTL_MS = 5 * 60_000;
const TOKEN_TTL_S = 3_600;
const TOKEN_TTL_MS = TOKEN_TTL_S * 1_000;
const MAX_AUTH_CODES = 256;
const MAX_CONSENT_TRANSACTIONS = 256;
const MAX_TOKENS = 512;

function generateHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}
function sha256Base64url(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}
function parseQuery(url: string): URLSearchParams {
  const i = url.indexOf("?");
  return new URLSearchParams(i >= 0 ? url.slice(i + 1) : "");
}
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 65_536) {
        req.destroy();
        reject(new Error("Body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
function json(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}
function pruneExpired(): void {
  const now = Date.now();
  for (const [k, v] of authCodes) if (v.expiresAt <= now) authCodes.delete(k);
  for (const [k, v] of tokens) if (v.expiresAt <= now) tokens.delete(k);
  for (const [k, v] of consentTransactions) {
    if (v.expiresAt <= now) consentTransactions.delete(k);
  }
}
function admitBounded<T>(store: Map<string, T>, limit: number): void {
  while (store.size >= limit) {
    const oldest = store.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}
function tokenKey(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}
function requestOrigin(req: IncomingMessage): string {
  const host = req.headers.host;
  if (!host || !/^[a-zA-Z0-9.[\]:-]+$/.test(host)) {
    return "http://localhost";
  }
  return `http://${host}`;
}
function protectedResource(req: IncomingMessage): string {
  return `${requestOrigin(req)}/mcp`;
}

// ── Authorization Endpoint ─────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const HTML = (cid: string, nonce: string) =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Uni-CLI MCP Auth</title>` +
  `<style>body{font-family:system-ui,sans-serif;max-width:420px;margin:80px auto;text-align:center}` +
  `button{padding:12px 32px;font-size:16px;cursor:pointer;border:none;border-radius:6px;` +
  `background:#2563eb;color:#fff}code{background:#f1f5f9;padding:2px 6px;border-radius:3px}</style>` +
  `</head><body><h2>Authorize MCP Client</h2><p>Client <code>${escapeHtml(cid)}</code> requests access.</p>` +
  `<form method="POST" action="/oauth/authorize"><input type="hidden" name="consent_nonce" value="${escapeHtml(nonce)}">` +
  `<button type="submit">Grant Access</button></form></body></html>`;

function handleAuthorizeGet(req: IncomingMessage, res: ServerResponse): void {
  const p = parseQuery(req.url ?? "");
  const clientId = p.get("client_id"),
    challenge = p.get("code_challenge");
  const method = p.get("code_challenge_method"),
    redirect = p.get("redirect_uri");
  const responseType = p.get("response_type");
  if (!clientId || !challenge || !redirect)
    return json(res, 400, {
      error: "invalid_request",
      error_description: "Missing client_id, code_challenge, or redirect_uri",
    });
  if (method && method !== "S256")
    return json(res, 400, {
      error: "invalid_request",
      error_description: "Only S256 code_challenge_method is supported",
    });
  if (!isLocalhostRedirect(redirect))
    return json(res, 400, {
      error: "invalid_request",
      error_description:
        "redirect_uri must be a localhost URL (http://localhost or http://127.0.0.1)",
    });
  if (responseType && responseType !== "code")
    return json(res, 400, {
      error: "unsupported_response_type",
      error_description: "Only response_type=code is supported",
    });
  const canonicalResource = protectedResource(req);
  const resource = p.get("resource") ?? canonicalResource;
  if (resource !== canonicalResource)
    return json(res, 400, {
      error: "invalid_target",
      error_description: `resource must be ${canonicalResource}`,
    });
  pruneExpired();
  admitBounded(consentTransactions, MAX_CONSENT_TRANSACTIONS);
  const nonce = generateHex(32);
  consentTransactions.set(nonce, {
    clientId,
    codeChallenge: challenge,
    redirectUri: redirect,
    resource,
    ...(p.get("state") ? { state: p.get("state")! } : {}),
    expiresAt: Date.now() + CONSENT_TTL_MS,
  });
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(HTML(clientId, nonce));
}

async function handleAuthorizePost(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const p = new URLSearchParams(await readBody(req));
  const nonce = p.get("consent_nonce");
  if (!nonce)
    return json(res, 400, {
      error: "invalid_request",
      error_description: "Missing consent_nonce",
    });
  pruneExpired();
  const transaction = consentTransactions.get(nonce);
  consentTransactions.delete(nonce);
  if (!transaction)
    return json(res, 400, {
      error: "invalid_grant",
      error_description: "Consent transaction is invalid or expired",
    });
  admitBounded(authCodes, MAX_AUTH_CODES);
  const code = generateHex(32);
  authCodes.set(code, {
    clientId: transaction.clientId,
    codeChallenge: transaction.codeChallenge,
    redirectUri: transaction.redirectUri,
    resource: transaction.resource,
    expiresAt: Date.now() + AUTH_CODE_TTL_MS,
  });
  const redirect = new URL(transaction.redirectUri);
  redirect.searchParams.set("code", code);
  if (transaction.state) redirect.searchParams.set("state", transaction.state);
  res.writeHead(302, {
    Location: redirect.toString(),
  });
  res.end();
}

// ── Token Endpoint ─────────────────────────────────────────────────────────

async function handleToken(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const p = new URLSearchParams(await readBody(req));
  const grant = p.get("grant_type"),
    code = p.get("code");
  const verifier = p.get("code_verifier"),
    clientId = p.get("client_id");

  if (grant !== "authorization_code")
    return json(res, 400, {
      error: "unsupported_grant_type",
      error_description: "Only authorization_code is supported",
    });
  if (!code || !verifier || !clientId)
    return json(res, 400, {
      error: "invalid_request",
      error_description: "Missing code, code_verifier, or client_id",
    });

  pruneExpired();
  const entry = authCodes.get(code);
  if (!entry)
    return json(res, 400, {
      error: "invalid_grant",
      error_description: "Invalid or expired authorization code",
    });
  authCodes.delete(code); // single-use

  if (entry.expiresAt <= Date.now())
    return json(res, 400, {
      error: "invalid_grant",
      error_description: "Authorization code has expired",
    });
  if (entry.clientId !== clientId)
    return json(res, 400, {
      error: "invalid_grant",
      error_description: "Client ID mismatch",
    });
  const redirectUri = p.get("redirect_uri");
  if (redirectUri && redirectUri !== entry.redirectUri)
    return json(res, 400, {
      error: "invalid_grant",
      error_description: "redirect_uri mismatch",
    });
  if (sha256Base64url(verifier) !== entry.codeChallenge)
    return json(res, 400, {
      error: "invalid_grant",
      error_description: "PKCE verification failed",
    });

  const resource = p.get("resource") ?? entry.resource;
  if (resource !== entry.resource)
    return json(res, 400, {
      error: "invalid_target",
      error_description: "resource does not match the authorization grant",
    });

  const accessToken = generateHex(32);
  admitBounded(tokens, MAX_TOKENS);
  tokens.set(tokenKey(accessToken), {
    clientId,
    resource,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });
  json(res, 200, {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: TOKEN_TTL_S,
  });
}

// ── Bearer Validation ──────────────────────────────────────────────────────

/** Upper bound on Bearer token length — Uni-CLI tokens are 64 hex chars. */
const MAX_TOKEN_LENGTH = 128;

/**
 * Validate an Authorization: Bearer <token> header.
 *
 * Tokens are indexed by a fixed-length SHA-256 digest, so lookup is O(1)
 * without retaining bearer secrets as Map keys. Expired entries are deleted
 * on lookup and all stores are pruned and capacity-bounded on issuance.
 */
function validateBearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  if (!h) return undefined;
  const parts = h.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") return undefined;
  const presented = parts[1];
  if (presented.length === 0 || presented.length > MAX_TOKEN_LENGTH)
    return undefined;

  const key = tokenKey(presented);
  const now = Date.now();
  const entry = tokens.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    tokens.delete(key);
    return undefined;
  }
  if (entry.resource !== protectedResource(req)) return undefined;
  return entry.clientId;
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Returns `true` if the request was an OAuth route and has been handled. */
export function handleOAuthRoute(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const path = (req.url ?? "").split("?")[0];
  if (
    req.method === "GET" &&
    path === "/.well-known/oauth-protected-resource"
  ) {
    const origin = requestOrigin(req);
    json(res, 200, {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
    });
    return true;
  }
  if (
    req.method === "GET" &&
    path === "/.well-known/oauth-authorization-server"
  ) {
    const origin = requestOrigin(req);
    json(res, 200, {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
    return true;
  }
  if (path === "/oauth/authorize") {
    if (req.method === "GET") {
      handleAuthorizeGet(req, res);
      return true;
    }
    if (req.method === "POST") {
      handleAuthorizePost(req, res).catch(() => {
        if (!res.writableEnded) json(res, 500, { error: "server_error" });
      });
      return true;
    }
  }
  if (path === "/oauth/token" && req.method === "POST") {
    handleToken(req, res).catch(() => {
      if (!res.writableEnded) json(res, 500, { error: "server_error" });
    });
    return true;
  }
  return false;
}

/** Returns a function that blocks unauthorized requests (returns `true` = blocked). */
export function createOAuthMiddleware(): (
  req: IncomingMessage,
  res: ServerResponse,
) => boolean {
  return (req, res) => {
    const principalId = validateBearer(req);
    if (principalId) {
      requestPrincipals.set(req, principalId);
      return false;
    }
    res.writeHead(401, {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer realm="unicli-mcp", resource_metadata="${requestOrigin(req)}/.well-known/oauth-protected-resource"`,
    });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32600,
          message: "Unauthorized: valid Bearer token required",
        },
      }),
    );
    return true;
  };
}

export function getAuthenticatedPrincipal(
  req: IncomingMessage,
): string | undefined {
  return requestPrincipals.get(req);
}

// Test helpers — exported for unit tests only
export const _test = {
  authCodes,
  tokens,
  consentTransactions,
  sha256Base64url,
  generateHex,
  pruneExpired,
  tokenKey,
  putToken(
    token: string,
    entry: Omit<Token, "resource"> & { resource?: string },
  ): void {
    tokens.set(tokenKey(token), {
      ...entry,
      resource: entry.resource ?? "http://localhost/mcp",
    });
  },
} as const;
