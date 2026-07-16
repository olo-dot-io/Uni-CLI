import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensureBrowserRuntimeBroker,
  probeBrowserRuntimeBroker,
} from "../../src/browser/runtime-launch.js";
import { BrowserRuntimeBroker } from "../../src/browser/runtime-broker.js";
import {
  BROWSER_BROKER_PRODUCT,
  BROWSER_BROKER_PROTOCOL,
  BROWSER_BROKER_PROTOCOL_VERSION,
  type BrowserBrokerStatus,
} from "../../src/browser/runtime-protocol.js";
import {
  BrowserRuntimeBrokerServer,
  browserBrokerPaths,
  retireBrowserRuntimeBroker,
} from "../../src/browser/runtime-transport.js";
import {
  processOwnerExists,
  spawnOwnedProcess,
  terminateOwnedProcess,
} from "../../src/transport/process-owner.js";

const require = createRequire(import.meta.url);

let runtimeRoot: string | null = null;
let manualServer: BrowserRuntimeBrokerServer | null = null;

afterEach(async () => {
  if (!runtimeRoot) return;
  if (manualServer) {
    await manualServer.stop();
    manualServer = null;
  }
  try {
    const { client } = await probeBrowserRuntimeBroker({
      runtimeRoot,
      requestTimeoutMs: 1_000,
    });
    await client.requestOrThrow({
      id: randomUUID(),
      action: "broker.shutdown",
    });
  } catch {
    // The assertion path may have stopped the broker already.
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(runtimeRoot, { recursive: true, force: true });
  runtimeRoot = null;
});

describe("browser broker lazy auto-start", () => {
  it("coalesces cold callers on one service without starting a browser", async () => {
    runtimeRoot = mkdtempSync(join(tmpdir(), "unicli-broker-autostart-"));
    const connections = await Promise.all(
      Array.from({ length: 8 }, () =>
        ensureBrowserRuntimeBroker({
          runtimeRoot,
          startupTimeoutMs: 10_000,
        }),
      ),
    );

    expect(
      new Set(connections.map(({ status }) => status.runtime_id)).size,
    ).toBe(1);
    expect(
      new Set(connections.map(({ status }) => status.broker_pid)).size,
    ).toBe(1);
    expect(connections.every(({ spawned }) => spawned)).toBe(true);
    expect(connections[0]?.status.providers.managed).toEqual([]);
    expect(connections[0]?.status.providers.chrome.connected).toBe(false);

    const warm = await ensureBrowserRuntimeBroker({ runtimeRoot });
    expect(warm.spawned).toBe(false);
    expect(warm.status.broker_pid).toBe(connections[0]?.status.broker_pid);
  });

  it("keeps startup budget independent from subsequent broker request deadlines", async () => {
    runtimeRoot = mkdtempSync(join(tmpdir(), "unicli-broker-timeouts-"));
    const broker = new BrowserRuntimeBroker();
    let statusRequests = 0;
    manualServer = new BrowserRuntimeBrokerServer({
      runtimeRoot,
      runtimeId: broker.runtimeId,
      handler: async (request, signal) => {
        if (request.action === "broker.status" && ++statusRequests > 1) {
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        return broker.dispatch(request, signal);
      },
    });
    await manualServer.start();

    const connection = await ensureBrowserRuntimeBroker({
      runtimeRoot,
      startupTimeoutMs: 25,
    });
    const startedAt = Date.now();
    const status = await connection.client.requestOrThrow<BrowserBrokerStatus>({
      id: randomUUID(),
      action: "broker.status",
    });

    expect(status.runtime_id).toBe(broker.runtimeId);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(125);
  });

  it("takes over a stale lock whose PID has been reused", async () => {
    runtimeRoot = mkdtempSync(join(tmpdir(), "unicli-broker-stale-pid-"));
    const paths = browserBrokerPaths(runtimeRoot);
    writeFileSync(
      paths.lockPath,
      `${JSON.stringify({
        pid: process.pid,
        runtime_id: randomUUID(),
        created_at: new Date(0).toISOString(),
      })}\n`,
    );
    const broker = new BrowserRuntimeBroker();
    manualServer = new BrowserRuntimeBrokerServer({
      runtimeRoot,
      runtimeId: broker.runtimeId,
      handler: (request, signal) => broker.dispatch(request, signal),
    });

    await expect(manualServer.start()).resolves.toMatchObject({
      runtime_id: broker.runtimeId,
      pid: process.pid,
    });
  });

  it("retries immediately after a failed broker child exits", async () => {
    runtimeRoot = mkdtempSync(join(tmpdir(), "unicli-broker-retry-"));
    rmSync(runtimeRoot, { recursive: true });
    writeFileSync(runtimeRoot, "blocks runtime directory");

    await expect(
      ensureBrowserRuntimeBroker({
        runtimeRoot,
        startupTimeoutMs: 1_000,
        requestTimeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: "browser_broker_start_failed" });

    rmSync(runtimeRoot, { force: true });
    mkdirSync(runtimeRoot, { recursive: true });
    await expect(
      ensureBrowserRuntimeBroker({
        runtimeRoot,
        startupTimeoutMs: 10_000,
        requestTimeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ spawned: true });
  });

  it("retires an unreachable older broker generation before starting the current protocol", async () => {
    runtimeRoot = mkdtempSync(join(tmpdir(), "unicli-broker-retire-old-"));
    const helper = join(
      process.cwd(),
      "tests",
      "helpers",
      "runtime-broker-main.ts",
    );
    // REASON: a previous-version broker process is an external compatibility boundary; this real process fixture reproduces its owner-only stale descriptor and vanished socket.
    const launch = spawnOwnedProcess(
      process.execPath,
      [
        "--import",
        pathToFileURL(require.resolve("tsx")).href,
        helper,
        runtimeRoot,
      ],
      { cwd: process.cwd(), stdio: "ignore" },
    );
    const identity = await launch.identity;
    try {
      await expect
        .poll(
          () => existsSync(browserBrokerPaths(runtimeRoot!).descriptorPath),
          { timeout: 5_000, interval: 20 },
        )
        .toBe(true);

      await expect(
        retireBrowserRuntimeBroker({
          runtimeRoot,
          requestTimeoutMs: 100,
        }),
      ).resolves.toMatchObject({
        protocol_version: BROWSER_BROKER_PROTOCOL_VERSION - 1,
        forced: true,
      });
      expect(processOwnerExists(identity)).toBe(false);
      const paths = browserBrokerPaths(runtimeRoot);
      expect(existsSync(paths.descriptorPath)).toBe(false);
      expect(existsSync(paths.lockPath)).toBe(false);

      const current = await ensureBrowserRuntimeBroker({ runtimeRoot });
      expect(current.status.version).toBe(BROWSER_BROKER_PROTOCOL_VERSION);
      expect(current.status.providers.managed).toEqual([]);
      expect(current.status.providers.chrome.connected).toBe(false);
    } finally {
      if (processOwnerExists(identity))
        await terminateOwnedProcess(launch.child);
    }
  });

  it("refuses stale endpoint files that point at an unrelated live process", async () => {
    runtimeRoot = mkdtempSync(join(tmpdir(), "unicli-broker-retire-refuse-"));
    const paths = browserBrokerPaths(runtimeRoot);
    const runtimeId = randomUUID();
    const startedAt = new Date().toISOString();
    writeFileSync(
      paths.lockPath,
      `${JSON.stringify({
        pid: process.pid,
        runtime_id: runtimeId,
        created_at: startedAt,
      })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      paths.descriptorPath,
      `${JSON.stringify({
        product: BROWSER_BROKER_PRODUCT,
        protocol: BROWSER_BROKER_PROTOCOL,
        version: Math.max(1, BROWSER_BROKER_PROTOCOL_VERSION - 1),
        runtime_id: runtimeId,
        pid: process.pid,
        socket_path: paths.socketPath,
        auth_token: "unrelated-process-token-unrelated-process-token",
        started_at: startedAt,
      })}\n`,
      { mode: 0o600 },
    );

    await expect(
      retireBrowserRuntimeBroker({ runtimeRoot, requestTimeoutMs: 100 }),
    ).rejects.toMatchObject({ code: "browser_broker_endpoint_invalid" });
    expect(() => process.kill(process.pid, 0)).not.toThrow();
    expect(existsSync(paths.descriptorPath)).toBe(true);
    expect(existsSync(paths.lockPath)).toBe(true);
  });

  it("probes a secret-bearing legacy endpoint before refusing a second owner", async () => {
    runtimeRoot = mkdtempSync(join(tmpdir(), "unicli-broker-legacy-probe-"));
    const paths = browserBrokerPaths(runtimeRoot);
    const runtimeId = randomUUID();
    const authToken = randomUUID().replaceAll("-", "").repeat(2);
    let probes = 0;
    const legacyServer = createServer((socket) => {
      acceptLegacyProbe(socket, authToken, () => {
        probes += 1;
      });
    });
    await listenServer(legacyServer, paths.socketPath);
    writeFileSync(
      paths.lockPath,
      `${JSON.stringify({
        pid: process.pid,
        runtime_id: runtimeId,
        created_at: new Date().toISOString(),
      })}\n`,
    );
    writeFileSync(
      paths.descriptorPath,
      `${JSON.stringify({
        product: BROWSER_BROKER_PRODUCT,
        protocol: BROWSER_BROKER_PROTOCOL,
        version: BROWSER_BROKER_PROTOCOL_VERSION,
        runtime_id: runtimeId,
        pid: process.pid,
        socket_path: paths.socketPath,
        auth_token: authToken,
        started_at: new Date().toISOString(),
      })}\n`,
      { mode: 0o600 },
    );
    const contender = new BrowserRuntimeBrokerServer({
      runtimeRoot,
      runtimeId: randomUUID(),
      handler: async (request) => ({ id: request.id, ok: true, data: {} }),
    });

    try {
      await expect(contender.start()).rejects.toMatchObject({
        code: "browser_broker_already_running",
      });
      expect(probes).toBe(1);
      expect(legacyServer.listening).toBe(true);
    } finally {
      await contender.stop();
      await closeServer(legacyServer);
    }
  });

  it("refuses takeover when a published legacy descriptor is malformed", async () => {
    runtimeRoot = mkdtempSync(join(tmpdir(), "unicli-broker-legacy-invalid-"));
    const paths = browserBrokerPaths(runtimeRoot);
    const legacyServer = createServer((socket) => socket.end());
    await listenServer(legacyServer, paths.socketPath);
    writeFileSync(paths.descriptorPath, "{malformed\n", { mode: 0o600 });
    const contender = new BrowserRuntimeBrokerServer({
      runtimeRoot,
      runtimeId: randomUUID(),
      handler: async (request) => ({ id: request.id, ok: true, data: {} }),
    });

    try {
      await expect(contender.start()).rejects.toMatchObject({
        code: "browser_broker_endpoint_invalid",
      });
      expect(legacyServer.listening).toBe(true);
    } finally {
      await contender.stop();
      await closeServer(legacyServer);
    }
  });

  it("refuses to unlink a reachable legacy socket without a descriptor", async () => {
    runtimeRoot = mkdtempSync(join(tmpdir(), "unicli-broker-legacy-unowned-"));
    const paths = browserBrokerPaths(runtimeRoot);
    let connections = 0;
    const legacyServer = createServer((socket) => {
      connections += 1;
      socket.end();
    });
    await listenServer(legacyServer, paths.socketPath);
    const contender = new BrowserRuntimeBrokerServer({
      runtimeRoot,
      runtimeId: randomUUID(),
      handler: async (request) => ({ id: request.id, ok: true, data: {} }),
    });

    try {
      await expect(contender.start()).rejects.toMatchObject({
        code: "browser_broker_already_running",
      });
      expect(connections).toBe(1);
      expect(legacyServer.listening).toBe(true);
    } finally {
      await contender.stop();
      await closeServer(legacyServer);
    }
  });

  it("does not auto-start after a published endpoint accepts then loses status", async () => {
    runtimeRoot = mkdtempSync(join(tmpdir(), "unicli-broker-legacy-loss-"));
    const paths = browserBrokerPaths(runtimeRoot);
    const authToken = randomUUID().replaceAll("-", "").repeat(2);
    const legacyServer = createServer((socket) => {
      socket.once("data", () => socket.destroy());
    });
    await listenServer(legacyServer, paths.socketPath);
    writeFileSync(
      paths.descriptorPath,
      `${JSON.stringify({
        product: BROWSER_BROKER_PRODUCT,
        protocol: BROWSER_BROKER_PROTOCOL,
        version: BROWSER_BROKER_PROTOCOL_VERSION,
        runtime_id: randomUUID(),
        pid: process.pid,
        socket_path: paths.socketPath,
        auth_token: authToken,
        started_at: new Date().toISOString(),
      })}\n`,
      { mode: 0o600 },
    );

    try {
      await expect(
        ensureBrowserRuntimeBroker({ runtimeRoot, startupTimeoutMs: 200 }),
      ).rejects.toMatchObject({
        code: "browser_broker_endpoint_invalid",
        retryable: false,
      });
      expect(legacyServer.listening).toBe(true);
    } finally {
      await closeServer(legacyServer);
    }
  });

  it("probes a trusted alternate legacy socket path before takeover", async () => {
    runtimeRoot = mkdtempSync(join(tmpdir(), "unicli-broker-legacy-path-"));
    const paths = browserBrokerPaths(runtimeRoot);
    const legacySocketPath = join(runtimeRoot, "legacy-broker.sock");
    const runtimeId = randomUUID();
    const authToken = randomUUID().replaceAll("-", "").repeat(2);
    let probes = 0;
    const legacyServer = createServer((socket) => {
      acceptLegacyProbe(socket, authToken, () => {
        probes += 1;
      });
    });
    await listenServer(legacyServer, legacySocketPath);
    writeFileSync(
      paths.descriptorPath,
      `${JSON.stringify({
        product: BROWSER_BROKER_PRODUCT,
        protocol: BROWSER_BROKER_PROTOCOL,
        version: BROWSER_BROKER_PROTOCOL_VERSION,
        runtime_id: runtimeId,
        pid: process.pid,
        socket_path: legacySocketPath,
        auth_token: authToken,
        started_at: new Date().toISOString(),
      })}\n`,
      { mode: 0o600 },
    );
    const contender = new BrowserRuntimeBrokerServer({
      runtimeRoot,
      runtimeId: randomUUID(),
      handler: async (request) => ({ id: request.id, ok: true, data: {} }),
    });

    try {
      await expect(contender.start()).rejects.toMatchObject({
        code: "browser_broker_already_running",
      });
      expect(probes).toBe(1);
      expect(legacyServer.listening).toBe(true);
    } finally {
      await contender.stop();
      await closeServer(legacyServer);
    }
  });
});

function acceptLegacyProbe(
  socket: Socket,
  authToken: string,
  markProbe: () => void,
): void {
  let input = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    input += chunk;
    const newline = input.indexOf("\n");
    if (newline < 0) return;
    const envelope = JSON.parse(input.slice(0, newline)) as {
      auth_token: string;
      request: { id: string; action: string };
    };
    if (
      envelope.auth_token !== authToken ||
      envelope.request.action !== "broker.status"
    ) {
      socket.destroy(new Error("Unexpected broker ownership probe"));
      return;
    }
    markProbe();
    socket.end(
      `${JSON.stringify({ id: envelope.request.id, ok: true, data: {} })}\n`,
    );
  });
}

function listenServer(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
