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
});
