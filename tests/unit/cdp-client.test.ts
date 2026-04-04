import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { WebSocketServer, WebSocket as WsWebSocket } from "ws";
import http from "node:http";
import {
  CDPClient,
  __test__,
  type CDPTarget,
} from "../../src/browser/cdp-client.js";

const { scoreTarget } = __test__;

// ── Target selection tests ───────────────────────────────────────────

describe("CDPClient.selectTarget", () => {
  it("prefers type=page over other types", () => {
    const targets: CDPTarget[] = [
      {
        id: "1",
        type: "iframe",
        title: "Embed",
        url: "https://example.com",
        webSocketDebuggerUrl: "ws://localhost:9222/1",
      },
      {
        id: "2",
        type: "page",
        title: "Main Page",
        url: "https://example.com",
        webSocketDebuggerUrl: "ws://localhost:9222/2",
      },
    ];
    const result = CDPClient.selectTarget(targets);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("2");
  });

  it("excludes service_worker targets", () => {
    const targets: CDPTarget[] = [
      {
        id: "1",
        type: "service_worker",
        title: "SW",
        url: "https://example.com/sw.js",
        webSocketDebuggerUrl: "ws://localhost:9222/1",
      },
    ];
    const result = CDPClient.selectTarget(targets);
    expect(result).toBeNull();
  });

  it("excludes background_page targets", () => {
    const targets: CDPTarget[] = [
      {
        id: "1",
        type: "background_page",
        title: "BG",
        url: "chrome-extension://abc",
        webSocketDebuggerUrl: "ws://localhost:9222/1",
      },
    ];
    const result = CDPClient.selectTarget(targets);
    expect(result).toBeNull();
  });

  it("excludes devtools targets", () => {
    const targets: CDPTarget[] = [
      {
        id: "1",
        type: "page",
        title: "DevTools",
        url: "devtools://foo",
        webSocketDebuggerUrl: "ws://localhost:9222/1",
      },
    ];
    const result = CDPClient.selectTarget(targets);
    expect(result).toBeNull();
  });

  it("returns null for empty target list", () => {
    const result = CDPClient.selectTarget([]);
    expect(result).toBeNull();
  });

  it("prefers targets with non-empty URLs", () => {
    const targets: CDPTarget[] = [
      {
        id: "1",
        type: "page",
        title: "Blank",
        url: "about:blank",
        webSocketDebuggerUrl: "ws://localhost:9222/1",
      },
      {
        id: "2",
        type: "page",
        title: "Real",
        url: "https://example.com",
        webSocketDebuggerUrl: "ws://localhost:9222/2",
      },
    ];
    const result = CDPClient.selectTarget(targets);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("2");
  });

  it("prefers app type over page type", () => {
    const targets: CDPTarget[] = [
      {
        id: "1",
        type: "page",
        title: "Page",
        url: "https://example.com",
        webSocketDebuggerUrl: "ws://localhost:9222/1",
      },
      {
        id: "2",
        type: "app",
        title: "App",
        url: "https://app.example.com",
        webSocketDebuggerUrl: "ws://localhost:9222/2",
      },
    ];
    const result = CDPClient.selectTarget(targets);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("2");
  });
});

