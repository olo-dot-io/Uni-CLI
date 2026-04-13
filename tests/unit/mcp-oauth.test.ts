import { describe, it, expect, beforeEach } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  handleOAuthRoute,
  createOAuthMiddleware,
  _test,
} from "../../src/mcp/oauth.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("hex");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Minimal mock for IncomingMessage. */
function mockReq(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body = "",
): IncomingMessage {
  const { Readable } = require("node:stream");
  const readable = new Readable({
    read() {
      this.push(body);
      this.push(null);
    },
  });
  readable.method = method;
  readable.url = url;
  readable.headers = headers;
  return readable as unknown as IncomingMessage;
}

interface MockResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  writableEnded: boolean;
}

function mockRes(): ServerResponse & { _mock: MockResponse } {
  const mock: MockResponse = {
    statusCode: 200,
    headers: {},
    body: "",
    writableEnded: false,
  };
  const res = {
    _mock: mock,
    writableEnded: false,
    writeHead(status: number, headers?: Record<string, string>) {
      mock.statusCode = status;
      if (headers) Object.assign(mock.headers, headers);
      return this;
    },
    end(data?: string) {
      mock.body = data ?? "";
      mock.writableEnded = true;
      res.writableEnded = true;
    },
    setHeader() {},
  };
  return res as unknown as ServerResponse & { _mock: MockResponse };
}

/** HTTP request to a running server. */
function httpRequest(
  port: number,
  method: string,
  path: string,
  body?: string,
  headers?: Record<string, string>,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const http = require("node:http");
    const req = http.request(
      { hostname: "127.0.0.1", port, method, path, headers },
      (res: IncomingMessage & { statusCode: number }) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers as Record<string, string>,
            body: Buffer.concat(chunks).toString("utf-8"),
          });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("OAuth 2.1 PKCE — unit tests", () => {
  beforeEach(() => {
    _test.authCodes.clear();
    _test.tokens.clear();
  });

  describe("sha256Base64url", () => {
    it("computes S256 challenge from verifier", () => {
      // RFC 7636 Appendix B test vector
      const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
      const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
      expect(_test.sha256Base64url(verifier)).toBe(expected);
    });
  });

  describe("handleOAuthRoute — authorize GET", () => {
    it("returns HTML form for valid authorize request", () => {
      const { challenge } = generatePKCE();
      const req = mockReq(
        "GET",
        `/oauth/authorize?response_type=code&client_id=test-client&code_challenge=${challenge}&code_challenge_method=S256&redirect_uri=http://localhost:3000/callback`,
      );
      const res = mockRes();
      const handled = handleOAuthRoute(req, res);
      expect(handled).toBe(true);
      expect(res._mock.statusCode).toBe(200);
      expect(res._mock.headers["Content-Type"]).toContain("text/html");
      expect(res._mock.body).toContain("Grant Access");
      expect(res._mock.body).toContain("test-client");
    });

    it("rejects missing client_id", () => {
      const req = mockReq(
        "GET",
        "/oauth/authorize?code_challenge=abc&redirect_uri=http://localhost",
      );
      const res = mockRes();
      handleOAuthRoute(req, res);
      expect(res._mock.statusCode).toBe(400);
      const body = JSON.parse(res._mock.body);
      expect(body.error).toBe("invalid_request");
    });

    it("rejects plain code_challenge_method", () => {
      const req = mockReq(
        "GET",
        "/oauth/authorize?client_id=x&code_challenge=abc&code_challenge_method=plain&redirect_uri=http://localhost",
      );
      const res = mockRes();
      handleOAuthRoute(req, res);
      expect(res._mock.statusCode).toBe(400);
      const body = JSON.parse(res._mock.body);
      expect(body.error_description).toContain("S256");
    });
  });

  describe("handleOAuthRoute — non-OAuth routes", () => {
    it("returns false for unrelated paths", () => {
      const req = mockReq("POST", "/mcp");
      const res = mockRes();
      expect(handleOAuthRoute(req, res)).toBe(false);
    });

    it("returns false for GET /mcp", () => {
      const req = mockReq("GET", "/mcp");
      const res = mockRes();
      expect(handleOAuthRoute(req, res)).toBe(false);
    });
  });

  describe("createOAuthMiddleware", () => {
    it("blocks requests without Bearer token", () => {
      const middleware = createOAuthMiddleware();
      const req = mockReq("POST", "/mcp");
      const res = mockRes();
      const blocked = middleware(req, res);
      expect(blocked).toBe(true);
      expect(res._mock.statusCode).toBe(401);
      expect(res._mock.headers["WWW-Authenticate"]).toContain("Bearer");
    });

    it("blocks requests with invalid token", () => {
      const middleware = createOAuthMiddleware();
      const req = mockReq("POST", "/mcp", {
        authorization: "Bearer invalid-token-hex",
      });
      const res = mockRes();
      const blocked = middleware(req, res);
      expect(blocked).toBe(true);
      expect(res._mock.statusCode).toBe(401);
    });

    it("allows requests with valid token", () => {
      const middleware = createOAuthMiddleware();
      const token = _test.generateHex(32);
      _test.tokens.set(token, {
        clientId: "test",
        expiresAt: Date.now() + 3_600_000,
      });
      const req = mockReq("POST", "/mcp", {
        authorization: `Bearer ${token}`,
      });
      const res = mockRes();
      const blocked = middleware(req, res);
      expect(blocked).toBe(false);
    });

    it("blocks expired tokens", () => {
      const middleware = createOAuthMiddleware();
      const token = _test.generateHex(32);
      _test.tokens.set(token, {
        clientId: "test",
        expiresAt: Date.now() - 1000,
      });
      const req = mockReq("POST", "/mcp", {
        authorization: `Bearer ${token}`,
      });
      const res = mockRes();
      const blocked = middleware(req, res);
      expect(blocked).toBe(true);
    });
  });

  describe("pruneExpired", () => {
    it("removes expired auth codes and tokens", () => {
      _test.authCodes.set("expired-code", {
        clientId: "x",
        codeChallenge: "y",
        redirectUri: "http://localhost",
        expiresAt: Date.now() - 1000,
      });
      _test.tokens.set("expired-token", {
        clientId: "x",
        expiresAt: Date.now() - 1000,
      });
      _test.authCodes.set("valid-code", {
        clientId: "x",
        codeChallenge: "y",
        redirectUri: "http://localhost",
        expiresAt: Date.now() + 60_000,
      });
      _test.pruneExpired();
      expect(_test.authCodes.has("expired-code")).toBe(false);
      expect(_test.tokens.has("expired-token")).toBe(false);
      expect(_test.authCodes.has("valid-code")).toBe(true);
    });
  });
});

