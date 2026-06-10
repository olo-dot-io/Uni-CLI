/**
 * Legacy HTTP MCP transport — origin-guard regression.
 *
 * Locks the DNS-rebinding defense reported missing on the simple HTTP
 * transport: a malicious web page could send a browser "simple request"
 * (text/plain, no preflight) to http://127.0.0.1:<port>/mcp and drive
 * `tools/call`. The fix rejects any non-loopback `Origin` before dispatch,
 * matching the Streamable HTTP transport. These tests reproduce the exact
 * PoC request shape and pin the three outcomes (hostile / loopback / none).
 */

import { describe, it, expect, afterEach } from "vitest";
import http, { type Server } from "node:http";
import type { AddressInfo, IncomingMessage } from "node:net";
import { startHttp } from "../../../src/mcp/http-transport.js";
import { buildHandler } from "../../../src/mcp/handler.js";
import { isOriginAllowed } from "../../../src/mcp/origin-guard.js";

interface HttpResult {
  status: number;
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
      { hostname: "127.0.0.1", port, path, method, headers: extraHeaders },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
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

const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {},
});

// The cross-origin browser-simple POST exactly as the reporter's PoC sends it.
const TOOLS_CALL_POC = JSON.stringify({
  jsonrpc: "2.0",
  id: 7,
  method: "tools/call",
  params: {
    name: "unicli_run",
    arguments: { site: "hackernews", command: "top", args: { limit: 1 } },
  },
});

function fakeOrigin(origin?: string): IncomingMessage {
  return { headers: origin ? { origin } : {} } as unknown as IncomingMessage;
}

describe("isOriginAllowed", () => {
  it("allows non-browser clients that omit Origin", () => {
    expect(isOriginAllowed(fakeOrigin())).toBe(true);
  });

  it("allows loopback origins on any port", () => {
    expect(isOriginAllowed(fakeOrigin("http://localhost"))).toBe(true);
    expect(isOriginAllowed(fakeOrigin("http://localhost:3000"))).toBe(true);
    expect(isOriginAllowed(fakeOrigin("http://127.0.0.1:19826"))).toBe(true);
  });

  it("rejects remote and malformed origins", () => {
    expect(isOriginAllowed(fakeOrigin("https://attacker.example"))).toBe(false);
    expect(
      isOriginAllowed(fakeOrigin("http://evil.localhost.attacker.com")),
    ).toBe(false);
    expect(isOriginAllowed(fakeOrigin("not-a-url"))).toBe(false);
  });
});

describe("legacy HTTP transport origin guard", () => {
  let server: Server;

  async function startServer(): Promise<number> {
    server = await startHttp(buildHandler([]), 0, false);
    return (server.address() as AddressInfo).port;
  }

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("rejects the cross-origin PoC (hostile Origin + text/plain) with 403", async () => {
    const port = await startServer();
    const res = await request(port, "POST", "/mcp", TOOLS_CALL_POC, {
      Origin: "https://attacker.example",
      "Content-Type": "text/plain;charset=UTF-8",
    });
    expect(res.status).toBe(403);
  });

  it("allows a loopback-origin request", async () => {
    const port = await startServer();
    const res = await request(port, "POST", "/mcp", INITIALIZE_BODY, {
      Origin: "http://localhost:3000",
      "Content-Type": "application/json",
    });
    expect(res.status).toBe(200);
  });

  it("allows a non-browser request that omits Origin", async () => {
    const port = await startServer();
    const res = await request(port, "POST", "/mcp", INITIALIZE_BODY, {
      "Content-Type": "application/json",
    });
    expect(res.status).toBe(200);
  });
});
