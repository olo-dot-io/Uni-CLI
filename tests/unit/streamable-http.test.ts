import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";

// Import the test helpers and the server starter
const mod = await import("../../src/mcp/streamable-http.js");
const { startStreamableHttp, _test } = mod;
const { sessions, pruneStaleSessions, MCP_PROTOCOL_VERSION } = _test;

// ── Helper: send HTTP request to the server ──────────────────────────────

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  port: number,
  method: string,
  path: string,
  body?: string,
  extraHeaders?: Record<string, string>,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...extraHeaders,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf-8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("Streamable HTTP transport", () => {
  let port: number;
  const servers: http.Server[] = [];

  // Pick a random high port to avoid conflicts
  function nextPort(): number {
    return 30_000 + Math.floor(Math.random() * 10_000);
  }

  // Simple echo handler for testing
  const echoHandler = (req: {
    jsonrpc: "2.0";
    id?: number | string | null;
    method: string;
    params?: Record<string, unknown>;
  }) => {
    if (req.method === "initialize") {
      return {
        jsonrpc: "2.0" as const,
        id: req.id ?? null,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "test", version: "0.0.1" },
        },
      };
    }
    if (req.method === "notifications/initialized") {
      return null as never;
    }
    if (req.method === "tools/list") {
      return {
        jsonrpc: "2.0" as const,
        id: req.id ?? null,
        result: { tools: [] },
      };
    }
    if (req.method === "tools/call") {
      return {
        jsonrpc: "2.0" as const,
        id: req.id ?? null,
        result: { content: [{ type: "text", text: "ok" }] },
      };
    }
    return {
      jsonrpc: "2.0" as const,
      id: req.id ?? null,
      error: { code: -32601, message: "Method not found" },
    };
  };

  async function startServer(): Promise<number> {
    port = nextPort();
    sessions.clear();
    await startStreamableHttp(port, echoHandler);
    return port;
  }

  afterEach(() => {
    sessions.clear();
  });

  it("GET /health returns server info", async () => {
    const p = await startServer();
    const res = await request(p, "GET", "/health");
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.status).toBe("ok");
    expect(json.transport).toBe("streamable-http");
    expect(json.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
  });

  it("POST /mcp with initialize creates session", async () => {
    const p = await startServer();
    const res = await request(
      p,
      "POST",
      "/mcp",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    );
    expect(res.status).toBe(200);
    const sessionId = res.headers["mcp-session-id"] as string;
    expect(sessionId).toBeTruthy();
    expect(sessions.has(sessionId)).toBe(true);

    const json = JSON.parse(res.body);
    expect(json.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
  });

  it("POST /mcp without session ID for non-initialize returns 400", async () => {
    const p = await startServer();
    const res = await request(
      p,
      "POST",
      "/mcp",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    );
    expect(res.status).toBe(400);
    const json = JSON.parse(res.body);
    expect(json.error.message).toContain("MCP-Session-Id");
  });

  it("POST /mcp with valid session returns tools/list as JSON", async () => {
    const p = await startServer();

    // Initialize first
    const init = await request(
      p,
      "POST",
      "/mcp",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    );
    const sessionId = init.headers["mcp-session-id"] as string;

    // Call tools/list with session
    const res = await request(
      p,
      "POST",
      "/mcp",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
      { "MCP-Session-Id": sessionId },
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    const json = JSON.parse(res.body);
    expect(json.result.tools).toEqual([]);
  });

  it("POST /mcp tools/call returns SSE when client accepts it", async () => {
    const p = await startServer();

    // Initialize
    const init = await request(
      p,
      "POST",
      "/mcp",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    );
    const sessionId = init.headers["mcp-session-id"] as string;

    // tools/call with Accept: text/event-stream
    const res = await request(
      p,
      "POST",
      "/mcp",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "test", arguments: {} },
      }),
      {
        "MCP-Session-Id": sessionId,
        Accept: "text/event-stream",
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    // SSE body contains "event: message" and "data:" lines
    expect(res.body).toContain("event: message");
    expect(res.body).toContain("data:");
    expect(res.body).toContain('"id":3');
  });

  it("DELETE /mcp terminates session", async () => {
    const p = await startServer();

    // Initialize
    const init = await request(
      p,
      "POST",
      "/mcp",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    );
    const sessionId = init.headers["mcp-session-id"] as string;
    expect(sessions.has(sessionId)).toBe(true);

    // Delete session
    const del = await request(p, "DELETE", "/mcp", undefined, {
      "MCP-Session-Id": sessionId,
    });
    expect(del.status).toBe(204);
    expect(sessions.has(sessionId)).toBe(false);
  });

  it("DELETE /mcp without session returns 400", async () => {
    const p = await startServer();
    const del = await request(p, "DELETE", "/mcp", undefined, {
      "MCP-Session-Id": "nonexistent-id",
    });
    expect(del.status).toBe(400);
  });

  it("notification (no id) returns 204", async () => {
    const p = await startServer();

    // Initialize
    const init = await request(
      p,
      "POST",
      "/mcp",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    );
    const sessionId = init.headers["mcp-session-id"] as string;

    // Send notification (no id field)
    const res = await request(
      p,
      "POST",
      "/mcp",
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
      { "MCP-Session-Id": sessionId },
    );
    expect(res.status).toBe(204);
  });

  it("invalid JSON returns 400 parse error", async () => {
    const p = await startServer();
    const res = await request(p, "POST", "/mcp", "{broken json");
    expect(res.status).toBe(400);
    const json = JSON.parse(res.body);
    expect(json.error.code).toBe(-32700);
  });

  it("rejects request with bad Origin header", async () => {
    const p = await startServer();
    const res = await request(
      p,
      "POST",
      "/mcp",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
      { Origin: "https://evil.example.com" },
    );
    expect(res.status).toBe(403);
  });

  it("allows request with localhost Origin", async () => {
    const p = await startServer();
    const res = await request(
      p,
      "POST",
      "/mcp",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
      { Origin: "http://localhost:3000" },
    );
    expect(res.status).toBe(200);
  });

  it("pruneStaleSessions removes expired sessions", () => {
    sessions.clear();
    const oldId = "stale-session";
    sessions.set(oldId, {
      created: Date.now() - 7_200_000, // 2 hours ago
      lastSeen: Date.now() - 7_200_000,
      protocolVersion: MCP_PROTOCOL_VERSION,
    });
    const freshId = "fresh-session";
    sessions.set(freshId, {
      created: Date.now(),
      lastSeen: Date.now(),
      protocolVersion: MCP_PROTOCOL_VERSION,
    });

    pruneStaleSessions();
    expect(sessions.has(oldId)).toBe(false);
    expect(sessions.has(freshId)).toBe(true);
  });

  it("404 for unknown paths", async () => {
    const p = await startServer();
    const res = await request(p, "GET", "/unknown");
    expect(res.status).toBe(404);
  });

  it("OPTIONS /mcp returns CORS preflight", async () => {
    const p = await startServer();
    const res = await request(p, "OPTIONS", "/mcp");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
    expect(res.headers["access-control-allow-methods"]).toContain("DELETE");
    expect(res.headers["access-control-allow-headers"]).toContain(
      "MCP-Session-Id",
    );
  });
});
