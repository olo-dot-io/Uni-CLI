import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ChromeBrowserProvider } from "../../src/browser/chrome-provider.js";
import {
  CHROME_EXTENSION_ID,
  CHROME_NATIVE_PRODUCT,
  CHROME_NATIVE_PROTOCOL,
  CHROME_NATIVE_PROTOCOL_VERSION,
  chromeTargetId,
  type ChromeNativeHello,
  type ChromeNativeResult,
} from "../../src/browser/chrome-native-protocol.js";

const BROWSER_SESSION_ID = "018f4f68-6f5b-7b01-8c02-123456789abc";

describe("ChromeBrowserProvider", () => {
  it("correlates allocation, page mutation, and owned-target close through one registered host", async () => {
    const provider = new ChromeBrowserProvider();
    const hostId = randomUUID();
    provider.registerHost(hostId, hello());

    const acquiring = provider.acquireTarget("background");
    const allocate = await provider.poll(hostId);
    expect(allocate).toMatchObject({
      action: "target.allocate",
      visibility: "background",
    });
    provider.deliver(
      hostId,
      success(allocate!.request_id, {
        target_id: chromeTargetId(BROWSER_SESSION_ID, 42),
        tab_id: 42,
        window_id: 7,
        owned: true,
        visibility: "background",
      }),
    );
    const target = await acquiring;

    const reading = provider.execute(target.target_id, "background", {
      method: "title",
    });
    const read = await provider.poll(hostId);
    expect(read).toMatchObject({
      action: "page.command",
      target_id: target.target_id,
      tab_id: 42,
      command: { method: "title" },
    });
    provider.deliver(hostId, success(read!.request_id, "Example"));
    await expect(reading).resolves.toBe("Example");

    const releasing = provider.releaseTarget(target.target_id);
    const finalize = await provider.poll(hostId);
    expect(finalize).toMatchObject({
      action: "target.finalize",
      disposition: "close",
    });
    provider.deliver(hostId, success(finalize!.request_id));
    await releasing;
    expect(provider.status()).toMatchObject({
      connected: true,
      target_count: 0,
      queued_commands: 0,
      in_flight_commands: 0,
    });
    provider.close();
  });

  it("releases a claimed user tab without closing it", async () => {
    const provider = new ChromeBrowserProvider();
    const hostId = randomUUID();
    provider.registerHost(hostId, hello());
    const claiming = provider.claimTarget(81, "background");
    const claim = await provider.poll(hostId);
    provider.deliver(
      hostId,
      success(claim!.request_id, {
        target_id: chromeTargetId(BROWSER_SESSION_ID, 81),
        tab_id: 81,
        window_id: 9,
        owned: false,
        visibility: "background",
      }),
    );
    const target = await claiming;

    const releasing = provider.releaseTarget(target.target_id);
    const finalize = await provider.poll(hostId);
    expect(finalize).toMatchObject({
      action: "target.finalize",
      disposition: "release",
    });
    provider.deliver(hostId, success(finalize!.request_id));
    await releasing;
    provider.close();
  });

  it("preserves exact extension refusal envelopes", async () => {
    const provider = new ChromeBrowserProvider();
    const hostId = randomUUID();
    provider.registerHost(hostId, hello());
    const acquiring = provider.acquireTarget("background");
    const command = await provider.poll(hostId);
    provider.deliver(hostId, {
      type: "result",
      request_id: command!.request_id,
      ok: false,
      error: {
        code: "background_unavailable",
        message: "Chrome has no existing normal window",
        suggestion: "Open Chrome explicitly or use the hidden provider.",
        retryable: false,
      },
    });

    await expect(acquiring).rejects.toMatchObject({
      code: "background_unavailable",
      message: "Chrome has no existing normal window",
      retryable: false,
    });
    provider.close();
  });

  it("rejects competing live hosts and all in-flight work on disconnect", async () => {
    const provider = new ChromeBrowserProvider();
    const hostId = randomUUID();
    provider.registerHost(hostId, hello());
    expect(() =>
      provider.registerHost(
        randomUUID(),
        hello("018f4f68-6f5b-7b01-8c02-abcdefabcdef"),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "chrome_provider_conflict" }),
    );
    const acquiring = provider.acquireTarget("background");
    const rejected = expect(acquiring).rejects.toMatchObject({
      code: "chrome_provider_disconnected",
    });
    await provider.poll(hostId);
    provider.disconnectHost(hostId);
    await rejected;
    expect(provider.status().connected).toBe(false);
    provider.close();
  });

  it("lets a same-browser native host reconnect supersede a lost in-flight host", async () => {
    const provider = new ChromeBrowserProvider();
    const oldHostId = randomUUID();
    const newHostId = randomUUID();
    provider.registerHost(oldHostId, hello());
    const acquiring = provider.acquireTarget("background");
    const rejected = expect(acquiring).rejects.toMatchObject({
      code: "chrome_provider_disconnected",
    });
    await provider.poll(oldHostId);
    provider.registerHost(newHostId, hello());
    await rejected;
    expect(provider.status()).toMatchObject({
      connected: true,
      host_instance_id: newHostId,
      in_flight_commands: 0,
    });
    provider.close();
  });

  it("expires a host that stops polling and permits a clean replacement", () => {
    let now = 100;
    const provider = new ChromeBrowserProvider({
      now: () => now,
      hostTtlMs: 10,
    });
    provider.registerHost(randomUUID(), hello());
    now = 111;
    expect(provider.status().connected).toBe(false);
    expect(() => provider.registerHost(randomUUID(), hello())).not.toThrow();
    provider.close();
  });

  it("uses native-host heartbeats rather than in-flight work as liveness evidence", async () => {
    let now = 100;
    const provider = new ChromeBrowserProvider({
      now: () => now,
      hostTtlMs: 10,
    });
    const hostId = randomUUID();
    provider.registerHost(hostId, hello());
    const acquiring = provider.acquireTarget("background");
    const command = await provider.poll(hostId);
    now = 105;
    provider.heartbeat(hostId);
    now = 110;
    expect(provider.status().connected).toBe(true);
    provider.deliver(
      hostId,
      success(command!.request_id, {
        target_id: chromeTargetId(BROWSER_SESSION_ID, 91),
        tab_id: 91,
        window_id: 7,
        owned: true,
        visibility: "background",
      }),
    );
    await acquiring;
    now = 121;
    expect(provider.status().connected).toBe(false);
    provider.close();
  });

  it("rejects a target whose logical id does not match its Chrome tab", async () => {
    const provider = new ChromeBrowserProvider();
    const hostId = randomUUID();
    provider.registerHost(hostId, hello());
    const acquiring = provider.acquireTarget("background");
    const command = await provider.poll(hostId);
    provider.deliver(
      hostId,
      success(command!.request_id, {
        target_id: chromeTargetId(BROWSER_SESSION_ID, 92),
        tab_id: 93,
        window_id: 7,
        owned: true,
        visibility: "background",
      }),
    );
    await expect(acquiring).rejects.toMatchObject({
      code: "chrome_provider_protocol_invalid",
    });
    provider.close();
  });

  it("marks old-browser targets stale and clears them without touching the new browser session", async () => {
    const provider = new ChromeBrowserProvider();
    const firstHostId = randomUUID();
    provider.registerHost(firstHostId, hello());
    const acquiring = provider.acquireTarget("background");
    const command = await provider.poll(firstHostId);
    provider.deliver(
      firstHostId,
      success(command!.request_id, {
        target_id: chromeTargetId(BROWSER_SESSION_ID, 94),
        tab_id: 94,
        window_id: 7,
        owned: true,
        visibility: "background",
      }),
    );
    const target = await acquiring;
    provider.disconnectHost(firstHostId);
    provider.registerHost(
      randomUUID(),
      hello("018f4f68-6f5b-7b01-8c02-abcdefabcdef"),
    );
    expect(provider.status()).toMatchObject({
      target_count: 0,
      stale_target_count: 1,
    });
    await provider.releaseTarget(target.target_id);
    expect(provider.status()).toMatchObject({
      target_count: 0,
      stale_target_count: 0,
      queued_commands: 0,
    });
    provider.close();
  });
});

function hello(browserSessionId = BROWSER_SESSION_ID): ChromeNativeHello {
  return {
    type: "hello",
    product: CHROME_NATIVE_PRODUCT,
    protocol: CHROME_NATIVE_PROTOCOL,
    version: CHROME_NATIVE_PROTOCOL_VERSION,
    extension_id: CHROME_EXTENSION_ID,
    extension_version: "1.0.0-test",
    browser_session_id: browserSessionId,
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
