import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { WebSocketServer } from "ws";
import {
  CDPClient,
  getRemoteEndpoint,
  type RemoteEndpoint,
} from "../../src/browser/cdp-client.js";
import { isRemoteBrowser } from "../../src/browser/launcher.js";

// ── getRemoteEndpoint tests ────────────────────────────────────────

describe("getRemoteEndpoint", () => {
  const origEndpoint = process.env.UNICLI_CDP_ENDPOINT;
  const origHeaders = process.env.UNICLI_CDP_HEADERS;

  afterEach(() => {
    if (origEndpoint === undefined) delete process.env.UNICLI_CDP_ENDPOINT;
    else process.env.UNICLI_CDP_ENDPOINT = origEndpoint;
    if (origHeaders === undefined) delete process.env.UNICLI_CDP_HEADERS;
    else process.env.UNICLI_CDP_HEADERS = origHeaders;
  });

  it("returns null when UNICLI_CDP_ENDPOINT is not set", () => {
    delete process.env.UNICLI_CDP_ENDPOINT;
    delete process.env.UNICLI_CDP_HEADERS;
    expect(getRemoteEndpoint()).toBeNull();
  });

  it("returns endpoint with empty headers when only UNICLI_CDP_ENDPOINT is set", () => {
    process.env.UNICLI_CDP_ENDPOINT = "wss://browser.example.com";
    delete process.env.UNICLI_CDP_HEADERS;
    const result = getRemoteEndpoint();
    expect(result).not.toBeNull();
    expect(result!.endpoint).toBe("wss://browser.example.com");
    expect(result!.headers).toEqual({});
  });

  it("parses UNICLI_CDP_HEADERS as JSON object", () => {
    process.env.UNICLI_CDP_ENDPOINT = "wss://browser.example.com";
    process.env.UNICLI_CDP_HEADERS = JSON.stringify({
      "CF-Access-Client-Id": "abc",
      "CF-Access-Client-Secret": "xyz",
    });
    const result = getRemoteEndpoint();
    expect(result).not.toBeNull();
    expect(result!.headers).toEqual({
      "CF-Access-Client-Id": "abc",
      "CF-Access-Client-Secret": "xyz",
    });
  });

  it("ignores invalid UNICLI_CDP_HEADERS JSON gracefully", () => {
    process.env.UNICLI_CDP_ENDPOINT = "wss://browser.example.com";
    process.env.UNICLI_CDP_HEADERS = "not-json{{{";
    const result = getRemoteEndpoint();
    expect(result).not.toBeNull();
    expect(result!.headers).toEqual({});
  });

  it("ignores UNICLI_CDP_HEADERS when it parses to an array", () => {
    process.env.UNICLI_CDP_ENDPOINT = "wss://browser.example.com";
    process.env.UNICLI_CDP_HEADERS = '["not","an","object"]';
    const result = getRemoteEndpoint();
    expect(result).not.toBeNull();
    expect(result!.headers).toEqual({});
  });
});

// ── isRemoteBrowser tests ──────────────────────────────────────────

describe("isRemoteBrowser", () => {
  const origEndpoint = process.env.UNICLI_CDP_ENDPOINT;

  afterEach(() => {
    if (origEndpoint === undefined) delete process.env.UNICLI_CDP_ENDPOINT;
    else process.env.UNICLI_CDP_ENDPOINT = origEndpoint;
  });

  it("returns false when UNICLI_CDP_ENDPOINT is not set", () => {
    delete process.env.UNICLI_CDP_ENDPOINT;
    expect(isRemoteBrowser()).toBe(false);
  });

  it("returns true when UNICLI_CDP_ENDPOINT is set", () => {
    process.env.UNICLI_CDP_ENDPOINT = "wss://browser.example.com";
    expect(isRemoteBrowser()).toBe(true);
  });

  it("returns true even for empty string (truthy check)", () => {
    process.env.UNICLI_CDP_ENDPOINT = "";
    // Empty string is falsy in JS, so isRemoteBrowser should return false
    expect(isRemoteBrowser()).toBe(false);
  });
});

// ── CDPClient.connectToRemote tests ────────────────────────────────

describe("CDPClient.connectToRemote", () => {
  let server: WebSocketServer;
  let port: number;

  beforeEach(async () => {
    server = new WebSocketServer({ port: 0 });
    const addr = server.address();
    port = typeof addr === "object" && addr !== null ? addr.port : 0;

    // Auto-respond to Page.enable
    server.on("connection", (ws) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.method === "Page.enable") {
          ws.send(JSON.stringify({ id: msg.id, result: {} }));
        }
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("connects to a remote endpoint without headers", async () => {
    const client = await CDPClient.connectToRemote(
      `ws://localhost:${String(port)}`,
    );
    expect(client).toBeInstanceOf(CDPClient);
    await client.close();
  });

  it("connects to a remote endpoint with headers", async () => {
    const client = await CDPClient.connectToRemote(
      `ws://localhost:${String(port)}`,
      { Authorization: "Bearer test-token" },
    );
    expect(client).toBeInstanceOf(CDPClient);
    await client.close();
  });

  it("rejects when endpoint is unreachable", async () => {
    await expect(
      CDPClient.connectToRemote("ws://localhost:1"),
    ).rejects.toThrow();
  });
});

// ── CDPClient.connect with headers ─────────────────────────────────

describe("CDPClient.connect with headers", () => {
  let server: WebSocketServer;
  let port: number;
  let receivedHeaders: Record<string, string> = {};

  beforeEach(async () => {
    receivedHeaders = {};
    server = new WebSocketServer({
      port: 0,
      verifyClient: (info) => {
        // Capture headers from the upgrade request
        const headers = info.req.headers;
        for (const [key, value] of Object.entries(headers)) {
          if (typeof value === "string") {
            receivedHeaders[key] = value;
          }
        }
        return true;
      },
    });
    const addr = server.address();
    port = typeof addr === "object" && addr !== null ? addr.port : 0;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("passes custom headers during WebSocket handshake", async () => {
    const client = new CDPClient();
    await client.connect(`ws://localhost:${String(port)}`, {
      headers: { "X-Custom-Auth": "secret123" },
    });

    expect(receivedHeaders["x-custom-auth"]).toBe("secret123");
    await client.close();
  });

  it("connects without headers when none provided", async () => {
    const client = new CDPClient();
    await client.connect(`ws://localhost:${String(port)}`);
    // Should not have custom headers
    expect(receivedHeaders["x-custom-auth"]).toBeUndefined();
    await client.close();
  });
});
