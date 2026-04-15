import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";

// Import the test helpers and the server starter
const mod = await import("../../src/mcp/streamable-http.js");
const { startStreamableHttp, _test } = mod;
const { sessions, asyncTasks, pruneStaleSessions, MCP_PROTOCOL_VERSION } =
  _test;

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

// ── Helper: initialize a session and return its ID ───────────────────────

async function initSession(port: number): Promise<string> {
  const res = await request(
    port,
    "POST",
    "/mcp",
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    }),
  );
  return res.headers["mcp-session-id"] as string;
}

// ── Helper: headers for post-init requests ───────────────────────────────

function postInitHeaders(sessionId: string): Record<string, string> {
  return {
    "MCP-Session-Id": sessionId,
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("Streamable HTTP transport", () => {
  let port: number;

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

  // Slow handler that resolves after a delay — for async task tests
  const slowHandler = (req: {
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
          serverInfo: { name: "test-slow", version: "0.0.1" },
        },
      };
    }
    if (req.method === "tools/call") {
      return new Promise<{
        jsonrpc: "2.0";
        id: number | string | null;
        result: { content: Array<{ type: string; text: string }> };
      }>((resolve) => {
        setTimeout(() => {
          resolve({
            jsonrpc: "2.0" as const,
            id: req.id ?? null,
            result: { content: [{ type: "text", text: "slow-done" }] },
          });
        }, 50);
      });
    }
    return {
      jsonrpc: "2.0" as const,
      id: req.id ?? null,
      error: { code: -32601, message: "Method not found" },
    };
  };

  // Handler that always rejects for tools/call — for async error tests
  const failHandler = (req: {
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
          serverInfo: { name: "test-fail", version: "0.0.1" },
        },
      };
    }
    if (req.method === "tools/call") {
      return Promise.reject(new Error("adapter exploded"));
    }
    return {
      jsonrpc: "2.0" as const,
      id: req.id ?? null,
      error: { code: -32601, message: "Method not found" },
    };
  };

  async function startServer(handler?: typeof echoHandler): Promise<number> {
    sessions.clear();
    asyncTasks.clear();
    // port: 0 → OS picks a free ephemeral port. Avoids EADDRINUSE on Windows
    // CI where prior tests can leave entries in TIME_WAIT for several seconds.
    port = await startStreamableHttp(0, handler ?? echoHandler);
    return port;
  }

  afterEach(() => {
    sessions.clear();
    asyncTasks.clear();
  });

  // ── Existing tests (B1-B3) ─────────────────────────────────────────────

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

  it("POST /mcp without session ID for non-initialize returns 404", async () => {
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
    // MCP spec: expired/invalid session returns 404
    expect(res.status).toBe(404);
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

    // Call tools/list with session + protocol version header
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
      postInitHeaders(sessionId),
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
        ...postInitHeaders(sessionId),
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

  it("DELETE /mcp without session returns 404", async () => {
    const p = await startServer();
    const del = await request(p, "DELETE", "/mcp", undefined, {
      "MCP-Session-Id": "nonexistent-id",
    });
    // MCP spec: expired/invalid session returns 404
    expect(del.status).toBe(404);
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
      postInitHeaders(sessionId),
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
    expect(res.headers["access-control-allow-methods"]).toContain("GET");
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
    expect(res.headers["access-control-allow-methods"]).toContain("DELETE");
    expect(res.headers["access-control-allow-headers"]).toContain(
      "MCP-Session-Id",
    );
    expect(res.headers["access-control-expose-headers"]).toContain(
      "MCP-Session-Id",
    );
  });

  it("GET /mcp returns server capabilities", async () => {
    const p = await startServer();
    const res = await request(p, "GET", "/mcp");
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(json.serverInfo.name).toBe("unicli");
    expect(json.capabilities).toEqual({});
  });

  it("POST /mcp without MCP-Protocol-Version header returns 400", async () => {
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

    // Send post-init request without MCP-Protocol-Version
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
    expect(res.status).toBe(400);
    const json = JSON.parse(res.body);
    expect(json.error.message).toContain("Missing MCP-Protocol-Version");
  });

  it("POST /mcp with wrong MCP-Protocol-Version returns 400", async () => {
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

    // Send with wrong version
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
      {
        "MCP-Session-Id": sessionId,
        "MCP-Protocol-Version": "1999-01-01",
      },
    );
    expect(res.status).toBe(400);
    const json = JSON.parse(res.body);
    expect(json.error.message).toContain("Unsupported protocol version");
  });

  it("JSON responses include CORS headers", async () => {
    const p = await startServer();
    const res = await request(p, "GET", "/health");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost");
    expect(res.headers["access-control-expose-headers"]).toContain(
      "MCP-Session-Id",
    );
  });

  // ── Async Task Tests (F1) ──────────────────────────────────────────────

  describe("Async Tasks", () => {
    it("tools/call with X-MCP-Async returns 202 with taskId", async () => {
      const p = await startServer();
      const sessionId = await initSession(p);

      const res = await request(
        p,
        "POST",
        "/mcp",
        JSON.stringify({
          jsonrpc: "2.0",
          id: 10,
          method: "tools/call",
          params: { name: "test", arguments: {} },
        }),
        {
          ...postInitHeaders(sessionId),
          "X-MCP-Async": "true",
          Accept: "application/json",
        },
      );
      expect(res.status).toBe(202);
      const json = JSON.parse(res.body);
      expect(json.jsonrpc).toBe("2.0");
      expect(json.id).toBe(10);
      expect(json.result._meta.taskId).toBeTruthy();
      expect(json.result._meta.status).toBe("running");

      // Task should exist in the registry
      const taskId = json.result._meta.taskId;
      expect(asyncTasks.has(taskId)).toBe(true);
    });

    it("async task completes and is queryable via tasks/status", async () => {
      const p = await startServer(slowHandler as typeof echoHandler);
      const sessionId = await initSession(p);

      // Start async task
      const res = await request(
        p,
        "POST",
        "/mcp",
        JSON.stringify({
          jsonrpc: "2.0",
          id: 11,
          method: "tools/call",
          params: { name: "slow-tool", arguments: {} },
        }),
        {
          ...postInitHeaders(sessionId),
          "X-MCP-Async": "true",
          Accept: "application/json",
        },
      );
      const taskId = JSON.parse(res.body).result._meta.taskId;

      // Wait for the slow handler to complete
      await new Promise((r) => setTimeout(r, 100));

      // Query task status
      const statusRes = await request(
        p,
        "POST",
        "/mcp",
        JSON.stringify({
          jsonrpc: "2.0",
          id: 12,
          method: "tasks/status",
          params: { taskId },
        }),
        postInitHeaders(sessionId),
      );
      expect(statusRes.status).toBe(200);
      const statusJson = JSON.parse(statusRes.body);
      expect(statusJson.result.status).toBe("completed");
      expect(statusJson.result.taskId).toBe(taskId);
      expect(statusJson.result.result).toBeTruthy();
    });

    it("tasks/status returns error for missing taskId param", async () => {
      const p = await startServer();
      const sessionId = await initSession(p);

      const res = await request(
        p,
        "POST",
        "/mcp",
        JSON.stringify({
          jsonrpc: "2.0",
          id: 13,
          method: "tasks/status",
          params: {},
        }),
        postInitHeaders(sessionId),
      );
      expect(res.status).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.error.code).toBe(-32602);
      expect(json.error.message).toContain("Missing required param");
    });

    it("tasks/status returns error for unknown task", async () => {
      const p = await startServer();
      const sessionId = await initSession(p);

      const res = await request(
        p,
        "POST",
        "/mcp",
        JSON.stringify({
          jsonrpc: "2.0",
          id: 14,
          method: "tasks/status",
          params: { taskId: "nonexistent-task-id" },
        }),
        postInitHeaders(sessionId),
      );
      expect(res.status).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.error.code).toBe(-32602);
      expect(json.error.message).toContain("Task not found");
    });

    it("tasks/cancel sets running task to cancelled", async () => {
      const p = await startServer(slowHandler as typeof echoHandler);
      const sessionId = await initSession(p);

      // Start async task
      const res = await request(
        p,
        "POST",
        "/mcp",
        JSON.stringify({
          jsonrpc: "2.0",
          id: 15,
          method: "tools/call",
          params: { name: "slow-tool", arguments: {} },
        }),
        {
          ...postInitHeaders(sessionId),
          "X-MCP-Async": "true",
          Accept: "application/json",
        },
      );
      const taskId = JSON.parse(res.body).result._meta.taskId;

      // Cancel it before it completes
      const cancelRes = await request(
        p,
        "POST",
        "/mcp",
        JSON.stringify({
          jsonrpc: "2.0",
          id: 16,
          method: "tasks/cancel",
          params: { taskId },
        }),
        postInitHeaders(sessionId),
      );
      expect(cancelRes.status).toBe(200);
      const cancelJson = JSON.parse(cancelRes.body);
      expect(cancelJson.result.taskId).toBe(taskId);
      expect(cancelJson.result.status).toBe("cancelled");

      // Verify via direct map access
      expect(asyncTasks.get(taskId)!.status).toBe("cancelled");
    });

    it("tasks/cancel returns error for missing taskId param", async () => {
      const p = await startServer();
      const sessionId = await initSession(p);

      const res = await request(
        p,
        "POST",
        "/mcp",
        JSON.stringify({
          jsonrpc: "2.0",
          id: 17,
          method: "tasks/cancel",
          params: {},
        }),
        postInitHeaders(sessionId),
      );
      const json = JSON.parse(res.body);
      expect(json.error.code).toBe(-32602);
    });

    it("tasks/cancel returns error for unknown task", async () => {
      const p = await startServer();
      const sessionId = await initSession(p);

      const res = await request(
        p,
        "POST",
        "/mcp",
        JSON.stringify({
          jsonrpc: "2.0",
          id: 18,
          method: "tasks/cancel",
          params: { taskId: "ghost-task" },
        }),
        postInitHeaders(sessionId),
      );
      const json = JSON.parse(res.body);
      expect(json.error.code).toBe(-32602);
      expect(json.error.message).toContain("Task not found");
    });

    it("tasks/cancel on already-completed task preserves completed status", async () => {
      const p = await startServer();
      const sessionId = await initSession(p);

      // Start async task (echoHandler resolves instantly)
      const res = await request(
        p,
        "POST",
        "/mcp",
        JSON.stringify({
          jsonrpc: "2.0",
          id: 19,
          method: "tools/call",
          params: { name: "test", arguments: {} },
        }),
        {
          ...postInitHeaders(sessionId),
          "X-MCP-Async": "true",
          Accept: "application/json",
        },
      );
      const taskId = JSON.parse(res.body).result._meta.taskId;

      // Wait for instant handler to resolve
      await new Promise((r) => setTimeout(r, 20));

      // Try to cancel the completed task
      const cancelRes = await request(
        p,
        "POST",
        "/mcp",
        JSON.stringify({
          jsonrpc: "2.0",
          id: 20,
          method: "tasks/cancel",
          params: { taskId },
        }),
        postInitHeaders(sessionId),
      );
      const cancelJson = JSON.parse(cancelRes.body);
      expect(cancelJson.result.status).toBe("completed");
    });

    it("async task with SSE returns 202 and streams events", async () => {
      const p = await startServer(slowHandler as typeof echoHandler);
      const sessionId = await initSession(p);

      // tools/call with X-MCP-Async + Accept: text/event-stream
      const res = await request(
        p,
        "POST",
        "/mcp",
        JSON.stringify({
          jsonrpc: "2.0",
          id: 21,
          method: "tools/call",
          params: { name: "slow-tool", arguments: {} },
        }),
        {
          ...postInitHeaders(sessionId),
          "X-MCP-Async": "true",
          Accept: "text/event-stream",
        },
      );
      expect(res.status).toBe(202);
      expect(res.headers["content-type"]).toContain("text/event-stream");
      // Should contain the accepted event and the complete event
      expect(res.body).toContain("event: accepted");
      expect(res.body).toContain("event: complete");
      expect(res.body).toContain('"status":"running"');
    });

    it("async task with SSE streams error event on handler failure", async () => {
      const p = await startServer(failHandler as typeof echoHandler);
      const sessionId = await initSession(p);

      const res = await request(
        p,
        "POST",
        "/mcp",
        JSON.stringify({
          jsonrpc: "2.0",
          id: 22,
          method: "tools/call",
          params: { name: "fail-tool", arguments: {} },
        }),
        {
          ...postInitHeaders(sessionId),
          "X-MCP-Async": "true",
          Accept: "text/event-stream",
        },
      );
      expect(res.status).toBe(202);
      expect(res.body).toContain("event: accepted");
      expect(res.body).toContain("event: error");
      expect(res.body).toContain("adapter exploded");
    });

    it("failed async task is queryable via tasks/status", async () => {
      const p = await startServer(failHandler as typeof echoHandler);
      const sessionId = await initSession(p);

      // Start async task (non-SSE)
      const res = await request(
        p,
        "POST",
        "/mcp",
        JSON.stringify({
          jsonrpc: "2.0",
          id: 23,
          method: "tools/call",
          params: { name: "fail-tool", arguments: {} },
        }),
        {
          ...postInitHeaders(sessionId),
          "X-MCP-Async": "true",
          Accept: "application/json",
        },
      );
      const taskId = JSON.parse(res.body).result._meta.taskId;

      // Wait for handler to reject
      await new Promise((r) => setTimeout(r, 50));

      const statusRes = await request(
        p,
        "POST",
        "/mcp",
        JSON.stringify({
          jsonrpc: "2.0",
          id: 24,
          method: "tasks/status",
          params: { taskId },
        }),
        postInitHeaders(sessionId),
      );
      const statusJson = JSON.parse(statusRes.body);
      expect(statusJson.result.status).toBe("failed");
      expect(statusJson.result.error).toContain("adapter exploded");
    });

    it("tools/call without X-MCP-Async header uses synchronous path", async () => {
      const p = await startServer();
      const sessionId = await initSession(p);

      const res = await request(
        p,
        "POST",
        "/mcp",
        JSON.stringify({
          jsonrpc: "2.0",
          id: 25,
          method: "tools/call",
          params: { name: "test", arguments: {} },
        }),
        {
          ...postInitHeaders(sessionId),
          Accept: "application/json",
        },
      );
      // Synchronous: returns 200 with result directly
      expect(res.status).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.result.content[0].text).toBe("ok");
      // No task created
      expect(asyncTasks.size).toBe(0);
    });

    it("pruneStaleSessions also removes expired async tasks", () => {
      asyncTasks.clear();
      sessions.clear();

      const oldTaskId = "old-task";
      asyncTasks.set(oldTaskId, {
        id: oldTaskId,
        sessionId: "some-session",
        status: "completed",
        created: Date.now() - 7_200_000, // 2 hours ago
      });

      const freshTaskId = "fresh-task";
      asyncTasks.set(freshTaskId, {
        id: freshTaskId,
        sessionId: "some-session",
        status: "running",
        created: Date.now(),
      });

      pruneStaleSessions();
      expect(asyncTasks.has(oldTaskId)).toBe(false);
      expect(asyncTasks.has(freshTaskId)).toBe(true);
    });
  });
});
