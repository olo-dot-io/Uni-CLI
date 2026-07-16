import http from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { currentBrowserInvocationScope } from "../../../src/browser/invocation-scope.js";
import { MCP_PROTOCOL_VERSION } from "../../../src/constants.js";
import { buildHandler } from "../../../src/mcp/handler.js";
import { startHttp, stopHttp } from "../../../src/mcp/http-transport.js";
import { isOriginAllowed } from "../../../src/mcp/origin-guard.js";
import type { McpTool } from "../../../src/mcp/tools.js";

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  port: number,
  body: string,
  extraHeaders?: Record<string, string>,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: { "Content-Type": "application/json", ...extraHeaders },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () =>
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

function fakeOrigin(origin?: string): http.IncomingMessage {
  return {
    headers: origin ? { origin } : {},
  } as unknown as http.IncomingMessage;
}

describe("HTTP compatibility transport", () => {
  let port: number | undefined;

  afterEach(async () => {
    if (port !== undefined) await stopHttp(port, "HTTP test complete");
    port = undefined;
  });

  async function initialize(
    handler = buildHandler([]),
  ): Promise<{ sessionId: string; handler: ReturnType<typeof buildHandler> }> {
    port = await startHttp(handler, 0, false);
    const response = await request(
      port,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    );
    expect(response.status).toBe(200);
    return {
      sessionId: response.headers["mcp-session-id"] as string,
      handler,
    };
  }

  it("retains the loopback Origin guard on the compatibility entry point", async () => {
    expect(isOriginAllowed(fakeOrigin())).toBe(true);
    expect(isOriginAllowed(fakeOrigin("http://localhost:3000"))).toBe(true);
    expect(isOriginAllowed(fakeOrigin("https://attacker.example"))).toBe(false);

    port = await startHttp(buildHandler([]), 0, false);
    const forbidden = await request(
      port,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
      { Origin: "https://attacker.example" },
    );
    expect(forbidden.status).toBe(403);
  });

  it("validates malformed envelopes before handler dispatch", async () => {
    port = await startHttp(buildHandler([]), 0, false);
    for (const body of [
      "null",
      "[]",
      "1",
      "{}",
      JSON.stringify({ jsonrpc: "1.0", id: 1, method: "initialize" }),
      JSON.stringify({ jsonrpc: "2.0", id: true, method: "initialize" }),
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "", params: {} }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: [],
      }),
    ]) {
      const response = await request(port, body);
      expect(response.status).toBe(400);
      expect(JSON.parse(response.body)).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32_600, message: "Invalid Request" },
      });
    }
  });

  it("preserves the server-owned browser policy after session upgrade", async () => {
    const inspectionTool: McpTool = {
      name: "inspect_browser_policy",
      description: "Inspect browser policy",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      execution: { taskSupport: "optional" },
      handler: () => ({
        content: [{ type: "text", text: "ok" }],
        structuredContent: {
          type: "json",
          data: currentBrowserInvocationScope(),
        },
      }),
    };
    const handler = buildHandler([inspectionTool], [], {
      browserPolicy: {
        provider: "chrome",
        visibility: "background",
        profilePartitionId: "http-browser",
      },
    });
    const { sessionId } = await initialize(handler);
    const called = await request(
      port!,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "inspect_browser_policy", arguments: {} },
      }),
      {
        "MCP-Session-Id": sessionId,
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      },
    );
    expect(called.status).toBe(200);
    expect(JSON.parse(called.body).result.structuredContent.data).toMatchObject(
      {
        provider: "chrome",
        visibility: "background",
        profilePartitionId: "http-browser",
      },
    );
  });

  it("keeps standard task ownership stable across HTTP requests", async () => {
    const handler = buildHandler([
      {
        name: "mutate",
        description: "test mutation",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: false },
        execution: { taskSupport: "required" },
        handler: async () => ({
          content: [{ type: "text", text: "authoritative" }],
        }),
      },
    ]);
    const { sessionId } = await initialize(handler);
    const headers = {
      "MCP-Session-Id": sessionId,
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    };
    const created = await request(
      port!,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "mutate", arguments: {}, task: {} },
      }),
      headers,
    );
    const taskId = JSON.parse(created.body).result.task.taskId as string;
    const result = await request(
      port!,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tasks/result",
        params: { taskId },
      }),
      headers,
    );
    expect(JSON.parse(result.body).result).toMatchObject({
      content: [{ type: "text", text: "authoritative" }],
      _meta: { "io.modelcontextprotocol/related-task": { taskId } },
    });
  });
});
