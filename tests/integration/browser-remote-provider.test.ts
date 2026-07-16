import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import { BrowserRuntimeBroker } from "../../src/browser/runtime-broker.js";
import type {
  BrowserBrokerStatus,
  BrowserTargetCommandResult,
} from "../../src/browser/runtime-protocol.js";
import { RemoteBrowserProvider } from "../../src/browser/remote-browser.js";

let httpServer: Server | null = null;
let socketServer: WebSocketServer | null = null;
let brokers = new Set<BrowserRuntimeBroker>();

afterEach(async () => {
  const brokerOutcomes = await Promise.allSettled(
    [...brokers].map((broker) => broker.close()),
  );
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
  brokers = new Set<BrowserRuntimeBroker>();
  vi.unstubAllEnvs();
  const failedBroker = brokerOutcomes.find(
    (outcome): outcome is PromiseRejectedResult =>
      outcome.status === "rejected",
  );
  if (failedBroker) throw failedBroker.reason;
});

describe("broker-owned remote CDP provider", () => {
  it("keeps broker status and local providers available when optional remote config is invalid", async () => {
    vi.stubEnv("UNICLI_CDP_ENDPOINT", "https://example.test/not-cdp");
    const broker = new BrowserRuntimeBroker();
    brokers.add(broker);
    const context = {
      agent_session_id: "invalid-remote-agent",
      turn_id: "invalid-remote-turn",
      transport: "cli" as const,
    };

    await expectOk(broker, {
      id: randomUUID(),
      action: "session.start",
      context,
    });
    const status = await expectOk<BrowserBrokerStatus>(broker, {
      id: randomUUID(),
      action: "broker.status",
    });
    expect(status.providers.managed).toEqual([]);
    expect(status.providers.chrome).toBeDefined();
    expect(status.providers.remote).toEqual({
      configured: false,
      configuration_error: "UNICLI_CDP_ENDPOINT must use ws:// or wss://",
      target_count: 0,
      visibility: "hidden",
    });

    await expect(
      broker.dispatch({
        id: randomUUID(),
        action: "target.command",
        context,
        provider: "remote",
        visibility: "hidden",
        profile_partition_id: "remote-account",
        command: { method: "title" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "remote_browser_configuration_invalid" },
    });
  });

  it("allocates one remote BrowserContext and flattened CDP session per Agent session", async () => {
    const fixture = await startCdpFixture();
    const broker = new BrowserRuntimeBroker({
      remoteProvider: new RemoteBrowserProvider({
        endpoint: {
          endpoint: fixture.endpoint,
          headers: { "X-Test": "remote" },
        },
      }),
    });
    brokers.add(broker);
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
    const navigated = await expectOk<BrowserTargetCommandResult>(broker, {
      id: randomUUID(),
      action: "target.command",
      context,
      provider: "remote",
      visibility: "hidden",
      profile_partition_id: "remote-account",
      command: { method: "navigate", url: "https://example.test/remote" },
    });
    const result = await expectOk<BrowserTargetCommandResult>(broker, {
      id: randomUUID(),
      action: "target.command",
      context,
      target_id: navigated.target_id,
      provider: "remote",
      visibility: "hidden",
      profile_partition_id: "remote-account",
      command: { method: "title" },
    });
    const secondContext = {
      agent_session_id: "remote-agent-2",
      turn_id: "remote-turn-2",
      transport: "mcp" as const,
    };
    await expectOk(broker, {
      id: randomUUID(),
      action: "session.start",
      context: secondContext,
    });
    const second = await expectOk<BrowserTargetCommandResult>(broker, {
      id: randomUUID(),
      action: "target.command",
      context: secondContext,
      provider: "remote",
      visibility: "hidden",
      profile_partition_id: "remote-account",
      command: { method: "title" },
    });

    expect(result).toMatchObject({
      provider: "remote",
      visibility: "hidden",
      data: "Remote title context-1",
    });
    expect(second.data).toBe("Remote title context-2");
    expect(second.target_id).not.toBe(result.target_id);
    const status = await expectOk<BrowserBrokerStatus>(broker, {
      id: randomUUID(),
      action: "broker.status",
    });
    expect(status.providers.remote).toEqual({
      configured: true,
      endpoint_origin: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:/),
      target_count: 2,
      visibility: "hidden",
    });
    expect(
      status.sessions.target_leases.find(
        (lease) => lease.target_id === result.target_id,
      ),
    ).toMatchObject({
      target_id: result.target_id,
      provider: "remote",
      owner_session_id: "remote-agent",
    });
    const pageCommands = fixture.commands.filter((command) =>
      /^(?:Page|Runtime)\./.test(command.method),
    );
    expect(pageCommands.length).toBeGreaterThanOrEqual(4);
    expect(
      pageCommands.every((command) => typeof command.sessionId === "string"),
    ).toBe(true);
    expect(
      new Set(
        fixture.commands
          .filter((command) => command.method === "Runtime.evaluate")
          .map((command) => command.sessionId),
      ).size,
    ).toBe(2);

    for (const agentSessionId of ["remote-agent", "remote-agent-2"]) {
      await expectOk(broker, {
        id: randomUUID(),
        action: "session.end",
        agent_session_id: agentSessionId,
      });
    }
    expect(broker.status().providers.remote.target_count).toBe(0);
    await broker.close();
  });

  it("rejects page-level endpoints that cannot create owned BrowserContexts", async () => {
    const fixture = await startCdpFixture({ supportsBrowserContext: false });
    const broker = new BrowserRuntimeBroker({
      remoteProvider: new RemoteBrowserProvider({
        endpoint: {
          endpoint: fixture.endpoint,
          headers: { "X-Test": "remote" },
        },
      }),
    });
    brokers.add(broker);
    const context = {
      agent_session_id: "unsupported-remote-agent",
      turn_id: "unsupported-remote-turn",
      transport: "mcp-http" as const,
    };
    await expectOk(broker, {
      id: randomUUID(),
      action: "session.start",
      context,
    });

    const response = await broker.dispatch({
      id: randomUUID(),
      action: "target.command",
      context,
      provider: "remote",
      visibility: "hidden",
      profile_partition_id: "remote-account",
      command: { method: "title" },
    });

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "remote_browser_endpoint_unsupported",
        retryable: false,
      },
    });
    expect(fixture.commands.map((command) => command.method)).toEqual([
      "Target.createBrowserContext",
    ]);
    await broker.close();
  });

  it("converges remote context disposal when the server applies it but loses the acknowledgement", async () => {
    const fixture = await startCdpFixture({
      loseDisposeAcknowledgement: true,
    });
    const provider = new RemoteBrowserProvider({
      endpoint: {
        endpoint: fixture.endpoint,
        headers: { "X-Test": "remote" },
      },
    });
    const targetId = await provider.acquireTarget();
    expect(fixture.liveContextCount()).toBe(1);

    const realSetTimeout = globalThis.setTimeout;
    const timerSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((
        callback: TimerHandler,
        delay?: number,
        ...args: unknown[]
      ) =>
        realSetTimeout(
          callback,
          delay === 30_000 ? 25 : delay,
          ...args,
        )) as typeof setTimeout);
    try {
      await expect(provider.releaseTarget(targetId)).resolves.toBeUndefined();
    } finally {
      timerSpy.mockRestore();
    }

    expect(fixture.liveContextCount()).toBe(0);
    expect(fixture.disposeCalls()).toBe(1);
    expect(provider.status().target_count).toBe(0);
    await expect(provider.releaseTarget(targetId)).resolves.toBeUndefined();
    expect(fixture.disposeCalls()).toBe(1);
    await provider.close();
  });
});

