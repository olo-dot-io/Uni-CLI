/**
 * @owner       src/browser/native-host-main.ts
 * @does        Bridge one Chrome extension Native Messaging connection to the authenticated Browser Runtime Broker using register/poll/result/disconnect lifecycle.
 * @needs       node:crypto, chrome-native-protocol.ts, native-messaging.ts, runtime-protocol.ts, runtime-transport.ts
 * @feeds       bin/unicli-browser-native-host and the Chrome extension
 * @breaks      Exits nonzero with a structured stderr envelope on invalid identity/framing, broker failure, request mismatch, or disconnect.
 * @invariants  Chrome validates extension origin before launch; host validates hello identity; broker credentials remain in owner-only files and never enter extension messages.
 * @side-effects Reads/writes Native Messaging stdio frames and opens authenticated broker IPC requests.
 * @perf        One long poll per idle interval and one result request per command; no browser process is launched.
 * @concurrency One host processes one extension command at a time; broker target queues retain cross-client ordering.
 * @test        tests/unit/chrome-native-framing.test.ts, tests/integration/browser-extension-background.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

import { randomUUID } from "node:crypto";

import {
  CHROME_EXTENSION_ID,
  CHROME_NATIVE_PRODUCT,
  CHROME_NATIVE_PROTOCOL,
  CHROME_NATIVE_PROTOCOL_VERSION,
  type ChromeNativeCommand,
  type ChromeNativeHello,
  type ChromeNativeResult,
} from "./chrome-native-protocol.js";
import {
  NativeMessagingError,
  readNativeMessages,
  writeNativeMessage,
} from "./native-messaging.js";
import { BrowserRuntimeBrokerClient } from "./runtime-transport.js";

const hostInstanceId = randomUUID();
const client = new BrowserRuntimeBrokerClient({ timeoutMs: 30_000 });
const messages = readNativeMessages(process.stdin);
const HEARTBEAT_INTERVAL_MS = 10_000;
let registered = false;

async function main(): Promise<void> {
  const first = await messages.next();
  if (first.done) {
    throw new NativeMessagingError(
      "native_message_truncated",
      "Chrome native host stdin ended before the extension hello",
    );
  }
  const hello = readHello(first.value);
  await client.requestOrThrow({
    id: randomUUID(),
    action: "chrome.host.register",
    host_instance_id: hostInstanceId,
    hello,
  });
  registered = true;
  let nextExtensionMessage = settleExtensionMessage(messages.next());
  while (true) {
    const nextBrokerCommand = settleBrokerPoll(
      client.requestOrThrow<ChromeNativeCommand | null>({
        id: randomUUID(),
        action: "chrome.host.poll",
        host_instance_id: hostInstanceId,
      }),
    );
    const event = await Promise.race([nextBrokerCommand, nextExtensionMessage]);
    if (event.source === "extension") {
      if (event.error) throw event.error;
      if (event.message?.done) return;
      throw new NativeMessagingError(
        "native_message_invalid",
        "Chrome extension sent an unsolicited message while no command was in flight",
      );
    }
    if (event.error) throw event.error;
    const command = event.command;
    if (!command) continue;
    await writeNativeMessage(
      process.stdout,
      command as unknown as Record<string, unknown>,
    );
    const next = await waitForExtensionResult(nextExtensionMessage);
    if (next.error) throw next.error;
    if (!next.message || next.message.done) {
      throw new NativeMessagingError(
        "native_message_truncated",
        `Chrome extension disconnected while command ${command.request_id} was in flight`,
      );
    }
    const result = readResult(next.message.value, command.request_id);
    nextExtensionMessage = settleExtensionMessage(messages.next());
    await client.requestOrThrow({
      id: randomUUID(),
      action: "chrome.host.result",
      host_instance_id: hostInstanceId,
      result,
    });
  }
}

async function waitForExtensionResult(
  message: Promise<SettledExtensionMessage>,
): Promise<SettledExtensionMessage> {
  while (true) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const heartbeat = new Promise<"heartbeat">((resolve) => {
      timer = setTimeout(() => resolve("heartbeat"), HEARTBEAT_INTERVAL_MS);
    });
    const outcome = await Promise.race([message, heartbeat]);
    if (timer) clearTimeout(timer);
    if (outcome !== "heartbeat") return outcome;
    await client.requestOrThrow({
      id: randomUUID(),
      action: "chrome.host.heartbeat",
      host_instance_id: hostInstanceId,
    });
  }
}

type SettledBrokerPoll =
  | {
      source: "broker";
      command: ChromeNativeCommand | null;
      error?: never;
    }
  | { source: "broker"; command?: never; error: unknown };

type SettledExtensionMessage =
  | {
      source: "extension";
      message: IteratorResult<Record<string, unknown>>;
      error?: never;
    }
  | { source: "extension"; message?: never; error: unknown };

async function settleBrokerPoll(
  poll: Promise<ChromeNativeCommand | null>,
): Promise<SettledBrokerPoll> {
  try {
    return { source: "broker", command: await poll };
  } catch (error) {
    return { source: "broker", error };
  }
}

async function settleExtensionMessage(
  message: Promise<IteratorResult<Record<string, unknown>>>,
): Promise<SettledExtensionMessage> {
  try {
    return { source: "extension", message: await message };
  } catch (error) {
    return { source: "extension", error };
  }
}

function readHello(value: Record<string, unknown>): ChromeNativeHello {
  if (
    value.type !== "hello" ||
    value.product !== CHROME_NATIVE_PRODUCT ||
    value.protocol !== CHROME_NATIVE_PROTOCOL ||
    value.version !== CHROME_NATIVE_PROTOCOL_VERSION ||
    value.extension_id !== CHROME_EXTENSION_ID ||
    typeof value.extension_version !== "string" ||
    !value.extension_version.trim() ||
    typeof value.browser_session_id !== "string" ||
    !isUuid(value.browser_session_id)
  ) {
    throw new NativeMessagingError(
      "native_message_invalid",
      "Chrome extension hello identity does not match the Uni-CLI native protocol",
    );
  }
  return value as unknown as ChromeNativeHello;
}

function readResult(
  value: Record<string, unknown>,
  expectedRequestId: string,
): ChromeNativeResult {
  if (
    value.type !== "result" ||
    value.request_id !== expectedRequestId ||
    typeof value.ok !== "boolean" ||
    (value.ok === true && value.error !== undefined) ||
    (value.ok === false && !isNativeError(value.error))
  ) {
    throw new NativeMessagingError(
      "native_message_invalid",
      `Chrome extension result does not match request ${expectedRequestId}`,
    );
  }
  return value as unknown as ChromeNativeResult;
}

function isNativeError(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.code === "string" &&
    typeof record.message === "string" &&
    typeof record.suggestion === "string" &&
    typeof record.retryable === "boolean"
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function writeFatal(error: unknown): void {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      error: {
        code:
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : "chrome_native_host_failed",
        message: error instanceof Error ? error.message : String(error),
        suggestion:
          typeof error === "object" &&
          error !== null &&
          "suggestion" in error &&
          typeof error.suggestion === "string"
            ? error.suggestion
            : "Run `unicli browser native-host status --json` and inspect the broker/extension versions.",
      },
    })}\n`,
  );
}

main()
  .catch((error) => {
    writeFatal(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (!registered) return;
    try {
      await client.requestOrThrow({
        id: randomUUID(),
        action: "chrome.host.disconnect",
        host_instance_id: hostInstanceId,
      });
    } catch (error) {
      writeFatal(error);
      process.exitCode = 1;
    }
  });
