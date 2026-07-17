import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import { ManagedBrowserProvider } from "../../src/browser/managed-browser.js";

let testRoot: string | null = null;
let cdpServer: Server | null = null;
let cdpSocketServer: WebSocketServer | null = null;
let providers = new Set<ManagedBrowserProvider>();

afterEach(async () => {
  const providerOutcomes = await Promise.allSettled(
    [...providers].map((provider) => provider.close()),
  );
  await new Promise<void>(
    (resolve) => cdpSocketServer?.close(() => resolve()) ?? resolve(),
  );
  await new Promise<void>(
    (resolve, reject) =>
      cdpServer?.close((error) => (error ? reject(error) : resolve())) ??
      resolve(),
  );
  if (testRoot) rmSync(testRoot, { recursive: true, force: true });
  testRoot = null;
  cdpServer = null;
  cdpSocketServer = null;
  providers = new Set<ManagedBrowserProvider>();
  const failedProvider = providerOutcomes.find(
    (outcome): outcome is PromiseRejectedResult =>
      outcome.status === "rejected",
  );
  if (failedProvider) throw failedProvider.reason;
});

describe("managed browser process lifecycle", () => {
  it.runIf(process.platform !== "win32")(
    "force-kills a startup process that ignores SIGTERM before deleting its ephemeral profile",
    async () => {
      testRoot = mkdtempSync(join(tmpdir(), "unicli-managed-lifecycle-"));
      const runtimeRoot = join(testRoot, "runtime");
      const pidPath = join(testRoot, "browser.pid");
      const argsPath = join(testRoot, "browser.args");
      const browserPath = join(testRoot, "fake-chromium");
      writeFileSync(
        browserPath,
        `#!/bin/sh
user_data_dir=""
printf '%s\n' "$@" > ${JSON.stringify(argsPath)}
for argument in "$@"; do
  case "$argument" in
    --user-data-dir=*) user_data_dir="\${argument#*=}" ;;
  esac
done
test -n "$user_data_dir" || exit 64
printf '%s' "$$" > ${JSON.stringify(pidPath)}
printf '9\\n/devtools/browser/unavailable\\n' > "$user_data_dir/DevToolsActivePort"
trap '' TERM
while :; do sleep 1; done
`,
        { mode: 0o700 },
      );
      chmodSync(browserPath, 0o700);
      const provider = new ManagedBrowserProvider({
        runtimeRoot,
        browserPath,
        startupTimeoutMs: 1_000,
      });
      providers.add(provider);

      await expect(
        provider.acquireTarget({
          profile_partition_id: "failed-startup",
          isolated: true,
          ephemeral: true,
        }),
      ).rejects.toMatchObject({ code: "browser_runtime_start_failed" });

      expect(existsSync(pidPath)).toBe(true);
      const launchArgs = readFileSync(argsPath, "utf8").trim().split("\n");
      expect(launchArgs.at(-1)).toBe("about:blank");
      const pid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
      expect(processIsAlive(pid)).toBe(false);
      expect(findProfileDirectories(runtimeRoot)).toEqual([]);
      await expect(provider.close()).resolves.toBeUndefined();
    },
    10_000,
  );

  it.runIf(process.platform !== "win32")(
    "contains startup descendants after the Chromium leader exits",
    async () => {
      testRoot = mkdtempSync(join(tmpdir(), "unicli-managed-descendant-"));
      const runtimeRoot = join(testRoot, "runtime");
      const markerPath = join(testRoot, "late-descendant.txt");
      const browserPath = join(testRoot, "fake-chromium");
      const descendant = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "late"), 500)`;
      writeFileSync(
        browserPath,
        `#!${process.execPath}
require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" }).unref();
process.exit(17);
`,
        { mode: 0o700 },
      );
      chmodSync(browserPath, 0o700);
      const provider = new ManagedBrowserProvider({
        runtimeRoot,
        browserPath,
        startupTimeoutMs: 1_000,
      });
      providers.add(provider);

      await expect(
        provider.acquireTarget({
          profile_partition_id: "leader-exit",
          isolated: true,
          ephemeral: true,
        }),
      ).rejects.toMatchObject({ code: "browser_runtime_start_failed" });

      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(existsSync(markerPath)).toBe(false);
      expect(findProfileDirectories(runtimeRoot)).toEqual([]);
      await expect(provider.close()).resolves.toBeUndefined();
    },
  );

  it("disposes an isolated BrowserContext when target allocation fails", async () => {
    testRoot = mkdtempSync(join(tmpdir(), "unicli-managed-allocation-"));
    const fixture = await startFailingTargetCdpFixture();
    const browserPath = join(testRoot, "fake-chromium");
    writeFileSync(
      browserPath,
      `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const userDataArg = process.argv.find((argument) => argument.startsWith("--user-data-dir="));
if (!userDataArg) process.exit(64);
const userDataDir = userDataArg.slice("--user-data-dir=".length);
fs.writeFileSync(path.join(userDataDir, "DevToolsActivePort"), ${JSON.stringify(`${String(fixture.port)}\n/devtools/browser/fixture\n`)});
setInterval(() => {}, 1000);
`,
      { mode: 0o700 },
    );
    chmodSync(browserPath, 0o700);
    const provider = new ManagedBrowserProvider({
      runtimeRoot: join(testRoot, "runtime"),
      browserPath,
      startupTimeoutMs: 5_000,
    });
    providers.add(provider);

    await expect(
      provider.acquireTarget({
        profile_partition_id: "isolated-allocation-failure",
        isolated: true,
        ephemeral: true,
      }),
    ).rejects.toThrow("Target.createTarget failed by fixture");

    expect(fixture.commands).toEqual([
      "Target.getTargets",
      "Target.createBrowserContext",
      "Target.createTarget",
      "Target.getBrowserContexts",
      "Target.disposeBrowserContext",
      "Target.getBrowserContexts",
    ]);
    expect(fixture.contexts.size).toBe(0);
    expect(provider.status()).toEqual([
      expect.objectContaining({ target_count: 0 }),
    ]);
    await expect(provider.close()).resolves.toBeUndefined();
  });

  it("converges an isolated context disposal after Chrome applies it but loses the acknowledgement", async () => {
    testRoot = mkdtempSync(join(tmpdir(), "unicli-managed-dispose-ack-"));
    const fixture = await startLostDisposeAckCdpFixture();
    const browserPath = join(testRoot, "fake-chromium");
    writeFileSync(
      browserPath,
      `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const userDataArg = process.argv.find((argument) => argument.startsWith("--user-data-dir="));
if (!userDataArg) process.exit(64);
const userDataDir = userDataArg.slice("--user-data-dir=".length);
fs.writeFileSync(path.join(userDataDir, "DevToolsActivePort"), ${JSON.stringify(`${String(fixture.port)}\n/devtools/browser/fixture\n`)});
setInterval(() => {}, 1000);
`,
      { mode: 0o700 },
    );
    chmodSync(browserPath, 0o700);
    const provider = new ManagedBrowserProvider({
      runtimeRoot: join(testRoot, "runtime"),
      browserPath,
      startupTimeoutMs: 5_000,
    });
    providers.add(provider);
    const target = await provider.acquireTarget({
      profile_partition_id: "isolated-dispose-lost-ack",
      isolated: true,
      ephemeral: true,
    });
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
      await expect(
        provider.releaseTarget(target.target_id),
      ).resolves.toBeUndefined();
    } finally {
      timerSpy.mockRestore();
    }

    expect(fixture.contexts).toEqual(new Set());
    expect(fixture.targets).toEqual(new Set());
    expect(fixture.disposeCalls()).toBe(1);
    expect(provider.status()).toEqual([
      expect.objectContaining({ target_count: 0 }),
    ]);
    await expect(
      provider.releaseTarget(target.target_id),
    ).resolves.toBeUndefined();
    expect(fixture.disposeCalls()).toBe(1);
  });
});

async function startFailingTargetCdpFixture(): Promise<{
  port: number;
  commands: string[];
  contexts: Set<string>;
}> {
  const commands: string[] = [];
  const contexts = new Set<string>();
  cdpServer = createServer((request, response) => {
    if (request.url !== "/json/version") {
      response.writeHead(404).end();
      return;
    }
    const address = cdpServer!.address();
    if (!address || typeof address === "string") {
      response.writeHead(500).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        Browser: "Fixture Chromium",
        webSocketDebuggerUrl: `ws://127.0.0.1:${String(address.port)}/devtools/browser/fixture`,
      }),
    );
  });
  cdpSocketServer = new WebSocketServer({ server: cdpServer });
  cdpSocketServer.on("connection", (socket) => {
    socket.on("message", (payload) => {
      const message = JSON.parse(payload.toString()) as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
      };
      commands.push(message.method);
      const result = (value: unknown): void => {
        socket.send(JSON.stringify({ id: message.id, result: value }));
      };
      const error = (text: string): void => {
        socket.send(
          JSON.stringify({
            id: message.id,
            error: { code: -32000, message: text },
          }),
        );
      };
      switch (message.method) {
        case "Target.getTargets":
          result({ targetInfos: [] });
          break;
        case "Target.createBrowserContext":
          contexts.add("context-leak-check");
          result({ browserContextId: "context-leak-check" });
          break;
        case "Target.createTarget":
          error("Target.createTarget failed by fixture");
          break;
        case "Target.getBrowserContexts":
          result({ browserContextIds: [...contexts] });
          break;
        case "Target.disposeBrowserContext":
          contexts.delete(String(message.params?.browserContextId));
          result({});
          break;
        case "Browser.close":
          result({});
          break;
        default:
          error(`Unsupported fixture method: ${message.method}`);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    cdpServer!.once("error", reject);
    cdpServer!.listen(0, "127.0.0.1", resolve);
  });
  const address = cdpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Managed CDP fixture has no TCP address");
  }
  return { port: address.port, commands, contexts };
}