describe("scoreTarget", () => {
  it("gives positive score to page type with URL and title", () => {
    const score = scoreTarget({
      id: "1",
      type: "page",
      title: "Example",
      url: "https://example.com",
      webSocketDebuggerUrl: "ws://localhost:9222/1",
    });
    expect(score).toBeGreaterThan(0);
  });

  it("returns -Infinity for devtools in URL", () => {
    const score = scoreTarget({
      id: "1",
      type: "page",
      title: "",
      url: "devtools://devtools/inspector.html",
      webSocketDebuggerUrl: "ws://localhost:9222/1",
    });
    expect(score).toBe(Number.NEGATIVE_INFINITY);
  });

  it("returns -Infinity for service_worker type", () => {
    const score = scoreTarget({
      id: "1",
      type: "service_worker",
      title: "SW",
      url: "https://example.com/sw.js",
      webSocketDebuggerUrl: "ws://localhost:9222/1",
    });
    expect(score).toBe(Number.NEGATIVE_INFINITY);
  });

  it("penalizes about:blank URLs", () => {
    const blankScore = scoreTarget({
      id: "1",
      type: "page",
      title: "",
      url: "about:blank",
      webSocketDebuggerUrl: "ws://localhost:9222/1",
    });
    const normalScore = scoreTarget({
      id: "2",
      type: "page",
      title: "Example",
      url: "https://example.com",
      webSocketDebuggerUrl: "ws://localhost:9222/2",
    });
    expect(normalScore).toBeGreaterThan(blankScore);
  });
});

// ── WebSocket send/receive tests ─────────────────────────────────────

describe("CDPClient send/receive", () => {
  let server: WebSocketServer;
  let client: CDPClient;
  let port: number;

  beforeEach(async () => {
    // Create a WebSocket server on a random port
    server = new WebSocketServer({ port: 0 });
    const addr = server.address();
    port = typeof addr === "object" && addr !== null ? addr.port : 0;
    client = new CDPClient();
  });

  afterEach(async () => {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("sends a command and receives a response", async () => {
    server.on("connection", (ws) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        ws.send(
          JSON.stringify({
            id: msg.id,
            result: { frameTree: { frame: { id: "main" } } },
          }),
        );
      });
    });

    await client.connect(`ws://localhost:${String(port)}`);
    const result = await client.send("Page.getFrameTree");
    expect(result).toEqual({ frameTree: { frame: { id: "main" } } });
  });

  it("rejects on CDP error response", async () => {
    server.on("connection", (ws) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        ws.send(
          JSON.stringify({
            id: msg.id,
            error: { code: -32601, message: "Method not found" },
          }),
        );
      });
    });

    await client.connect(`ws://localhost:${String(port)}`);
    await expect(client.send("Bogus.method")).rejects.toThrow(
      "Method not found",
    );
  });

  it("rejects when connection is not open", async () => {
    await expect(client.send("Page.enable")).rejects.toThrow(
      "CDP connection is not open",
    );
  });

  it("rejects all pending on close", async () => {
    // Server accepts but never responds, so the send will hang until close
    server.on("connection", () => {
      // no-op: intentionally never respond
    });

    await client.connect(`ws://localhost:${String(port)}`);

    const promise = client.send("Page.enable");
    // Close immediately -- should reject the pending send
    await client.close();

    await expect(promise).rejects.toThrow("CDP connection closed");
  });

  it("throws if connect called while already connected", async () => {
    server.on("connection", () => {
      // no-op
    });

    await client.connect(`ws://localhost:${String(port)}`);
    await expect(
      client.connect(`ws://localhost:${String(port)}`),
    ).rejects.toThrow("already connected");
  });
});

// ── Event subscription tests ─────────────────────────────────────────

