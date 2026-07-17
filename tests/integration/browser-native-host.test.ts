import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import type {
  BrowserBrokerStatus,
  BrowserTargetCommandResult,
} from "../../src/browser/runtime-protocol.js";
import {
  BrowserRuntimeBrokerClient,
  BrowserRuntimeBrokerServer,
  browserBrokerPaths,
} from "../../src/browser/runtime-transport.js";
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
  it("carries framed extension ambiguity through broker quarantine, replacement, and cleanup", async () => {
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
    const host = spawn(process.execPath, [nativeHostMainPath], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        UNICLI_BROWSER_RUNTIME_DIR: runtimeRoot,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
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

    const ambiguous = client.requestOrThrow<BrowserTargetCommandResult>({
      id: randomUUID(),
      action: "target.command",
      context,
      target_id: targetId,
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
      target_id: targetId,
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
      target_id: targetId,
      disposition: "close",
    });
    writeExtensionMessage(host, success(quarantineFinalize.request_id));

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

    const ending = client.requestOrThrow({
      id: randomUUID(),
      action: "session.end",
      agent_session_id: context.agent_session_id,
    });
    const finalize = await nextCommand(messages);
    expect(finalize).toMatchObject({
      action: "target.finalize",
      target_id: replacementTargetId,
      disposition: "close",
      visibility: "background",
    });
    writeExtensionMessage(host, success(finalize.request_id));
    await expect(ending).resolves.toMatchObject({
      agent_session_id: context.agent_session_id,
      released_targets: [{ target_id: replacementTargetId }],
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
    const host = spawn(process.execPath, [nativeHostMainPath], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        UNICLI_BROWSER_RUNTIME_DIR: runtimeRoot,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
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