async function startLostDisposeAckCdpFixture(): Promise<{
  port: number;
  contexts: Set<string>;
  targets: Set<string>;
  disposeCalls: () => number;
}> {
  const contexts = new Set<string>();
  const targets = new Set<string>();
  let disposeCallCount = 0;
  cdpServer = createServer((request, response) => {
    const address = cdpServer!.address();
    if (!address || typeof address === "string") {
      response.writeHead(500).end();
      return;
    }
    const origin = `ws://127.0.0.1:${String(address.port)}`;
    if (request.url === "/json/version") {
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          Browser: "Fixture Chromium",
          webSocketDebuggerUrl: `${origin}/devtools/browser/fixture`,
        }),
      );
      return;
    }
    if (request.url === "/json") {
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify(
          [...targets].map((targetId) => ({
            id: targetId,
            type: "page",
            title: "",
            url: "about:blank",
            webSocketDebuggerUrl: `${origin}/devtools/page/${targetId}`,
          })),
        ),
      );
      return;
    }
    response.writeHead(404).end();
  });
  cdpSocketServer = new WebSocketServer({ server: cdpServer });
  cdpSocketServer.on("connection", (socket) => {
    socket.on("message", (payload) => {
      const message = JSON.parse(payload.toString()) as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
      };
      const result = (value: unknown): void => {
        socket.send(JSON.stringify({ id: message.id, result: value }));
      };
      switch (message.method) {
        case "Target.getTargets":
          result({
            targetInfos: [...targets].map((targetId) => ({
              targetId,
              type: "page",
            })),
          });
          break;
        case "Target.getBrowserContexts":
          result({ browserContextIds: [...contexts] });
          break;
        case "Target.createBrowserContext":
          contexts.add("context-1");
          result({ browserContextId: "context-1" });
          break;
        case "Target.createTarget":
          targets.add("target-1");
          result({ targetId: "target-1" });
          break;
        case "Target.closeTarget":
          targets.delete(String(message.params?.targetId));
          result({ success: true });
          break;
        case "Target.disposeBrowserContext":
          disposeCallCount += 1;
          contexts.delete(String(message.params?.browserContextId));
          break;
        case "Page.enable":
        case "Browser.close":
          result({});
          break;
        default:
          socket.send(
            JSON.stringify({
              id: message.id,
              error: {
                code: -32000,
                message: `Unsupported fixture method: ${message.method}`,
              },
            }),
          );
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    cdpServer!.once("error", reject);
    cdpServer!.listen(0, "127.0.0.1", resolve);
  });
  const address = cdpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Managed lost-ACK fixture has no TCP address");
  }
  return {
    port: address.port,
    contexts,
    targets,
    disposeCalls: () => disposeCallCount,
  };
}

function findProfileDirectories(root: string): string[] {
  if (!existsSync(root)) return [];
  const profiles: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(directory, entry.name);
      if (entry.name.startsWith("profile-")) profiles.push(path);
      visit(path);
    }
  };
  visit(root);
  return profiles;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
