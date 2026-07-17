import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BrowserRuntimeBroker } from "../../src/browser/runtime-broker.js";
import {
  CHROME_EXTENSION_ID,
  CHROME_NATIVE_PRODUCT,
  CHROME_NATIVE_PROTOCOL,
  CHROME_NATIVE_PROTOCOL_VERSION,
  chromeTargetId,
  type ChromeNativeCommand,
  type ChromeNativeHello,
  type ChromeNativeResult,
} from "../../src/browser/chrome-native-protocol.js";
import {
  encodeNativeMessage,
  readNativeMessages,
} from "../../src/browser/native-messaging.js";
import {
  installChromeNativeHost,
  nativeHostEntryPointPath,
  type ChromeNativeHostRegistry,
  type ChromeNativeHostStatus,
} from "../../src/browser/native-host-install.js";
import type {
  BrowserBrokerStatus,
  BrowserTargetCommandResult,
} from "../../src/browser/runtime-protocol.js";
import {
  BrowserRuntimeBrokerClient,
  BrowserRuntimeBrokerServer,
  browserBrokerPaths,
} from "../../src/browser/runtime-transport.js";
import { resolveProcessOwnerBinary } from "../../src/transport/process-owner.js";
import {
  repositoryRoot,
  waitForExit,
} from "../helpers/browser-runtime-harness.js";

const BROWSER_SESSION_ID = "018f4f68-6f5b-7b01-8c02-123456789abc";
const nativeHostMainPath = join(
  repositoryRoot,
  "bin",
  "unicli-browser-native-host",
);

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

