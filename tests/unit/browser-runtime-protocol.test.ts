import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createServer as createNetServer,
  type Server,
  type Socket,
} from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  BROWSER_BROKER_PRODUCT,
  BROWSER_BROKER_PROTOCOL,
  BROWSER_BROKER_PROTOCOL_VERSION,
  browserBrokerWireRequestSchema,
  type BrowserBrokerRequest,
  type BrowserBrokerResponse,
} from "../../src/browser/runtime-protocol.js";
import {
  BrowserRuntimeBrokerClient,
  BrowserRuntimeBrokerServer,
  browserBrokerPaths,
  readBrokerEndpointDescriptor,
} from "../../src/browser/runtime-transport.js";

let runtimeRoot: string | null = null;
let servers: BrowserRuntimeBrokerServer[] = [];
let rawServers: Server[] = [];
let rawSockets = new Set<Socket>();

afterEach(async () => {
  for (const server of servers.reverse()) {
    try {
      await server.stop();
    } catch {
      continue;
    }
  }
  servers = [];
  for (const socket of rawSockets) socket.destroy();
  rawSockets = new Set<Socket>();
  await Promise.all(
    rawServers.map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close(() => resolve());
        }),
    ),
  );
  rawServers = [];
  if (runtimeRoot) rmSync(runtimeRoot, { recursive: true, force: true });
  runtimeRoot = null;
});

