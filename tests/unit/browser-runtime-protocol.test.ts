import { createHash, randomUUID } from "node:crypto";
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
  createConnection,
  createServer as createNetServer,
  type Server,
  type Socket,
} from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  BROWSER_BROKER_PRODUCT,
  BROWSER_BROKER_PROTOCOL,
  BROWSER_BROKER_PROTOCOL_VERSION,
  browserPageCommandCanMutate,
  browserBrokerWireRequestSchema,
  type BrowserBrokerRequest,
  type BrowserBrokerResponse,
} from "../../src/browser/runtime-protocol.js";
import {
  BrowserBrokerClientError,
  BrowserRuntimeBrokerClient,
  BrowserRuntimeBrokerServer,
  browserBrokerPaths,
  readBrokerEndpointDescriptor,
  shutdownBrowserRuntimeBroker,
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
  it("classifies evidence-consuming reads as mutating only when they drain state", () => {
    expect(
      browserPageCommandCanMutate({ method: "network_capture_read" }),
    ).toBe(true);
    expect(browserPageCommandCanMutate({ method: "dialog_read" })).toBe(false);
    expect(
      browserPageCommandCanMutate({
        method: "dialog_read",
        clear_recent: false,
      }),
    ).toBe(false);
    expect(
      browserPageCommandCanMutate({
        method: "dialog_read",
        clear_recent: true,
      }),
    ).toBe(true);
  });

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

  it("propagates client cancellation to the accepted broker handler", async () => {
    runtimeRoot = mkdtempSync(join(tmpdir(), "unicli-broker-cancel-"));
    let resolveStarted!: () => void;
    let resolveAborted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      resolveAborted = resolve;
    });
    const server = createServer(randomUUID(), async (request, signal) => {
      resolveStarted();
      await new Promise<never>((_resolve, reject) => {
        const onAbort = (): void => {
          resolveAborted();
          reject(signal?.reason);
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
      return { id: request.id, ok: true };
    });
    await server.start();
    servers.push(server);
    const controller = new AbortController();
    const cancellation = new Error("cancel broker request");
    const request = new BrowserRuntimeBrokerClient({ runtimeRoot }).request(
      { id: "cancel-request", action: "broker.status" },
      controller.signal,
    );
    await started;

    controller.abort(cancellation);

    await expect(request).rejects.toBe(cancellation);
    await expect(aborted).resolves.toBeUndefined();
  });

  it("reports a mutating request as outcome-ambiguous after its frame is dispatched", async () => {
    runtimeRoot = mkdtempSync(join(tmpdir(), "unicli-broker-mutation-cancel-"));
    let resolveStarted!: () => void;
    let resolveSettled!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const server = createServer(randomUUID(), async (request) => {
      resolveStarted();
      await new Promise((resolve) => setTimeout(resolve, 25));
      resolveSettled();
      return { id: request.id, ok: true, data: { committed: true } };
    });
    await server.start();
    servers.push(server);
    const controller = new AbortController();
    const request = new BrowserRuntimeBrokerClient({ runtimeRoot }).request(
      mutatingTargetRequest("cancelled-mutation"),
      controller.signal,
    );
    await started;

    controller.abort(new DOMException("caller cancelled", "AbortError"));

    await expect(request).rejects.toMatchObject({
      name: "BrowserBrokerOutcomeAmbiguousError",
      code: "browser_command_outcome_ambiguous",
      retryable: false,
      outcome_ambiguous: true,
      requestId: "cancelled-mutation",
    });
    await expect(settled).resolves.toBeUndefined();
  });

  it("preserves broker-reported ambiguity on the client error surface", () => {
    expect(
      new BrowserBrokerClientError({
        code: "browser_command_outcome_ambiguous",
        message: "mutation settlement was lost",
        suggestion: "inspect the external effect",
        retryable: false,
        outcome_ambiguous: true,
        target_unusable: true,
      }),
    ).toMatchObject({
      outcome_ambiguous: true,
      target_unusable: true,
      retryable: false,
    });
  });

  it("reports timeout and disconnect as ambiguous after mutating dispatch", async () => {
    runtimeRoot = mkdtempSync(join(tmpdir(), "unicli-broker-mutation-loss-"));
    const server = createServer(randomUUID(), async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { id: request.id, ok: true, data: { committed: true } };
    });
    await server.start();
    servers.push(server);

    await expect(
      new BrowserRuntimeBrokerClient({
        runtimeRoot,
        requestTimeoutMs: 5,
      }).request(mutatingTargetRequest("timed-out-mutation")),
    ).rejects.toMatchObject({
      code: "browser_command_outcome_ambiguous",
      retryable: false,
      outcome_ambiguous: true,
      requestId: "timed-out-mutation",
    });

    await server.stop();
    servers = [];
    const paths = browserBrokerPaths(runtimeRoot);
    const rawServer = createNetServer((socket) => {
      rawSockets.add(socket);
      socket.once("close", () => rawSockets.delete(socket));
      socket.once("data", () => socket.destroy());
    });
    rawServers.push(rawServer);
    await new Promise<void>((resolve, reject) => {
      rawServer.once("error", reject);
      rawServer.listen(paths.socketPath, resolve);
    });
    writeRawDescriptor(paths.socketPath);

    await expect(
      new BrowserRuntimeBrokerClient({ runtimeRoot }).request(
        mutatingTargetRequest("disconnected-mutation"),
      ),
    ).rejects.toMatchObject({
      code: "browser_command_outcome_ambiguous",
      retryable: false,
      outcome_ambiguous: true,
      requestId: "disconnected-mutation",
    });
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
      id: "wrong-token",
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

  it("detects an older endpoint and can retire it through its authenticated wire version", async () => {
    runtimeRoot = mkdtempSync(join(tmpdir(), "unicli-broker-upgrade-"));
    const paths = browserBrokerPaths(runtimeRoot);
    const authToken = "u".repeat(43);
    const runtimeId = randomUUID();
    let observedVersion: number | undefined;
    const rawServer = createNetServer((socket) => {
      rawSockets.add(socket);
      socket.once("close", () => rawSockets.delete(socket));
      socket.once("data", (payload) => {
        const request = JSON.parse(payload.toString("utf8")) as {
          version?: number;
          request?: { id?: string; action?: string };
        };
        observedVersion = request.version;
        expect(request.request?.action).toBe("broker.shutdown");
        socket.end(
          `${JSON.stringify({
            id: request.request?.id,
            ok: true,
            data: { shutting_down: true },
          })}\n`,
        );
      });
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
        version: 1,
        runtime_id: runtimeId,
        pid: process.pid,
        socket_path: paths.socketPath,
        auth_token: authToken,
        started_at: new Date().toISOString(),
      })}\n`,
      { mode: 0o600 },
    );

    expect(() => readBrokerEndpointDescriptor(runtimeRoot)).toThrowError(
      expect.objectContaining({
        code: "browser_broker_protocol_mismatch",
        suggestion: expect.stringContaining("browser broker restart"),
      }),
    );
    await expect(
      shutdownBrowserRuntimeBroker({
        runtimeRoot,
        requestTimeoutMs: 1_000,
      }),
    ).resolves.toEqual({
      runtime_id: runtimeId,
      protocol_version: 1,
      response: { shutting_down: true },
    });
    expect(observedVersion).toBe(1);
  });

  it("replaces a malformed lock only after acquiring exclusive ownership", async () => {
    runtimeRoot = mkdtempSync(join(tmpdir(), "unicli-broker-lock-invalid-"));
    const paths = browserBrokerPaths(runtimeRoot);
    mkdirSync(paths.runtimeRoot, { recursive: true, mode: 0o700 });
    writeFileSync(paths.lockPath, "not-json\n", { mode: 0o600 });
    const server = createServer(randomUUID());
    servers.push(server);

    await expect(server.start()).resolves.toMatchObject({
      pid: process.pid,
    });
    expect(JSON.parse(readFileSync(paths.lockPath, "utf8"))).toMatchObject({
      pid: process.pid,
    });
  });

  it("invalidates a published broker that closes after accepting a request", async () => {
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
        requestTimeoutMs: 5_000,
      }).request({ id: "premature-end", action: "broker.status" }),
    ).rejects.toMatchObject({
      code: "browser_broker_endpoint_invalid",
      message: expect.stringContaining("lost the broker.status response"),
    });
  });

  it("preserves UTF-8 request data split across socket chunks", async () => {
    runtimeRoot = mkdtempSync(join(tmpdir(), "unicli-broker-request-utf8-"));
    let resolveObserved!: (request: BrowserBrokerRequest) => void;
    const observed = new Promise<BrowserBrokerRequest>((resolve) => {
      resolveObserved = resolve;
    });
    const server = createServer(randomUUID(), async (request) => {
      resolveObserved(request);
      return { id: request.id, ok: true };
    });
    const descriptor = await server.start();
    servers.push(server);
    const wire = Buffer.from(
      `${JSON.stringify({
        product: BROWSER_BROKER_PRODUCT,
        protocol: BROWSER_BROKER_PROTOCOL,
        version: BROWSER_BROKER_PROTOCOL_VERSION,
        auth_token: descriptor.auth_token,
        request: { id: "split-你", action: "broker.status" },
      })}\n`,
      "utf8",
    );
    const characterOffset = wire.indexOf(Buffer.from("你", "utf8"));
    const socket = createConnection(descriptor.socket_path);
    rawSockets.add(socket);
    socket.once("close", () => rawSockets.delete(socket));
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });

    socket.write(wire.subarray(0, characterOffset + 1));
    await new Promise<void>((resolve) => setImmediate(resolve));
    socket.write(wire.subarray(characterOffset + 1));
    socket.resume();

    await expect(observed).resolves.toMatchObject({ id: "split-你" });
  });

  it("preserves UTF-8 response data split across socket chunks", async () => {
    runtimeRoot = mkdtempSync(join(tmpdir(), "unicli-broker-response-utf8-"));
    const paths = browserBrokerPaths(runtimeRoot);
    mkdirSync(paths.runtimeRoot, { recursive: true, mode: 0o700 });
    const rawServer = createNetServer((socket) => {
      rawSockets.add(socket);
      socket.once("close", () => rawSockets.delete(socket));
      socket.once("data", () => {
        const payload = Buffer.from(
          `${JSON.stringify({
            id: "utf8-response",
            ok: true,
            data: { title: "你好" },
          })}\n`,
          "utf8",
        );
        const characterOffset = payload.indexOf(Buffer.from("你", "utf8"));
        socket.write(payload.subarray(0, characterOffset + 1));
        setImmediate(() => socket.end(payload.subarray(characterOffset + 1)));
      });
    });
    rawServers.push(rawServer);
    await new Promise<void>((resolve, reject) => {
      rawServer.once("error", reject);
      rawServer.listen(paths.socketPath, resolve);
    });
    writeRawDescriptor(paths.socketPath);

    const response = await new BrowserRuntimeBrokerClient({
      runtimeRoot,
    }).request({ id: "utf8-response", action: "broker.status" });

    expect(response.data).toEqual({ title: "你好" });
  });

  it("rejects an inline response belonging to a different request", async () => {
    runtimeRoot = mkdtempSync(join(tmpdir(), "unicli-broker-response-id-"));
    const paths = browserBrokerPaths(runtimeRoot);
    mkdirSync(paths.runtimeRoot, { recursive: true, mode: 0o700 });
    const rawServer = createNetServer((socket) => {
      rawSockets.add(socket);
      socket.once("close", () => rawSockets.delete(socket));
      socket.once("data", () => {
        socket.end(`${JSON.stringify({ id: "other", ok: true })}\n`);
      });
    });
    rawServers.push(rawServer);
    await new Promise<void>((resolve, reject) => {
      rawServer.once("error", reject);
      rawServer.listen(paths.socketPath, resolve);
    });
    writeRawDescriptor(paths.socketPath);

    await expect(
      new BrowserRuntimeBrokerClient({ runtimeRoot }).request({
        id: "expected",
        action: "broker.status",
      }),
    ).rejects.toMatchObject({
      code: "browser_broker_protocol_invalid",
      message: expect.stringContaining("response id mismatch"),
    });
  });

  it("rejects a response artifact belonging to a different request", async () => {
    runtimeRoot = mkdtempSync(join(tmpdir(), "unicli-broker-artifact-id-"));
    const paths = browserBrokerPaths(runtimeRoot);
    mkdirSync(paths.runtimeRoot, { recursive: true, mode: 0o700 });
    const payload = Buffer.from(
      JSON.stringify({ id: "other", ok: true, data: "a".repeat(4_300_000) }),
      "utf8",
    );
    const rawServer = createNetServer((socket) => {
      rawSockets.add(socket);
      socket.once("close", () => rawSockets.delete(socket));
      socket.once("data", () => {
        socket.write(
          `${JSON.stringify({
            id: "other",
            artifact: {
              encoding: "json",
              byte_length: payload.length,
              sha256: createHash("sha256").update(payload).digest("hex"),
            },
          })}\n`,
        );
        socket.end(payload);
      });
    });
    rawServers.push(rawServer);
    await new Promise<void>((resolve, reject) => {
      rawServer.once("error", reject);
      rawServer.listen(paths.socketPath, resolve);
    });
    writeRawDescriptor(paths.socketPath);

    await expect(
      new BrowserRuntimeBrokerClient({ runtimeRoot }).request({
        id: "expected",
        action: "broker.status",
      }),
    ).rejects.toMatchObject({
      code: "browser_broker_protocol_invalid",
      message: expect.stringContaining("artifact id mismatch"),
    });
  });

  it("streams screenshot-sized responses beyond the control-frame limit", async () => {
    runtimeRoot = mkdtempSync(join(tmpdir(), "unicli-broker-artifact-"));
    const screenshot = "a".repeat(4_300_000);
    const server = createServer(randomUUID(), async (request) => ({
      id: request.id,
      ok: true,
      data: { screenshot },
    }));
    await server.start();
    servers.push(server);

    const response = await new BrowserRuntimeBrokerClient({
      runtimeRoot,
    }).request({ id: "large-screenshot", action: "broker.status" });

    expect((response.data as { screenshot: string }).screenshot).toBe(
      screenshot,
    );
  });

  it("stops while an accepted client has not completed its request frame", async () => {
    runtimeRoot = mkdtempSync(join(tmpdir(), "unicli-broker-idle-client-"));
    const server = createServer(randomUUID());
    const descriptor = await server.start();
    servers.push(server);
    const socket = createConnection(descriptor.socket_path);
    rawSockets.add(socket);
    socket.once("close", () => rawSockets.delete(socket));
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });

    await expect(
      Promise.race([
        server.stop().then(() => "stopped"),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("timed-out"), 1_000),
        ),
      ]),
    ).resolves.toBe("stopped");
    await new Promise<void>((resolve) => {
      if (socket.destroyed) resolve();
      else socket.once("close", resolve);
    });
    expect(socket.destroyed).toBe(true);
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

  it("preserves Chrome extension outcome ambiguity at the strict broker wire boundary", () => {
    const parsed = browserBrokerWireRequestSchema.parse({
      product: BROWSER_BROKER_PRODUCT,
      protocol: BROWSER_BROKER_PROTOCOL,
      version: BROWSER_BROKER_PROTOCOL_VERSION,
      auth_token: "x".repeat(43),
      request: {
        id: "extension-ambiguous",
        action: "chrome.host.result",
        host_instance_id: randomUUID(),
        result: {
          type: "result",
          request_id: "extension-command",
          ok: false,
          error: {
            code: "chrome_navigation_timeout",
            message: "Chrome applied navigation but lost completion evidence",
            suggestion: "Inspect the target before issuing another mutation.",
            retryable: false,
            outcome_ambiguous: true,
          },
        },
      },
    });

    expect(parsed.request).toMatchObject({
      action: "chrome.host.result",
      result: { error: { outcome_ambiguous: true } },
    });
  });

  it("accepts bounded Chrome content search and foreground presence commands", () => {
    const base = {
      product: BROWSER_BROKER_PRODUCT,
      protocol: BROWSER_BROKER_PROTOCOL,
      version: BROWSER_BROKER_PROTOCOL_VERSION,
      auth_token: "x".repeat(43),
    };
    const context = {
      agent_session_id: "agent",
      turn_id: "turn",
      transport: "cli" as const,
    };
    expect(
      browserBrokerWireRequestSchema.parse({
        ...base,
        request: {
          id: "search",
          action: "chrome.content.search",
          context,
          search: {
            query: "浏览器 runtime",
            include_history: true,
            max_results: 100,
            max_tabs: 200,
            max_chars_per_tab: 500_000,
            history_start_time: 0,
          },
        },
      }).request,
    ).toMatchObject({ action: "chrome.content.search" });
    expect(
      browserBrokerWireRequestSchema.parse({
        ...base,
        request: {
          id: "presence",
          action: "target.command",
          context,
          provider: "chrome",
          visibility: "foreground",
          profile_partition_id: "default",
          command: {
            method: "agent_presence",
            visible: true,
            label: "Agent active",
          },
        },
      }).request,
    ).toMatchObject({
      command: { method: "agent_presence", label: "Agent active" },
    });
  });

  it("carries snapshot capability identity atomically with ref click and type", () => {
    const snapshotId = randomUUID();
    const base = {
      product: BROWSER_BROKER_PRODUCT,
      protocol: BROWSER_BROKER_PROTOCOL,
      version: BROWSER_BROKER_PROTOCOL_VERSION,
      auth_token: "x".repeat(43),
      request: {
        id: "atomic-ref",
        action: "target.command",
        context: {
          agent_session_id: "agent",
          turn_id: "turn",
          transport: "cli",
        },
        provider: "managed",
        visibility: "hidden",
        profile_partition_id: "default",
        isolated: false,
        ephemeral: true,
      },
    };

    expect(
      browserBrokerWireRequestSchema.parse({
        ...base,
        request: {
          ...base.request,
          command: {
            method: "click",
            selector: '[data-unicli-ref="7"]',
            snapshot_id: snapshotId,
          },
        },
      }).request,
    ).toMatchObject({
      command: { method: "click", snapshot_id: snapshotId },
    });
    expect(
      browserBrokerWireRequestSchema.parse({
        ...base,
        request: {
          ...base.request,
          command: {
            method: "type",
            selector: '[data-unicli-ref="7"]',
            snapshot_id: snapshotId,
            text: "typed",
            mode: "keystrokes",
          },
        },
      }).request,
    ).toMatchObject({
      command: {
        method: "type",
        snapshot_id: snapshotId,
        mode: "keystrokes",
      },
    });
    expect(
      browserBrokerWireRequestSchema.safeParse({
        ...base,
        request: {
          ...base.request,
          command: {
            method: "click",
            selector: '[data-unicli-ref="7"]',
            snapshot_id: "not-a-uuid",
          },
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    { query: "", max_results: 1 },
    { query: "x", max_results: 101 },
    { query: "x", max_tabs: 201 },
    { query: "x", max_chars_per_tab: 500_001 },
  ])("rejects unbounded Chrome content search %#", (search) => {
    expect(
      browserBrokerWireRequestSchema.safeParse({
        product: BROWSER_BROKER_PRODUCT,
        protocol: BROWSER_BROKER_PROTOCOL,
        version: BROWSER_BROKER_PROTOCOL_VERSION,
        auth_token: "x".repeat(43),
        request: {
          id: "search",
          action: "chrome.content.search",
          context: {
            agent_session_id: "agent",
            turn_id: "turn",
            transport: "cli",
          },
          search,
        },
      }).success,
    ).toBe(false);
  });
});

function createServer(
  runtimeId: string,
  handler: (
    request: BrowserBrokerRequest,
    signal?: AbortSignal,
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

function writeRawDescriptor(socketPath: string): void {
  if (!runtimeRoot) throw new Error("Test runtime root is not initialized");
  writeFileSync(
    browserBrokerPaths(runtimeRoot).descriptorPath,
    `${JSON.stringify({
      product: BROWSER_BROKER_PRODUCT,
      protocol: BROWSER_BROKER_PROTOCOL,
      version: BROWSER_BROKER_PROTOCOL_VERSION,
      runtime_id: randomUUID(),
      pid: process.pid,
      socket_path: socketPath,
      auth_token: "x".repeat(43),
      started_at: new Date().toISOString(),
    })}\n`,
    { mode: 0o600 },
  );
}

function mutatingTargetRequest(id: string): BrowserBrokerRequest {
  return {
    id,
    action: "target.command",
    context: {
      agent_session_id: "transport-agent",
      turn_id: "transport-turn",
      transport: "cli",
    },
    provider: "managed",
    visibility: "hidden",
    profile_partition_id: "transport-partition",
    isolated: false,
    ephemeral: true,
    command: { method: "click", selector: "#mutate" },
  };
}