describe("Chrome native host and broker integration", () => {
  it.runIf(process.platform === "win32")(
    "atomically converges two first-install processes on one immutable Windows generation",
    async () => {
      const runtimeRoot = mkdtempSync(join(tmpdir(), "unicli-native-race-"));
      try {
        const childScript = join(
          repositoryRoot,
          "tests",
          "fixtures",
          "native-host-install-child.ts",
        );
        const tsxCli = join(
          repositoryRoot,
          "node_modules",
          "tsx",
          "dist",
          "cli.mjs",
        );
        const args = [
          tsxCli,
          childScript,
          join(runtimeRoot, "home"),
          resolveProcessOwnerBinary(),
          process.execPath,
          nativeHostEntryPointPath(),
        ];
        const [first, second] = await Promise.all([
          runInstallChild(args),
          runInstallChild(args),
        ]);

        expect(first).toMatchObject({ code: 0, stderr: "" });
        expect(second).toMatchObject({ code: 0, stderr: "" });
        const firstStatus = JSON.parse(first.stdout) as ChromeNativeHostStatus;
        const secondStatus = JSON.parse(
          second.stdout,
        ) as ChromeNativeHostStatus;
        expect(firstStatus.state).toBe("ready");
        expect(secondStatus.state).toBe("ready");
        expect(secondStatus.executable_path).toBe(firstStatus.executable_path);
      } finally {
        rmSync(runtimeRoot, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "connects through Chromium's default cmd.exe and named-pipe launch route",
    async () => {
      const runtimeRoot = mkdtempSync(join(tmpdir(), "unicli-native-cmd-"));
      const runtimeId = randomUUID();
      const broker = new BrowserRuntimeBroker({ runtimeId });
      const server = new BrowserRuntimeBrokerServer({
        runtimeId,
        runtimeRoot,
        handler: (request, signal) => broker.dispatch(request, signal),
      });
      await server.start();
      const client = new BrowserRuntimeBrokerClient({
        runtimeRoot,
        requestTimeoutMs: 10_000,
      });
      const inputServer = createServer();
      const outputServer = createServer();
      const stderr: Buffer[] = [];
      let shell: ChildProcess | undefined;
      let hostInput: Socket | undefined;
      let hostOutput: Socket | undefined;
      cleanup = async () => {
        hostInput?.destroy();
        hostOutput?.destroy();
        closeListeningServer(inputServer);
        closeListeningServer(outputServer);
        if (shell) {
          if (shell.exitCode === null) shell.kill("SIGTERM");
          await waitForExit(shell, 5_000).catch(() => shell?.kill("SIGKILL"));
        }
        await broker.close().catch(() => undefined);
        await server.stop().catch(() => undefined);
        rmSync(runtimeRoot, { recursive: true, force: true });
      };
      const [installation] = installChromeNativeHost({
        platform: "win32",
        homeDir: join(runtimeRoot, "native host & generation"),
        browsers: ["chrome"],
        registry: new MemoryRegistry(),
      });
      const token = randomUUID().replaceAll("-", "");
      const inputPipeName = `\\\\.\\pipe\\chrome.nativeMessaging.in.${token}`;
      const outputPipeName = `\\\\.\\pipe\\chrome.nativeMessaging.out.${token}`;
      await Promise.all([
        listenNamedPipe(inputServer, inputPipeName),
        listenNamedPipe(outputServer, outputPipeName),
      ]);
      const inputConnection = nextNamedPipeConnection(inputServer);
      const outputConnection = nextNamedPipeConnection(outputServer);
      shell = spawnChromiumLegacyHost(
        installation.executable_path,
        inputPipeName,
        outputPipeName,
        runtimeRoot,
      );
      shell.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
      [hostInput, hostOutput] = await waitForNamedPipeConnections(
        inputConnection,
        outputConnection,
        5_000,
      );
      inputServer.close();
      outputServer.close();
      const messages = readNativeMessages(hostOutput);

      hostInput.write(
        encodeNativeMessage(hello() as unknown as Record<string, unknown>),
      );
      await waitForChromeProvider(client);
      const connected = await client.requestOrThrow<BrowserBrokerStatus>({
        id: randomUUID(),
        action: "broker.status",
      });
      expect(connected.providers.chrome.connected).toBe(true);
      expect(shell.exitCode).toBeNull();

      const context = {
        agent_session_id: "native-cmd-agent",
        turn_id: "native-cmd-turn",
        transport: "cli" as const,
        profile_partition_id: "regular-chrome",
      };
      await client.requestOrThrow({
        id: randomUUID(),
        action: "session.start",
        context,
      });
      const listing = client.requestOrThrow({
        id: randomUUID(),
        action: "chrome.tabs.list",
        context,
      });
      const listCommand = await nextCommand(messages);
      expect(listCommand.action).toBe("tabs.list");
      hostInput.write(
        encodeNativeMessage(
          success(listCommand.request_id, []) as unknown as Record<
            string,
            unknown
          >,
        ),
      );
      await expect(listing).resolves.toEqual([]);
      await client.requestOrThrow({
        id: randomUUID(),
        action: "session.end",
        agent_session_id: context.agent_session_id,
      });

      hostInput.end();
      await waitForExit(shell, 5_000);
      expect(shell.exitCode).toBe(0);
      const disconnected = await client.requestOrThrow<BrowserBrokerStatus>({
        id: randomUUID(),
        action: "broker.status",
      });
      expect(disconnected.providers.chrome.connected).toBe(false);
      expect(Buffer.concat(stderr).toString("utf8")).toBe("");
    },
  );

  it("preserves framed target invalidation and ambiguity without disconnecting the host", async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), "unicli-native-e2e-"));
    const runtimeId = randomUUID();
    const broker = new BrowserRuntimeBroker({ runtimeId });
    const server = new BrowserRuntimeBrokerServer({
      runtimeId,
      runtimeRoot,
      handler: (request, signal) => broker.dispatch(request, signal),
    });
    await server.start();
    const client = new BrowserRuntimeBrokerClient({
      runtimeRoot,
      requestTimeoutMs: 10_000,
    });
    const {
      host,
      installedExecutablePath,
      reinstall,
      installUpdatedGeneration,
    } = spawnNativeHost(runtimeRoot);
    const stderr: Buffer[] = [];
    host.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    const messages = readNativeMessages(host.stdout!);
    cleanup = async () => {
      if (host.exitCode === null) host.kill("SIGTERM");
      await waitForExit(host, 5_000).catch(() => host.kill("SIGKILL"));
      await broker.close().catch(() => undefined);
      await server.stop();
      rmSync(runtimeRoot, { recursive: true, force: true });
    };

    writeExtensionMessage(host, hello());
    await waitForChromeProvider(client);
    if (installedExecutablePath && reinstall && installUpdatedGeneration) {
      const reinstalled = reinstall();
      expect(reinstalled).toMatchObject({
        state: "ready",
        executable_path: installedExecutablePath,
      });
      expect(host.exitCode).toBeNull();

      const updated = installUpdatedGeneration();
      expect(updated.state).toBe("ready");
      expect(updated.executable_path).not.toBe(installedExecutablePath);
      expect(host.exitCode).toBeNull();
      const stillConnected = await client.requestOrThrow<BrowserBrokerStatus>({
        id: randomUUID(),
        action: "broker.status",
      });
      expect(stillConnected.providers.chrome.connected).toBe(true);
    }
    const context = {
      agent_session_id: "native-e2e-agent",
      turn_id: "turn-1",
      transport: "cli" as const,
      profile_partition_id: "regular-chrome",
    };
    await client.requestOrThrow({
      id: randomUUID(),
      action: "session.start",
      context,
    });

    const acquiring = client.requestOrThrow<BrowserTargetCommandResult>({
      id: randomUUID(),
      action: "target.command",
      context,
      provider: "chrome",
      visibility: "background",
      profile_partition_id: "regular-chrome",
      command: { method: "title" },
    });
    const allocate = await nextCommand(messages);
    expect(allocate).toMatchObject({
      action: "target.allocate",
      visibility: "background",
    });
    const targetId = chromeTargetId(BROWSER_SESSION_ID, 71);
    writeExtensionMessage(
      host,
      success(allocate.request_id, {
        target_id: targetId,
        tab_id: 71,
        window_id: 7,
        owned: true,
        visibility: "background",
      }),
    );

    const title = await nextCommand(messages);
    expect(title).toMatchObject({
      action: "page.command",
      target_id: targetId,
      tab_id: 71,
      visibility: "background",
      command: { method: "title" },
    });
    writeExtensionMessage(host, success(title.request_id, "Example"));
    await expect(acquiring).resolves.toMatchObject({
      target_id: targetId,
      provider: "chrome",
      visibility: "background",
      data: "Example",
    });

    const unusable = client.requestOrThrow<BrowserTargetCommandResult>({
      id: randomUUID(),
      action: "target.command",
      context,
      target_id: targetId,
      provider: "chrome",
      visibility: "background",
      profile_partition_id: "regular-chrome",
      command: { method: "title" },
    });
    const failedTitle = await nextCommand(messages);
    expect(failedTitle).toMatchObject({
      action: "page.command",
      target_id: targetId,
      command: { method: "title" },
    });
    writeExtensionMessage(
      host,
      failure(failedTitle.request_id, {
        code: "chrome_target_detached",
        message: "Chrome detached the target during the command",
        suggestion: "Acquire a fresh target before continuing.",
        retryable: true,
        target_unusable: true,
      }),
    );
    await expect(unusable).rejects.toMatchObject({
      code: "browser_target_unusable",
      retryable: true,
      target_unusable: true,
    });

    const unusableFinalize = await nextCommand(messages);
    expect(unusableFinalize).toMatchObject({
      action: "target.finalize",
      target_id: targetId,
      disposition: "close",
    });
    writeExtensionMessage(host, success(unusableFinalize.request_id));
    const connectedAfterInvalidation =
      await client.requestOrThrow<BrowserBrokerStatus>({
        id: randomUUID(),
        action: "broker.status",
      });
    expect(connectedAfterInvalidation.providers.chrome.connected).toBe(true);
    expect(host.exitCode).toBeNull();

    const replacement = client.requestOrThrow<BrowserTargetCommandResult>({
      id: randomUUID(),
      action: "target.command",
      context,
      provider: "chrome",
      visibility: "background",
      profile_partition_id: "regular-chrome",
      command: { method: "title" },
    });
    const replacementAllocate = await nextCommand(messages);
    expect(replacementAllocate).toMatchObject({
      action: "target.allocate",
      visibility: "background",
    });
    const replacementTargetId = chromeTargetId(BROWSER_SESSION_ID, 72);
    writeExtensionMessage(
      host,
      success(replacementAllocate.request_id, {
        target_id: replacementTargetId,
        tab_id: 72,
        window_id: 7,
        owned: true,
        visibility: "background",
      }),
    );
    const replacementTitle = await nextCommand(messages);
    expect(replacementTitle).toMatchObject({
      action: "page.command",
      target_id: replacementTargetId,
      tab_id: 72,
      command: { method: "title" },
    });
    writeExtensionMessage(
      host,
      success(replacementTitle.request_id, "Replacement"),
    );
    await expect(replacement).resolves.toMatchObject({
      target_id: replacementTargetId,
      data: "Replacement",
    });

    const ambiguous = client.requestOrThrow<BrowserTargetCommandResult>({
      id: randomUUID(),
      action: "target.command",
      context,
      target_id: replacementTargetId,
      provider: "chrome",
      visibility: "background",
      profile_partition_id: "regular-chrome",
      command: {
        method: "evaluate",
        expression: "window.commitExternalMutation()",
      },
    });
    const mutation = await nextCommand(messages);
    expect(mutation).toMatchObject({
      action: "page.command",
      target_id: replacementTargetId,
      command: { method: "evaluate" },
    });
    writeExtensionMessage(
      host,
      failure(mutation.request_id, {
        code: "chrome_navigation_timeout",
        message: "Chrome applied the mutation but lost completion evidence",
        suggestion: "Inspect the target before issuing another mutation.",
        retryable: false,
        outcome_ambiguous: true,
      }),
    );
    await expect(ambiguous).rejects.toMatchObject({
      code: "browser_command_outcome_ambiguous",
      retryable: false,
    });

    const quarantineFinalize = await nextCommand(messages);
    expect(quarantineFinalize).toMatchObject({
      action: "target.finalize",
      target_id: replacementTargetId,
      disposition: "close",
    });
    writeExtensionMessage(host, success(quarantineFinalize.request_id));

    const finalTarget = client.requestOrThrow<BrowserTargetCommandResult>({
      id: randomUUID(),
      action: "target.command",
      context,
      provider: "chrome",
      visibility: "background",
      profile_partition_id: "regular-chrome",
      command: { method: "title" },
    });
    const finalAllocate = await nextCommand(messages);
    expect(finalAllocate).toMatchObject({
      action: "target.allocate",
      visibility: "background",
    });
    const finalTargetId = chromeTargetId(BROWSER_SESSION_ID, 73);
    writeExtensionMessage(
      host,
      success(finalAllocate.request_id, {
        target_id: finalTargetId,
        tab_id: 73,
        window_id: 7,
        owned: true,
        visibility: "background",
      }),
    );
    const finalTitle = await nextCommand(messages);
    expect(finalTitle).toMatchObject({
      action: "page.command",
      target_id: finalTargetId,
      tab_id: 73,
      command: { method: "title" },
    });
    writeExtensionMessage(host, success(finalTitle.request_id, "Final"));
    await expect(finalTarget).resolves.toMatchObject({
      target_id: finalTargetId,
      data: "Final",
    });

    const ending = client.requestOrThrow({
      id: randomUUID(),
      action: "session.end",
      agent_session_id: context.agent_session_id,
    });
    const finalize = await nextCommand(messages);
    expect(finalize).toMatchObject({
      action: "target.finalize",
      target_id: finalTargetId,
      disposition: "close",
      visibility: "background",
    });
    writeExtensionMessage(host, success(finalize.request_id));
    await expect(ending).resolves.toMatchObject({
      agent_session_id: context.agent_session_id,
      released_targets: [{ target_id: finalTargetId }],
    });

    const status = await client.requestOrThrow<BrowserBrokerStatus>({
      id: randomUUID(),
      action: "broker.status",
    });
    expect(status.providers.chrome).toMatchObject({
      connected: true,
      browser_session_id: BROWSER_SESSION_ID,
      target_count: 0,
      queued_commands: 0,
      in_flight_commands: 0,
    });
    expect(status.sessions.sessions).toEqual([]);
    host.stdin!.end();
    await waitForExit(host, 5_000);
    expect(host.exitCode).toBe(0);
    const disconnected = await client.requestOrThrow<BrowserBrokerStatus>({
      id: randomUUID(),
      action: "broker.status",
    });
    expect(disconnected.providers.chrome.connected).toBe(false);
    expect(Buffer.concat(stderr).toString("utf8")).toBe("");
  });

  it("parks one native connection across explicit broker stop and a later broker generation", async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), "unicli-native-park-"));
    let broker: BrowserRuntimeBroker | null = new BrowserRuntimeBroker({
      runtimeId: randomUUID(),
    });
    let server: BrowserRuntimeBrokerServer | null =
      new BrowserRuntimeBrokerServer({
        runtimeId: broker.runtimeId,
        runtimeRoot,
        handler: (request, signal) => broker!.dispatch(request, signal),
      });
    await server.start();
    const client = new BrowserRuntimeBrokerClient({
      runtimeRoot,
      requestTimeoutMs: 10_000,
    });
    const { host } = spawnNativeHost(runtimeRoot);
    const stderr: Buffer[] = [];
    host.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    const messages = readNativeMessages(host.stdout!);
    cleanup = async () => {
      if (host.exitCode === null) host.kill("SIGTERM");
      await waitForExit(host, 5_000).catch(() => host.kill("SIGKILL"));
      await broker?.close().catch(() => undefined);
      await server?.stop().catch(() => undefined);
      rmSync(runtimeRoot, { recursive: true, force: true });
    };

    writeExtensionMessage(host, hello());
    await waitForChromeProvider(client);
    const firstStatus = await client.requestOrThrow<BrowserBrokerStatus>({
      id: randomUUID(),
      action: "broker.status",
    });
    const firstHostId = firstStatus.providers.chrome.host_instance_id;
    expect(firstHostId).toBeTruthy();
    const hostPid = host.pid;

    await broker.close();
    await server.stop();
    broker = null;
    server = null;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(host.exitCode).toBeNull();
    expect(host.pid).toBe(hostPid);
    expect(existsSync(browserBrokerPaths(runtimeRoot).descriptorPath)).toBe(
      false,
    );
    expect(Buffer.concat(stderr).toString("utf8")).toBe("");

    broker = new BrowserRuntimeBroker({ runtimeId: randomUUID() });
    server = new BrowserRuntimeBrokerServer({
      runtimeId: broker.runtimeId,
      runtimeRoot,
      handler: (request, signal) => broker!.dispatch(request, signal),
    });
    await server.start();
    await waitForChromeProvider(client);
    const secondStatus = await client.requestOrThrow<BrowserBrokerStatus>({
      id: randomUUID(),
      action: "broker.status",
    });
    expect(secondStatus.providers.chrome.host_instance_id).toBe(firstHostId);

    const context = {
      agent_session_id: "native-park-agent",
      turn_id: "native-park-turn",
      transport: "cli" as const,
      profile_partition_id: "regular-chrome",
    };
    await client.requestOrThrow({
      id: randomUUID(),
      action: "session.start",
      context,
    });
    const listing = client.requestOrThrow({
      id: randomUUID(),
      action: "chrome.tabs.list",
      context,
    });
    const listCommand = await nextCommand(messages);
    expect(listCommand.action).toBe("tabs.list");
    writeExtensionMessage(host, success(listCommand.request_id, []));
    await expect(listing).resolves.toEqual([]);
    expect(host.exitCode).toBeNull();
    expect(Buffer.concat(stderr).toString("utf8")).toBe("");

    await broker.close();
    await server.stop();
    broker = null;
    server = null;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(host.exitCode).toBeNull();
    expect(Buffer.concat(stderr).toString("utf8")).toBe("");
    host.stdin!.end();
    await waitForExit(host, 5_000);
    expect(host.exitCode).toBe(0);
    expect(Buffer.concat(stderr).toString("utf8")).toBe("");
  });
});

