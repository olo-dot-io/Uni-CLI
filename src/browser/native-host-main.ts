/**
 * @owner       src/browser/native-host-main.ts
 * @does        Bridge one Chrome extension Native Messaging connection and its reconciled target inventory to the authenticated Browser Runtime Broker using register/poll/result/disconnect lifecycle.
 * @needs       node:crypto, chrome-native-protocol.ts, native-messaging.ts, runtime-launch.ts, runtime-protocol.ts, runtime-transport.ts
 * @feeds       bin/unicli-browser-native-host and the Chrome extension
 * @breaks      Exits nonzero with a structured stderr envelope on invalid identity/framing, non-retryable broker corruption, request mismatch, command deadline, or disconnect failure.
 * @invariants  Chrome validates extension origin before launch; host validates hello identity; broker credentials remain in owner-only files and never enter extension messages; explicit broker shutdown parks this same native connection without launching a replacement broker; an extension command that exceeds its deadline terminates this host generation so the port can reconnect.
 * @side-effects Reads/writes Native Messaging stdio frames, probes authenticated broker IPC, and remains parked while no running broker exists; it never starts the broker.
 * @perf        One long poll per connected idle interval and a 250ms local probe while parked; no browser or broker process is launched.
 * @concurrency One host processes one extension command at a time; broker target queues retain cross-client ordering; a parked host keeps exactly one pending extension read while broker generations change.
 * @test        tests/unit/chrome-native-framing.test.ts, tests/integration/browser-extension-background.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

import { randomUUID } from "node:crypto";

import {
  CHROME_EXTENSION_ID,
  CHROME_NATIVE_COMMAND_DEADLINE_MS,
  CHROME_NATIVE_PRODUCT,
  CHROME_NATIVE_PROTOCOL,
  CHROME_NATIVE_PROTOCOL_VERSION,
  type ChromeNativeBrokerCommand,
  type ChromeNativeHello,
  type ChromeNativeResult,
  type ChromeNativeTarget,
} from "./chrome-native-protocol.js";
import {
  NativeMessagingError,
  readNativeMessages,
  writeNativeMessage,
} from "./native-messaging.js";
import { probeBrowserRuntimeBroker } from "./runtime-launch.js";
import type { BrowserBrokerStatus } from "./runtime-protocol.js";
import {
  BrokerTransportError,
  BrowserBrokerClientError,
  BrowserRuntimeBrokerClient,
} from "./runtime-transport.js";

const hostInstanceId = randomUUID();
const client = new BrowserRuntimeBrokerClient({ requestTimeoutMs: 30_000 });
const messages = readNativeMessages(process.stdin);
const HEARTBEAT_INTERVAL_MS = 10_000;
const BROKER_STANDBY_POLL_MS = 250;
const BROKER_STANDBY_PROBE_TIMEOUT_MS = 1_000;
const EXTENSION_RESULT_DEADLINE_MS = readCommandDeadline(process.env);
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
  const extensionInbox: ExtensionInbox = {
    next: settleExtensionMessage(messages.next()),
  };
  while (true) {
    const availability = await waitForRunningBroker(extensionInbox.next);
    if (availability.source === "extension") {
      handleIdleExtensionEvent(availability);
      return;
    }
    try {
      await client.requestOrThrow({
        id: randomUUID(),
        action: "chrome.host.register",
        host_instance_id: hostInstanceId,
        hello,
      });
      registered = true;
      const outcome = await bridgeRegisteredHost(extensionInbox);
      if (outcome.kind === "extension-ended") return;
    } catch (error) {
      if (!brokerConnectionCanRecover(error)) throw error;
      registered = false;
    }
  }
}

async function bridgeRegisteredHost(
  extensionInbox: ExtensionInbox,
): Promise<BrokerSessionOutcome> {
  for (;;) {
    const nextBrokerCommand = settleBrokerPoll(
      client.requestOrThrow<ChromeNativeBrokerCommand | null>({
        id: randomUUID(),
        action: "chrome.host.poll",
        host_instance_id: hostInstanceId,
      }),
    );
    const event = await Promise.race([nextBrokerCommand, extensionInbox.next]);
    if (event.source === "extension") {
      handleIdleExtensionEvent(event);
      return { kind: "extension-ended" };
    }
    if (event.error) {
      if (brokerConnectionCanRecover(event.error)) {
        registered = false;
        return { kind: "standby" };
      }
      throw event.error;
    }
    const command = event.command;
    if (!command) continue;
    if (command.action === "host.shutdown") {
      await client.requestOrThrow({
        id: randomUUID(),
        action: "chrome.host.result",
        host_instance_id: hostInstanceId,
        result: {
          type: "result",
          request_id: command.request_id,
          ok: true,
        },
      });
      registered = false;
      return { kind: "standby" };
    }
    await writeNativeMessage(
      process.stdout,
      command as unknown as Record<string, unknown>,
    );
    const next = await waitForExtensionResult(
      extensionInbox.next,
      command.request_id,
    );
    if (next.error) throw next.error;
    if (!next.message || next.message.done) {
      throw new NativeMessagingError(
        "native_message_truncated",
        `Chrome extension disconnected while command ${command.request_id} was in flight`,
      );
    }
    const result = readResult(next.message.value, command.request_id);
    extensionInbox.next = settleExtensionMessage(messages.next());
    await client.requestOrThrow({
      id: randomUUID(),
      action: "chrome.host.result",
      host_instance_id: hostInstanceId,
      result,
    });
  }
}

async function waitForRunningBroker(
  nextExtensionMessage: Promise<SettledExtensionMessage>,
): Promise<BrokerAvailability> {
  for (;;) {
    const probe = settleBrokerProbe(
      probeBrowserRuntimeBroker({
        requestTimeoutMs: BROKER_STANDBY_PROBE_TIMEOUT_MS,
      }),
    );
    const event = await Promise.race([probe, nextExtensionMessage]);
    if (event.source === "extension") return event;
    if (event.error && !brokerConnectionCanRecover(event.error)) {
      throw event.error;
    }
    if (event.status?.lifecycle === "running") return { source: "broker" };
    const pause = await Promise.race([
      delay(BROKER_STANDBY_POLL_MS),
      nextExtensionMessage,
    ]);
    if (pause && typeof pause === "object" && "source" in pause) {
      return pause;
    }
  }
}

function handleIdleExtensionEvent(event: SettledExtensionMessage): void {
  if (event.error) throw event.error;
  if (event.message?.done) return;
  const value = event.message?.value;
  throw new NativeMessagingError(
    "native_message_invalid",
    `Chrome extension sent an unsolicited message while no command was in flight (${describeNativeMessage(value)})`,
  );
}

function describeNativeMessage(
  value: Record<string, unknown> | undefined,
): string {
  if (!value) return "missing payload";
  const type = typeof value.type === "string" ? value.type : "unknown type";
  const requestId =
    typeof value.request_id === "string"
      ? `, request_id=${value.request_id}`
      : "";
  return `${type}${requestId}`;
}

function brokerConnectionCanRecover(error: unknown): boolean {
  return (
    (error instanceof BrokerTransportError ||
      error instanceof BrowserBrokerClientError) &&
    error.retryable
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForExtensionResult(
  message: Promise<SettledExtensionMessage>,
  requestId: string,
): Promise<SettledExtensionMessage> {
  const deadline = Date.now() + EXTENSION_RESULT_DEADLINE_MS;
  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new NativeMessagingError(
        "native_message_timeout",
        `Chrome extension command ${requestId} exceeded its ${String(EXTENSION_RESULT_DEADLINE_MS)}ms execution deadline`,
      );
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const heartbeat = new Promise<"heartbeat" | "deadline">((resolve) => {
      const waitMs = Math.min(HEARTBEAT_INTERVAL_MS, remainingMs);
      timer = setTimeout(
        () => resolve(waitMs === remainingMs ? "deadline" : "heartbeat"),
        waitMs,
      );
    });
    const outcome = await Promise.race([message, heartbeat]);
    if (timer) clearTimeout(timer);
    if (outcome === "deadline") {
      throw new NativeMessagingError(
        "native_message_timeout",
        `Chrome extension command ${requestId} exceeded its ${String(EXTENSION_RESULT_DEADLINE_MS)}ms execution deadline`,
      );
    }
    if (outcome !== "heartbeat") return outcome;
    await client.requestOrThrow({
      id: randomUUID(),
      action: "chrome.host.heartbeat",
      host_instance_id: hostInstanceId,
    });
  }
}

function readCommandDeadline(env: NodeJS.ProcessEnv): number {
  const raw = env.UNICLI_CHROME_NATIVE_COMMAND_DEADLINE_MS?.trim();
  if (!raw) return CHROME_NATIVE_COMMAND_DEADLINE_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1_000) {
    throw new NativeMessagingError(
      "native_message_invalid",
      "UNICLI_CHROME_NATIVE_COMMAND_DEADLINE_MS must be an integer of at least 1000ms",
    );
  }
  return value;
}

type SettledBrokerPoll =
  | {
      source: "broker";
      command: ChromeNativeBrokerCommand | null;
      error?: never;
    }
  | { source: "broker"; command?: never; error: unknown };

type SettledBrokerProbe =
  | { source: "probe"; status: BrowserBrokerStatus; error?: never }
  | { source: "probe"; status?: never; error: unknown };

type SettledExtensionMessage =
  | {
      source: "extension";
      message: IteratorResult<Record<string, unknown>>;
      error?: never;
    }
  | { source: "extension"; message?: never; error: unknown };

type BrokerAvailability = { source: "broker" } | SettledExtensionMessage;

interface BrokerSessionOutcome {
  kind: "standby" | "extension-ended";
}

interface ExtensionInbox {
  next: Promise<SettledExtensionMessage>;
}

async function settleBrokerPoll(
  poll: Promise<ChromeNativeBrokerCommand | null>,
): Promise<SettledBrokerPoll> {
  try {
    return { source: "broker", command: await poll };
  } catch (error) {
    return { source: "broker", error };
  }
}

async function settleBrokerProbe(
  probe: ReturnType<typeof probeBrowserRuntimeBroker>,
): Promise<SettledBrokerProbe> {
  try {
    return { source: "probe", status: (await probe).status };
  } catch (error) {
    return { source: "probe", error };
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
    !isUuid(value.browser_session_id) ||
    !Array.isArray(value.targets) ||
    !value.targets.every(isChromeNativeTarget)
  ) {
    throw new NativeMessagingError(
      "native_message_invalid",
      "Chrome extension hello identity does not match the Uni-CLI native protocol",
    );
  }
  return value as unknown as ChromeNativeHello;
}

function isChromeNativeTarget(value: unknown): value is ChromeNativeTarget {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.target_id === "string" &&
    isNonnegativeInteger(record.tab_id) &&
    isNonnegativeInteger(record.window_id) &&
    typeof record.owned === "boolean" &&
    (record.visibility === "background" ||
      record.visibility === "foreground") &&
    (record.url === undefined || typeof record.url === "string") &&
    (record.title === undefined || typeof record.title === "string")
  );
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
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
    typeof record.retryable === "boolean" &&
    (record.outcome_ambiguous === undefined ||
      typeof record.outcome_ambiguous === "boolean")
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
      if (!brokerConnectionCanRecover(error)) {
        writeFatal(error);
        process.exitCode = 1;
      }
    }
  });
