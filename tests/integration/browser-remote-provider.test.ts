import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { BrowserRuntimeBroker } from "../../src/browser/runtime-broker.js";
import type {
  BrowserBrokerStatus,
  BrowserTargetCommandResult,
} from "../../src/browser/runtime-protocol.js";
import { RemoteBrowserProvider } from "../../src/browser/remote-browser.js";

let httpServer: Server | null = null;
let socketServer: WebSocketServer | null = null;

afterEach(async () => {
  await new Promise<void>(
    (resolve) => socketServer?.close(() => resolve()) ?? resolve(),
  );
  await new Promise<void>(
    (resolve, reject) =>
      httpServer?.close((error) => (error ? reject(error) : resolve())) ??
      resolve(),
  );
  socketServer = null;
  httpServer = null;
});

describe("broker-owned remote CDP provider", () => {
  it("keeps remote execution hidden and owned by the Agent session", async () => {
    const endpoint = await startCdpFixture();
    const broker = new BrowserRuntimeBroker({
      remoteProvider: new RemoteBrowserProvider({
        endpoint: { endpoint, headers: { "X-Test": "remote" } },
      }),
    });
    const context = {
      agent_session_id: "remote-agent",
      turn_id: "remote-turn",
      transport: "cli" as const,
    };
    await expectOk(broker, {
      id: randomUUID(),
      action: "session.start",
      context,
    });
    const result = await expectOk<BrowserTargetCommandResult>(broker, {
      id: randomUUID(),
      action: "target.command",
      context,
      provider: "remote",
      visibility: "hidden",
      profile_partition_id: "remote-account",
      command: { method: "title" },
    });

    expect(result).toMatchObject({
      provider: "remote",
      visibility: "hidden",
      data: "Remote title",
    });
    const status = await expectOk<BrowserBrokerStatus>(broker, {
      id: randomUUID(),
      action: "broker.status",
    });
    expect(status.providers.remote).toEqual({
      configured: true,
      endpoint_origin: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:/),
      target_count: 1,
      visibility: "hidden",
    });
    expect(status.sessions.target_leases[0]).toMatchObject({
      target_id: result.target_id,
      provider: "remote",
      owner_session_id: "remote-agent",
    });

    await expectOk(broker, {
      id: randomUUID(),
      action: "session.end",
      agent_session_id: "remote-agent",
    });
    expect(broker.status().providers.remote.target_count).toBe(0);
    await broker.close();
  });
});

async function startCdpFixture(): Promise<string> {
  httpServer = createServer();
  socketServer = new WebSocketServer({ server: httpServer });
  socketServer.on("connection", (socket, request) => {
    expect(request.headers["x-test"]).toBe("remote");
    socket.on("message", (payload) => {
      const requestMessage = JSON.parse(payload.toString()) as {
        id: number;
        method: string;
      };
      socket.send(
        JSON.stringify({
          id: requestMessage.id,
          result:
            requestMessage.method === "Runtime.evaluate"
              ? { result: { value: "Remote title" } }
              : {},
        }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    httpServer!.once("error", reject);
    httpServer!.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Remote CDP fixture has no TCP address");
  }
  return `ws://127.0.0.1:${String(address.port)}`;
}

async function expectOk<T = unknown>(
  broker: BrowserRuntimeBroker,
  request: Parameters<BrowserRuntimeBroker["dispatch"]>[0],
): Promise<T> {
  const response = await broker.dispatch(request);
  if (!response.ok) throw new Error(response.error?.message);
  return response.data as T;
}