interface SpawnedNativeHost {
  host: ChildProcess;
  installedExecutablePath?: string;
  reinstall?: () => ChromeNativeHostStatus;
  installUpdatedGeneration?: () => ChromeNativeHostStatus;
}

async function runInstallChild(
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return {
    code,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

function listenNamedPipe(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(path);
  });
}

function nextNamedPipeConnection(server: Server): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const onConnection = (socket: Socket) => {
      server.off("error", onError);
      resolve(socket);
    };
    const onError = (error: Error) => {
      server.off("connection", onConnection);
      reject(error);
    };
    server.once("connection", onConnection);
    server.once("error", onError);
  });
}

async function waitForNamedPipeConnections(
  input: Promise<Socket>,
  output: Promise<Socket>,
  timeoutMs: number,
): Promise<[Socket, Socket]> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.all([input, output]),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("Chromium legacy named pipes did not connect")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function closeListeningServer(server: Server): void {
  if (server.listening) server.close();
}

function spawnChromiumLegacyHost(
  executablePath: string,
  inputPipeName: string,
  outputPipeName: string,
  runtimeRoot: string,
): ChildProcess {
  const comspec = process.env.ComSpec ?? process.env.COMSPEC;
  if (!comspec)
    throw new Error("COMSPEC is required for Chromium legacy launch");
  const origin = `chrome-extension://${CHROME_EXTENSION_ID}/`;
  const command = `"${executablePath}" ${origin} --parent-window=0`;
  return spawn(
    comspec,
    ["/d", "/s", "/c", `"${command}" < ${inputPipeName} > ${outputPipeName}`],
    {
      cwd: dirname(executablePath),
      env: {
        ...process.env,
        UNICLI_BROWSER_RUNTIME_DIR: runtimeRoot,
      },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: true,
    },
  );
}