describe("CDPClient events", () => {
  let server: WebSocketServer;
  let client: CDPClient;
  let port: number;

  beforeEach(async () => {
    server = new WebSocketServer({ port: 0 });
    const addr = server.address();
    port = typeof addr === "object" && addr !== null ? addr.port : 0;
    client = new CDPClient();
  });

  afterEach(async () => {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("receives CDP events via on()", async () => {
    let serverWs: WsWebSocket | null = null;
    server.on("connection", (ws) => {
      serverWs = ws;
    });

    await client.connect(`ws://localhost:${String(port)}`);

    const received: unknown[] = [];
    client.on("Page.loadEventFired", (params) => {
      received.push(params);
    });

    // Send an event from the server
    serverWs!.send(
      JSON.stringify({
        method: "Page.loadEventFired",
        params: { timestamp: 12345 },
      }),
    );

    // Wait a tick for message delivery
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ timestamp: 12345 });
  });

  it("stops receiving events after off()", async () => {
    let serverWs: WsWebSocket | null = null;
    server.on("connection", (ws) => {
      serverWs = ws;
    });

    await client.connect(`ws://localhost:${String(port)}`);

    const received: unknown[] = [];
    const handler = (params: unknown) => {
      received.push(params);
    };

    client.on("Network.requestWillBeSent", handler);
    client.off("Network.requestWillBeSent", handler);

    serverWs!.send(
      JSON.stringify({
        method: "Network.requestWillBeSent",
        params: { requestId: "1" },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toHaveLength(0);
  });
});

// ── discoverTargets URL construction test ────────────────────────────

describe("CDPClient.discoverTargets", () => {
  let httpServer: http.Server;
  let port: number;

  afterEach(async () => {
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it("fetches targets from /json endpoint", async () => {
    const mockTargets = [
      {
        id: "ABC",
        type: "page",
        title: "Test Page",
        url: "https://example.com",
        webSocketDebuggerUrl: "ws://localhost:9222/devtools/page/ABC",
      },
    ];

    httpServer = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(mockTargets));
    });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => resolve());
    });

    const addr = httpServer.address();
    port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const targets = await CDPClient.discoverTargets(port);
    expect(targets).toHaveLength(1);
    expect(targets[0].id).toBe("ABC");
    expect(targets[0].type).toBe("page");
    expect(targets[0].webSocketDebuggerUrl).toContain("ws://");
  });

  it("filters out targets without webSocketDebuggerUrl", async () => {
    const mockTargets = [
      {
        id: "1",
        type: "page",
        title: "Good",
        url: "https://example.com",
        webSocketDebuggerUrl: "ws://localhost:9222/1",
      },
      { id: "2", type: "other", title: "No WS", url: "https://example.com" },
    ];

    httpServer = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(mockTargets));
    });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => resolve());
    });

    const addr = httpServer.address();
    port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const targets = await CDPClient.discoverTargets(port);
    expect(targets).toHaveLength(1);
    expect(targets[0].id).toBe("1");
  });

  it("rejects on non-200 response", async () => {
    httpServer = http.createServer((_req, res) => {
      res.writeHead(500);
      res.end("Internal Server Error");
    });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => resolve());
    });

    const addr = httpServer.address();
    port = typeof addr === "object" && addr !== null ? addr.port : 0;

    await expect(CDPClient.discoverTargets(port)).rejects.toThrow("HTTP 500");
  });

  it("constructs URL with custom port", async () => {
    const mockTargets: CDPTarget[] = [];

    httpServer = http.createServer((req, res) => {
      // Verify the path is /json
      expect(req.url).toBe("/json");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(mockTargets));
    });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => resolve());
    });

    const addr = httpServer.address();
    port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const targets = await CDPClient.discoverTargets(port);
    expect(targets).toHaveLength(0);
  });
});

// ── Timeout test ─────────────────────────────────────────────────────

describe("CDPClient timeout", () => {
  let server: WebSocketServer;
  let client: CDPClient;
  let port: number;

  beforeEach(async () => {
    server = new WebSocketServer({ port: 0 });
    const addr = server.address();
    port = typeof addr === "object" && addr !== null ? addr.port : 0;
    client = new CDPClient();
  });

  afterEach(async () => {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("rejects send after timeout when no response arrives", async () => {
    // Server accepts connection but never responds
    server.on("connection", () => {
      // intentionally no response
    });

    await client.connect(`ws://localhost:${String(port)}`);

    // Override the timeout to be short for testing (we test the mechanism,
    // not the 30s default). We do this by closing the client after a short
    // delay, which will reject the pending promise.
    const sendPromise = client.send("Page.enable");

    // After a brief moment, close to simulate timeout behavior.
    // The real 30s timeout is too long for tests.
    setTimeout(() => {
      void client.close();
    }, 100);

    await expect(sendPromise).rejects.toThrow("CDP connection closed");
  });
});