interface ObservedCdpCommand {
  method: string;
  sessionId?: string;
}

async function startCdpFixture(
  options: {
    supportsBrowserContext?: boolean;
    loseDisposeAcknowledgement?: boolean;
  } = {},
): Promise<{
  endpoint: string;
  commands: ObservedCdpCommand[];
  liveContextCount(): number;
  disposeCalls(): number;
}> {
  httpServer = createServer();
  socketServer = new WebSocketServer({ server: httpServer });
  const contexts = new Set<string>();
  const targetContexts = new Map<string, string>();
  const sessionTargets = new Map<string, string>();
  const commands: ObservedCdpCommand[] = [];
  let disposeCalls = 0;
  socketServer.on("connection", (socket, request) => {
    expect(request.headers["x-test"]).toBe("remote");
    socket.on("message", (payload) => {
      const requestMessage = JSON.parse(payload.toString()) as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
        sessionId?: string;
      };
      commands.push({
        method: requestMessage.method,
        ...(requestMessage.sessionId
          ? { sessionId: requestMessage.sessionId }
          : {}),
      });
      const sendResult = (result: unknown): void => {
        socket.send(JSON.stringify({ id: requestMessage.id, result }));
      };
      const sendError = (message: string): void => {
        socket.send(
          JSON.stringify({
            id: requestMessage.id,
            error: { code: -32000, message },
          }),
        );
      };
      const requireSession = (): string | null => {
        const sessionId = requestMessage.sessionId;
        if (!sessionId || !sessionTargets.has(sessionId)) {
          sendError("Page command requires a valid flattened sessionId");
          return null;
        }
        return sessionId;
      };
      switch (requestMessage.method) {
        case "Target.createBrowserContext": {
          if (options.supportsBrowserContext === false) {
            sendError("Target.createBrowserContext is unavailable");
            break;
          }
          const contextId = `context-${String(contexts.size + 1)}`;
          contexts.add(contextId);
          sendResult({ browserContextId: contextId });
          break;
        }
        case "Target.createTarget": {
          const contextId = requestMessage.params?.browserContextId;
          if (typeof contextId !== "string" || !contexts.has(contextId)) {
            sendError("Target.createTarget requires an owned BrowserContext");
            break;
          }
          const targetId = `target-${String(targetContexts.size + 1)}`;
          targetContexts.set(targetId, contextId);
          sendResult({ targetId });
          break;
        }
        case "Target.attachToTarget": {
          const targetId = requestMessage.params?.targetId;
          if (typeof targetId !== "string" || !targetContexts.has(targetId)) {
            sendError("Target.attachToTarget requires an owned target");
            break;
          }
          const sessionId = `session-${String(sessionTargets.size + 1)}`;
          sessionTargets.set(sessionId, targetId);
          sendResult({ sessionId });
          break;
        }
        case "Page.enable":
        case "Page.setLifecycleEventsEnabled": {
          if (requireSession()) sendResult({});
          break;
        }
        case "Page.navigate": {
          const sessionId = requireSession();
          if (!sessionId) break;
          socket.send(
            JSON.stringify({
              id: requestMessage.id,
              result: {
                frameId: "frame",
                loaderId: `loader-${String(requestMessage.id)}`,
              },
            }),
            () => {
              socket.send(
                JSON.stringify({
                  method: "Page.lifecycleEvent",
                  params: {
                    frameId: "frame",
                    loaderId: `loader-${String(requestMessage.id)}`,
                    name: "load",
                  },
                  sessionId,
                }),
              );
            },
          );
          break;
        }
        case "Runtime.evaluate": {
          const sessionId = requireSession();
          if (!sessionId) break;
          const targetId = sessionTargets.get(sessionId)!;
          const contextId = targetContexts.get(targetId)!;
          sendResult({ result: { value: `Remote title ${contextId}` } });
          break;
        }
        case "Target.disposeBrowserContext": {
          disposeCalls += 1;
          const contextId = requestMessage.params?.browserContextId;
          if (typeof contextId !== "string" || !contexts.delete(contextId)) {
            sendError("Unknown BrowserContext");
            break;
          }
          for (const [targetId, ownedContextId] of targetContexts) {
            if (ownedContextId !== contextId) continue;
            targetContexts.delete(targetId);
            for (const [sessionId, ownedTargetId] of sessionTargets) {
              if (ownedTargetId === targetId) sessionTargets.delete(sessionId);
            }
          }
          if (options.loseDisposeAcknowledgement && disposeCalls === 1) break;
          sendResult({});
          break;
        }
        default:
          sendError(`Unsupported fixture method: ${requestMessage.method}`);
      }
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
  return {
    endpoint: `ws://127.0.0.1:${String(address.port)}`,
    commands,
    liveContextCount: () => contexts.size,
    disposeCalls: () => disposeCalls,
  };
}

async function expectOk<T = unknown>(
  broker: BrowserRuntimeBroker,
  request: Parameters<BrowserRuntimeBroker["dispatch"]>[0],
): Promise<T> {
  const response = await broker.dispatch(request);
  if (!response.ok) throw new Error(response.error?.message);
  return response.data as T;
}