function spawnNativeHost(runtimeRoot: string): SpawnedNativeHost {
  let command = process.execPath;
  let args = [nativeHostMainPath];
  let cwd = repositoryRoot;
  let installedExecutablePath: string | undefined;
  let reinstall: (() => ChromeNativeHostStatus) | undefined;
  let installUpdatedGeneration: (() => ChromeNativeHostStatus) | undefined;
  if (process.platform === "win32") {
    const homeDir = join(runtimeRoot, "native-host-home");
    const registry = new MemoryRegistry();
    const install = () =>
      installChromeNativeHost({
        platform: "win32",
        homeDir,
        browsers: ["chrome"],
        registry,
      })[0];
    const installation = install();
    installedExecutablePath = installation.executable_path;
    reinstall = install;
    installUpdatedGeneration = () => {
      const updatedLauncher = join(runtimeRoot, "updated-native-host.exe");
      copyFileSync(installation.executable_path, updatedLauncher);
      appendFileSync(updatedLauncher, Buffer.from([0]));
      return installChromeNativeHost({
        platform: "win32",
        homeDir,
        runtime: {
          kind: "windows",
          launcherSourcePath: updatedLauncher,
          nodePath: process.execPath,
          entrypointPath: nativeHostEntryPointPath(),
        },
        browsers: ["chrome"],
        registry,
      })[0];
    };
    command = installation.executable_path;
    args = [`chrome-extension://${CHROME_EXTENSION_ID}/`, "--parent-window=0"];
    cwd = dirname(command);
  }
  const host = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      UNICLI_BROWSER_RUNTIME_DIR: runtimeRoot,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    host,
    installedExecutablePath,
    reinstall,
    installUpdatedGeneration,
  };
}