describe("OAuth 2.1 PKCE — integration (HTTP server)", () => {
  let server: Server;
  let port: number;
  const middleware = createOAuthMiddleware();

  beforeEach(async () => {
    _test.authCodes.clear();
    _test.tokens.clear();

    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (handleOAuthRoute(req, res)) return;

      // Protected route
      const path = (req.url ?? "").split("?")[0];
      if (path === "/mcp") {
        if (middleware(req, res)) return;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    port = typeof addr === "object" && addr !== null ? addr.port : 0;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("full flow: authorize → token → protected request", async () => {
    const { verifier, challenge } = generatePKCE();
    const clientId = "integration-test";
    const redirectUri = "http://localhost:9999/callback";

    // Step 1: GET /oauth/authorize — should return HTML
    const authRes = await httpRequest(
      port,
      "GET",
      `/oauth/authorize?response_type=code&client_id=${clientId}&code_challenge=${challenge}&code_challenge_method=S256&redirect_uri=${encodeURIComponent(redirectUri)}`,
    );
    expect(authRes.status).toBe(200);
    expect(authRes.body).toContain("Grant Access");

    // Step 2: POST /oauth/authorize — grant access, get redirect with code
    const grantRes = await httpRequest(
      port,
      "POST",
      "/oauth/authorize",
      `client_id=${clientId}&code_challenge=${challenge}&redirect_uri=${encodeURIComponent(redirectUri)}`,
      { "Content-Type": "application/x-www-form-urlencoded" },
    );
    expect(grantRes.status).toBe(302);
    const location = grantRes.headers.location;
    expect(location).toBeDefined();
    const codeMatch = location.match(/code=([a-f0-9]+)/);
    expect(codeMatch).toBeTruthy();
    const code = codeMatch![1];

    // Step 3: POST /oauth/token — exchange code for access token
    const tokenRes = await httpRequest(
      port,
      "POST",
      "/oauth/token",
      `grant_type=authorization_code&code=${code}&code_verifier=${verifier}&client_id=${clientId}`,
      { "Content-Type": "application/x-www-form-urlencoded" },
    );
    expect(tokenRes.status).toBe(200);
    const tokenBody = JSON.parse(tokenRes.body);
    expect(tokenBody.access_token).toBeDefined();
    expect(tokenBody.token_type).toBe("Bearer");
    expect(tokenBody.expires_in).toBe(3600);

    // Step 4: Access /mcp with token — should succeed
    const mcpRes = await httpRequest(port, "POST", "/mcp", "{}", {
      Authorization: `Bearer ${tokenBody.access_token}`,
      "Content-Type": "application/json",
    });
    expect(mcpRes.status).toBe(200);
    expect(JSON.parse(mcpRes.body).ok).toBe(true);

    // Step 5: Access /mcp without token — should be rejected
    const noAuthRes = await httpRequest(port, "POST", "/mcp", "{}", {
      "Content-Type": "application/json",
    });
    expect(noAuthRes.status).toBe(401);
  });

  it("rejects auth code reuse (single-use enforcement)", async () => {
    const { verifier, challenge } = generatePKCE();
    const clientId = "reuse-test";
    const redirectUri = "http://localhost:9999/callback";

    // Grant
    const grantRes = await httpRequest(
      port,
      "POST",
      "/oauth/authorize",
      `client_id=${clientId}&code_challenge=${challenge}&redirect_uri=${encodeURIComponent(redirectUri)}`,
      { "Content-Type": "application/x-www-form-urlencoded" },
    );
    const code = grantRes.headers.location.match(/code=([a-f0-9]+)/)![1];

    // First exchange — succeeds
    const first = await httpRequest(
      port,
      "POST",
      "/oauth/token",
      `grant_type=authorization_code&code=${code}&code_verifier=${verifier}&client_id=${clientId}`,
      { "Content-Type": "application/x-www-form-urlencoded" },
    );
    expect(first.status).toBe(200);

    // Second exchange — fails (single-use)
    const second = await httpRequest(
      port,
      "POST",
      "/oauth/token",
      `grant_type=authorization_code&code=${code}&code_verifier=${verifier}&client_id=${clientId}`,
      { "Content-Type": "application/x-www-form-urlencoded" },
    );
    expect(second.status).toBe(400);
    expect(JSON.parse(second.body).error).toBe("invalid_grant");
  });

  it("rejects wrong code_verifier (PKCE enforcement)", async () => {
    const { challenge } = generatePKCE();
    const clientId = "pkce-test";
    const redirectUri = "http://localhost:9999/callback";

    // Grant
    const grantRes = await httpRequest(
      port,
      "POST",
      "/oauth/authorize",
      `client_id=${clientId}&code_challenge=${challenge}&redirect_uri=${encodeURIComponent(redirectUri)}`,
      { "Content-Type": "application/x-www-form-urlencoded" },
    );
    const code = grantRes.headers.location.match(/code=([a-f0-9]+)/)![1];

    // Exchange with wrong verifier
    const wrongVerifier = randomBytes(32).toString("hex");
    const res = await httpRequest(
      port,
      "POST",
      "/oauth/token",
      `grant_type=authorization_code&code=${code}&code_verifier=${wrongVerifier}&client_id=${clientId}`,
      { "Content-Type": "application/x-www-form-urlencoded" },
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_grant");
    expect(JSON.parse(res.body).error_description).toContain("PKCE");
  });

  it("rejects unsupported grant_type", async () => {
    const res = await httpRequest(
      port,
      "POST",
      "/oauth/token",
      "grant_type=client_credentials&client_id=x",
      { "Content-Type": "application/x-www-form-urlencoded" },
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toBe("unsupported_grant_type");
  });
});

// Need afterEach import for the integration test
import { afterEach } from "vitest";