describe("browser broker protocol and authenticated transport", () => {
  it("serves concurrent process-safe requests through an owner-only endpoint", async () => {
    runtimeRoot = mkdtempSync(join(tmpdir(), "unicli-broker-protocol-"));
    const runtimeId = randomUUID();
    const server = createServer(runtimeId, async (request) => ({
      id: request.id,
      ok: true,
      data: { action: request.action },
    }));
    await server.start();
    servers.push(server);
    const descriptor = readBrokerEndpointDescriptor(runtimeRoot);
    const client = new BrowserRuntimeBrokerClient({ runtimeRoot });

    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        client.request({
          id: `request-${String(index)}`,
          action: "broker.status",
        }),
      ),
    );

    expect(new Set(responses.map((response) => response.id)).size).toBe(12);
    expect(descriptor).toEqual(
      expect.objectContaining({
        product: BROWSER_BROKER_PRODUCT,
        protocol: BROWSER_BROKER_PROTOCOL,
        version: BROWSER_BROKER_PROTOCOL_VERSION,
        runtime_id: runtimeId,
        pid: process.pid,
      }),
    );
    if (process.platform !== "win32") {
      expect(statSync(runtimeRoot).mode & 0o777).toBe(0o700);
      expect(
        statSync(browserBrokerPaths(runtimeRoot).descriptorPath).mode & 0o777,
      ).toBe(0o600);
      expect(statSync(descriptor.socket_path).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects a validly framed request whose descriptor token is not the server token", async () => {
    runtimeRoot = mkdtempSync(join(tmpdir(), "unicli-broker-auth-"));
    const runtimeId = randomUUID();
    const server = createServer(runtimeId);
    const descriptor = await server.start();
    servers.push(server);
    const paths = browserBrokerPaths(runtimeRoot);
    writeFileSync(
      paths.descriptorPath,
      `${JSON.stringify({ ...descriptor, auth_token: "x".repeat(43) })}\n`,
      { mode: 0o600 },
    );
    chmodSync(paths.descriptorPath, 0o600);

    const response = await new BrowserRuntimeBrokerClient({
      runtimeRoot,
    }).request({ id: "wrong-token", action: "broker.status" });

    expect(response).toEqual({
      id: "invalid",
      ok: false,
      error: expect.objectContaining({
        code: "browser_broker_unauthorized",
      }),
    });
  });

  it("refuses a second live owner instead of scanning or selecting another port", async () => {
    runtimeRoot = mkdtempSync(join(tmpdir(), "unicli-broker-lock-"));
    const first = createServer(randomUUID());
    await first.start();
    servers.push(first);
    const second = createServer(randomUUID());
    servers.push(second);

    await expect(second.start()).rejects.toMatchObject({
      code: "browser_broker_already_running",
    });
  });

  it("fails closed on a malformed lock instead of deleting uncertain ownership", async () => {
    runtimeRoot = mkdtempSync(join(tmpdir(), "unicli-broker-lock-invalid-"));
    const paths = browserBrokerPaths(runtimeRoot);
    mkdirSync(paths.runtimeRoot, { recursive: true, mode: 0o700 });
    writeFileSync(paths.lockPath, "not-json\n", { mode: 0o600 });
    const server = createServer(randomUUID());
    servers.push(server);

    await expect(server.start()).rejects.toMatchObject({
      code: "browser_broker_endpoint_invalid",
    });
    expect(readFileSync(paths.lockPath, "utf8")).toBe("not-json\n");
  });

  it("fails immediately when the broker closes before a complete response", async () => {
    runtimeRoot = mkdtempSync(join(tmpdir(), "unicli-broker-premature-end-"));
    const paths = browserBrokerPaths(runtimeRoot);
    mkdirSync(paths.runtimeRoot, { recursive: true, mode: 0o700 });
    const rawServer = createNetServer((socket) => {
      rawSockets.add(socket);
      socket.once("close", () => rawSockets.delete(socket));
      socket.end();
    });
    rawServers.push(rawServer);
    await new Promise<void>((resolve, reject) => {
      rawServer.once("error", reject);
      rawServer.listen(paths.socketPath, resolve);
    });
    writeFileSync(
      paths.descriptorPath,
      `${JSON.stringify({
        product: BROWSER_BROKER_PRODUCT,
        protocol: BROWSER_BROKER_PROTOCOL,
        version: BROWSER_BROKER_PROTOCOL_VERSION,
        runtime_id: randomUUID(),
        pid: process.pid,
        socket_path: paths.socketPath,
        auth_token: "x".repeat(43),
        started_at: new Date().toISOString(),
      })}\n`,
      { mode: 0o600 },
    );

    await expect(
      new BrowserRuntimeBrokerClient({
        runtimeRoot,
        timeoutMs: 5_000,
      }).request({ id: "premature-end", action: "broker.status" }),
    ).rejects.toMatchObject({
      code: "browser_broker_unavailable",
      message: expect.stringContaining("before completing a response"),
    });
  });

  it("rejects unknown actions and implicit visibility at the wire boundary", () => {
    const base = {
      product: BROWSER_BROKER_PRODUCT,
      protocol: BROWSER_BROKER_PROTOCOL,
      version: BROWSER_BROKER_PROTOCOL_VERSION,
      auth_token: "x".repeat(43),
    };
    expect(
      browserBrokerWireRequestSchema.safeParse({
        ...base,
        request: { id: "unknown", action: "target.magic" },
      }).success,
    ).toBe(false);
    expect(
      browserBrokerWireRequestSchema.safeParse({
        ...base,
        request: {
          id: "implicit-visibility",
          action: "target.command",
          context: {
            agent_session_id: "agent",
            turn_id: "turn",
            transport: "cli",
          },
          provider: "managed",
          profile_partition_id: "partition",
          isolated: true,
          ephemeral: true,
          command: { method: "title" },
        },
      }).success,
    ).toBe(false);
  });
});

function createServer(
  runtimeId: string,
  handler: (
    request: BrowserBrokerRequest,
  ) => Promise<BrowserBrokerResponse> = async (request) => ({
    id: request.id,
    ok: true,
  }),
): BrowserRuntimeBrokerServer {
  if (!runtimeRoot) throw new Error("Test runtime root is not initialized");
  return new BrowserRuntimeBrokerServer({
    runtimeRoot,
    runtimeId,
    handler,
  });
}
