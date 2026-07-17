import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  CHROME_NATIVE_MAX_EXTENSION_TO_HOST_BYTES,
  CHROME_NATIVE_MAX_HOST_TO_EXTENSION_BYTES,
  isChromeNativeError,
} from "../../src/browser/chrome-native-protocol.js";
import {
  encodeNativeMessage,
  readNativeMessages,
  writeNativeMessage,
} from "../../src/browser/native-messaging.js";

describe("Chrome Native Messaging framing", () => {
  it("decodes multiple frames across arbitrary stream chunk boundaries", async () => {
    const input = new PassThrough();
    const first = encodeNativeMessage({ type: "first", value: 1 });
    const second = encodeNativeMessage({ type: "second", value: 2 });
    const collecting = collect(input);

    input.write(first.subarray(0, 2));
    input.write(Buffer.concat([first.subarray(2), second.subarray(0, 7)]));
    input.end(second.subarray(7));

    await expect(collecting).resolves.toEqual([
      { type: "first", value: 1 },
      { type: "second", value: 2 },
    ]);
  });

  it("writes a frame that the same bounded reader can consume", async () => {
    const channel = new PassThrough();
    const collecting = collect(channel);
    await writeNativeMessage(channel, { type: "roundtrip", ok: true });
    channel.end();
    await expect(collecting).resolves.toEqual([
      { type: "roundtrip", ok: true },
    ]);
  });

  it("rejects an oversized declared frame before allocating its payload", async () => {
    const input = new PassThrough();
    const header = Buffer.alloc(4);
    header.writeUInt32LE(CHROME_NATIVE_MAX_EXTENSION_TO_HOST_BYTES + 1, 0);
    const collecting = collect(input);
    input.end(header);

    await expect(collecting).rejects.toMatchObject({
      code: "native_message_too_large",
    });
  });

  it("enforces Chrome's smaller host-to-extension frame limit", () => {
    expect(() =>
      encodeNativeMessage({
        type: "command",
        value: "x".repeat(CHROME_NATIVE_MAX_HOST_TO_EXTENSION_BYTES),
      }),
    ).toThrowError(
      expect.objectContaining({ code: "native_message_too_large" }),
    );
  });

  it("rejects a truncated final frame instead of dropping it", async () => {
    const input = new PassThrough();
    const frame = encodeNativeMessage({ type: "truncated" });
    const collecting = collect(input);
    input.end(frame.subarray(0, frame.length - 1));

    await expect(collecting).rejects.toMatchObject({
      code: "native_message_truncated",
    });
  });

  it("rejects non-object JSON payloads", async () => {
    const input = new PassThrough();
    const payload = Buffer.from("[]", "utf8");
    const frame = Buffer.alloc(4 + payload.length);
    frame.writeUInt32LE(payload.length, 0);
    payload.copy(frame, 4);
    const collecting = collect(input);
    input.end(frame);

    await expect(collecting).rejects.toMatchObject({
      code: "native_message_invalid",
    });
  });

  it("validates target invalidation through the strict shared error contract", () => {
    const error = {
      code: "chrome_target_detached",
      message: "Chrome detached the target",
      suggestion: "Acquire a fresh target.",
      retryable: true,
      target_unusable: true,
    };

    expect(isChromeNativeError(error)).toBe(true);
    expect(isChromeNativeError({ ...error, target_unusable: "yes" })).toBe(
      false,
    );
    expect(isChromeNativeError({ ...error, internal: "leak" })).toBe(false);
    expect(isChromeNativeError({ ...error, code: ` ${error.code}` })).toBe(
      false,
    );
    expect(isChromeNativeError({ ...error, code: " ".repeat(1_000_000) })).toBe(
      false,
    );
  });
});

async function collect(input: PassThrough): Promise<Record<string, unknown>[]> {
  const messages: Record<string, unknown>[] = [];
  for await (const message of readNativeMessages(input)) messages.push(message);
  return messages;
}