function hello(): ChromeNativeHello {
  return {
    type: "hello",
    product: CHROME_NATIVE_PRODUCT,
    protocol: CHROME_NATIVE_PROTOCOL,
    version: CHROME_NATIVE_PROTOCOL_VERSION,
    extension_id: CHROME_EXTENSION_ID,
    extension_version: "1.0.0-test",
    browser_session_id: BROWSER_SESSION_ID,
    targets: [],
  };
}

function success(requestId: string, data?: unknown): ChromeNativeResult {
  return {
    type: "result",
    request_id: requestId,
    ok: true,
    ...(data === undefined ? {} : { data }),
  };
}

function failure(
  requestId: string,
  error: Extract<ChromeNativeResult, { ok: false }>["error"],
): ChromeNativeResult {
  return {
    type: "result",
    request_id: requestId,
    ok: false,
    error,
  };
}

function writeExtensionMessage(
  host: ChildProcess,
  message: ChromeNativeHello | ChromeNativeResult,
): void {
  host.stdin!.write(
    encodeNativeMessage(message as unknown as Record<string, unknown>),
  );
}

async function nextCommand(
  messages: AsyncGenerator<Record<string, unknown>>,
): Promise<ChromeNativeCommand> {
  const next = await messages.next();
  if (next.done) throw new Error("Chrome native host stdout ended early");
  return next.value as unknown as ChromeNativeCommand;
}

async function waitForChromeProvider(
  client: BrowserRuntimeBrokerClient,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = await client.requestOrThrow<BrowserBrokerStatus>({
      id: randomUUID(),
      action: "broker.status",
    });
    if (status.providers.chrome.connected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Chrome native host did not register with the broker");
}

// REASON: the Windows registry is an external OS boundary; direct launcher execution proves host framing without changing the CI runner's browser registration.
class MemoryRegistry implements ChromeNativeHostRegistry {
  private readonly values = new Map<string, string>();

  read(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  write(key: string, manifestPath: string): void {
    this.values.set(key, manifestPath);
  }

  remove(key: string): void {
    this.values.delete(key);
  }
}
