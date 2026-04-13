/**
 * OAuth 2.1 Authorization Code + PKCE for MCP HTTP transport.
 *
 * S256-only, public clients (no client_secret), in-memory storage.
 * Zero external dependencies — uses Node.js crypto + http built-ins.
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
  expiresAt: number;
}
interface Token {
  clientId: string;
  expiresAt: number;
}

const authCodes = new Map<string, AuthCode>();
const tokens = new Map<string, Token>();
const AUTH_CODE_TTL_MS = 60_000;
const TOKEN_TTL_S = 3_600;
const TOKEN_TTL_MS = TOKEN_TTL_S * 1_000;

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

const HTML = (cid: string, ch: string, ru: string) =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Uni-CLI MCP Auth</title>` +
  `<style>body{font-family:system-ui,sans-serif;max-width:420px;margin:80px auto;text-align:center}` +
  `button{padding:12px 32px;font-size:16px;cursor:pointer;border:none;border-radius:6px;` +
  `background:#2563eb;color:#fff}code{background:#f1f5f9;padding:2px 6px;border-radius:3px}</style>` +
  `</head><body><h2>Authorize MCP Client</h2><p>Client <code>${escapeHtml(cid)}</code> requests access.</p>` +
  `<form method="POST" action="/oauth/authorize"><input type="hidden" name="client_id" value="${escapeHtml(cid)}">` +
  `<input type="hidden" name="code_challenge" value="${escapeHtml(ch)}"><input type="hidden" name="redirect_uri" ` +
  `value="${escapeHtml(ru)}"><button type="submit">Grant Access</button></form></body></html>`;

function handleAuthorizeGet(req: IncomingMessage, res: ServerResponse): void {
  const p = parseQuery(req.url ?? "");
  const clientId = p.get("client_id"),
    challenge = p.get("code_challenge");
  const method = p.get("code_challenge_method"),
    redirect = p.get("redirect_uri");
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
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(HTML(clientId, challenge, redirect));
}

async function handleAuthorizePost(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const p = new URLSearchParams(await readBody(req));
  const clientId = p.get("client_id"),
    challenge = p.get("code_challenge"),
    redirect = p.get("redirect_uri");
  if (!clientId || !challenge || !redirect)
    return json(res, 400, {
      error: "invalid_request",
      error_description: "Missing required parameters",
    });
  if (!isLocalhostRedirect(redirect))
    return json(res, 400, {
      error: "invalid_request",
      error_description: "redirect_uri must be a localhost URL",
    });
  pruneExpired();
  const code = generateHex(32);
  authCodes.set(code, {
    clientId,
    codeChallenge: challenge,
    redirectUri: redirect,
    expiresAt: Date.now() + AUTH_CODE_TTL_MS,
  });
  res.writeHead(302, {
    Location: `${redirect}${redirect.includes("?") ? "&" : "?"}code=${code}`,
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

  const accessToken = generateHex(32);
  tokens.set(accessToken, { clientId, expiresAt: Date.now() + TOKEN_TTL_MS });
  json(res, 200, {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: TOKEN_TTL_S,
  });
}

// ── Bearer Validation ──────────────────────────────────────────────────────

function validateBearer(req: IncomingMessage): boolean {
  const h = req.headers.authorization;
  if (!h) return false;
  const parts = h.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") return false;
  const entry = tokens.get(parts[1]);
  if (!entry) return false;
  if (entry.expiresAt <= Date.now()) {
    tokens.delete(parts[1]);
    return false;
  }
  return true;
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Returns `true` if the request was an OAuth route and has been handled. */
export function handleOAuthRoute(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const path = (req.url ?? "").split("?")[0];
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
    if (validateBearer(req)) return false;
    res.writeHead(401, {
      "Content-Type": "application/json",
      "WWW-Authenticate": 'Bearer realm="unicli-mcp"',
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

// Test helpers — exported for unit tests only
export const _test = {
  authCodes,
  tokens,
  sha256Base64url,
  generateHex,
  pruneExpired,
} as const;
