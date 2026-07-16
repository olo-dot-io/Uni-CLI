/**
 * @owner       src/browser/native-messaging.ts
 * @does        Encode, decode, bound, and stream Chrome Native Messaging length-prefixed JSON frames.
 * @needs       node:stream, src/browser/chrome-native-protocol.ts
 * @feeds       src/browser/native-host-main.ts and native-host framing tests
 * @breaks      NativeMessagingError on oversized, truncated, malformed, non-object, unwritable, or command-deadline failures.
 * @invariants  Each frame has one 4-byte little-endian length and one UTF-8 JSON object; inbound extension frames stay within 64 MiB and outbound host frames within 1 MiB.
 * @side-effects Reads a binary stream and writes framed bytes with drain backpressure.
 * @perf        O(message bytes) with at most one retained incomplete frame.
 * @concurrency One reader consumes one stream; writes await backpressure and callers serialize them.
 * @test        tests/unit/chrome-native-framing.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

import type { Readable, Writable } from "node:stream";

import {
  CHROME_NATIVE_MAX_EXTENSION_TO_HOST_BYTES,
  CHROME_NATIVE_MAX_HOST_TO_EXTENSION_BYTES,
} from "./chrome-native-protocol.js";

type NativeMessagingErrorCode =
  | "native_message_too_large"
  | "native_message_truncated"
  | "native_message_invalid"
  | "native_message_write_failed"
  | "native_message_timeout";

export class NativeMessagingError extends Error {
  readonly retryable = false;
  readonly suggestion =
    "Upgrade the Uni-CLI native host and Chrome extension together, then inspect the first invalid frame.";

  constructor(
    readonly code: NativeMessagingErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NativeMessagingError";
  }
}

export async function* readNativeMessages(
  input: Readable,
): AsyncGenerator<Record<string, unknown>> {
  let buffer = Buffer.alloc(0);
  for await (const chunk of input) {
    buffer = Buffer.concat([
      buffer,
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array),
    ]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length > CHROME_NATIVE_MAX_EXTENSION_TO_HOST_BYTES) {
        throw new NativeMessagingError(
          "native_message_too_large",
          `Chrome extension message declared ${String(length)} bytes; inbound limit is ${String(CHROME_NATIVE_MAX_EXTENSION_TO_HOST_BYTES)}`,
        );
      }
      if (buffer.length < 4 + length) break;
      const payload = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      yield decodeNativePayload(payload);
    }
  }
  if (buffer.length > 0) {
    throw new NativeMessagingError(
      "native_message_truncated",
      `Chrome native messaging stream ended with ${String(buffer.length)} incomplete bytes`,
    );
  }
}

export function encodeNativeMessage(message: Record<string, unknown>): Buffer {
  let payload: Buffer;
  try {
    payload = Buffer.from(JSON.stringify(message), "utf8");
  } catch (error) {
    throw new NativeMessagingError(
      "native_message_invalid",
      `Chrome native message is not JSON serializable: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (payload.length > CHROME_NATIVE_MAX_HOST_TO_EXTENSION_BYTES) {
    throw new NativeMessagingError(
      "native_message_too_large",
      `Chrome native host message is ${String(payload.length)} bytes; outbound limit is ${String(CHROME_NATIVE_MAX_HOST_TO_EXTENSION_BYTES)}`,
    );
  }
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export async function writeNativeMessage(
  output: Writable,
  message: Record<string, unknown>,
): Promise<void> {
  const frame = encodeNativeMessage(message);
  await new Promise<void>((resolve, reject) => {
    output.write(frame, (error) => {
      if (!error) {
        resolve();
        return;
      }
      reject(
        new NativeMessagingError(
          "native_message_write_failed",
          `Chrome native message write failed: ${error.message}`,
          { cause: error },
        ),
      );
    });
  });
}

function decodeNativePayload(payload: Buffer): Record<string, unknown> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload.toString("utf8")) as unknown;
  } catch (error) {
    throw new NativeMessagingError(
      "native_message_invalid",
      `Chrome native message is not valid JSON: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    Array.isArray(decoded)
  ) {
    throw new NativeMessagingError(
      "native_message_invalid",
      "Chrome native message must be a JSON object",
    );
  }
  return decoded as Record<string, unknown>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
