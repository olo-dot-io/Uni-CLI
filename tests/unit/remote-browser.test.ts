import { describe, expect, it } from "vitest";

import {
  RemoteBrowserError,
  RemoteBrowserProvider,
  readRemoteEndpoint,
} from "../../src/browser/remote-browser.js";

describe("remote browser configuration", () => {
  it("validates endpoint and header types instead of silently dropping malformed auth", () => {
    expect(
      readRemoteEndpoint({
        UNICLI_CDP_ENDPOINT: "wss://user:secret@example.com/session/token",
        UNICLI_CDP_HEADERS: JSON.stringify({ Authorization: "Bearer secret" }),
      }),
    ).toEqual({
      endpoint: "wss://user:secret@example.com/session/token",
      headers: { Authorization: "Bearer secret" },
    });
    expect(() =>
      readRemoteEndpoint({
        UNICLI_CDP_ENDPOINT: "https://example.com/cdp",
      }),
    ).toThrowError(RemoteBrowserError);
    expect(() =>
      readRemoteEndpoint({
        UNICLI_CDP_ENDPOINT: "wss://example.com/cdp",
        UNICLI_CDP_HEADERS: JSON.stringify({ Authorization: 42 }),
      }),
    ).toThrowError(/values must all be strings/);
  });

  it("reports only endpoint origin and refuses when remote is not configured", async () => {
    const configured = new RemoteBrowserProvider({
      endpoint: {
        endpoint: "wss://user:secret@example.com/private/token",
        headers: { Authorization: "Bearer secret" },
      },
    });
    expect(configured.status()).toEqual({
      configured: true,
      endpoint_origin: "wss://example.com",
      target_count: 0,
      visibility: "hidden",
    });

    const absent = new RemoteBrowserProvider({ endpoint: null });
    await expect(absent.acquireTarget()).rejects.toMatchObject({
      code: "remote_browser_unavailable",
      retryable: false,
    });
  });

  it("quarantines malformed optional configuration until remote is requested", async () => {
    const provider = new RemoteBrowserProvider({
      env: { UNICLI_CDP_ENDPOINT: "https://example.com/not-a-websocket" },
    });

    expect(provider.status()).toEqual({
      configured: false,
      configuration_error: "UNICLI_CDP_ENDPOINT must use ws:// or wss://",
      target_count: 0,
      visibility: "hidden",
    });
    await expect(provider.acquireTarget()).rejects.toMatchObject({
      code: "remote_browser_configuration_invalid",
      retryable: false,
    });
  });
});
