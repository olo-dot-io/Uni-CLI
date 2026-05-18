import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  Oauth2Error,
  describeOauth2Cache,
  obtainClientCredentialsToken,
  resetOauth2Cache,
} from "../../../../src/engine/auth/oauth2-cc.js";

const TOKEN_URL = "https://ops.example.test/3.2/auth/accesstoken";
const BASE_CONFIG = {
  token_url: TOKEN_URL,
  client_id: "test-client",
  client_secret: "test-secret",
};

describe("obtainClientCredentialsToken", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetOauth2Cache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetOauth2Cache();
  });

  it("issues a Bearer token via Basic-auth client_credentials grant", async () => {
    const fetchSpy = vi.fn(async (url, init) => {
      expect(url).toBe(TOKEN_URL);
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toMatch(/^Basic [A-Za-z0-9+/=]+$/);
      const decoded = Buffer.from(
        headers.get("authorization")!.slice("Basic ".length),
        "base64",
      ).toString("utf8");
      expect(decoded).toBe("test-client:test-secret");
      expect(init?.body).toContain("grant_type=client_credentials");
      return new Response(
        JSON.stringify({
          access_token: "abc.def.ghi",
          token_type: "Bearer",
          expires_in: 600,
          scope: "read",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const before = Date.now();
    const lease = await obtainClientCredentialsToken(BASE_CONFIG);
    expect(lease.access_token).toBe("abc.def.ghi");
    expect(lease.token_type).toBe("Bearer");
    expect(lease.scope).toBe("read");
    expect(lease.expires_at_ms).toBeGreaterThan(before);
    // 600s expires_in minus default 60s buffer ~ 540s ahead.
    expect(lease.expires_at_ms - before).toBeGreaterThanOrEqual(
      540_000 - 1_000,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns the cached lease on a second call before expiry", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "first-token",
            token_type: "Bearer",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const lease1 = await obtainClientCredentialsToken(BASE_CONFIG);
    const lease2 = await obtainClientCredentialsToken(BASE_CONFIG);
    expect(lease1).toBe(lease2);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent refresh requests for the same key", async () => {
    let resolve!: (value: Response) => void;
    const pending = new Promise<Response>((r) => (resolve = r));
    const fetchSpy = vi.fn(async () => pending);
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const p1 = obtainClientCredentialsToken(BASE_CONFIG);
    const p2 = obtainClientCredentialsToken(BASE_CONFIG);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    resolve(
      new Response(
        JSON.stringify({
          access_token: "shared",
          token_type: "Bearer",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe(b);
    expect(a.access_token).toBe("shared");
  });

  it("throws Oauth2Error on a 401 from the token endpoint", async () => {
    const fetchSpy = vi.fn(
      async () => new Response("invalid_client", { status: 401 }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(
      obtainClientCredentialsToken(BASE_CONFIG),
    ).rejects.toBeInstanceOf(Oauth2Error);
  });

  it("includes the response body in the Oauth2Error message", async () => {
    globalThis.fetch = (async () =>
      new Response("upstream is down", {
        status: 503,
      })) as unknown as typeof fetch;
    try {
      await obtainClientCredentialsToken(BASE_CONFIG);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Oauth2Error);
      expect((err as Oauth2Error).status).toBe(503);
      expect((err as Oauth2Error).message).toContain("upstream is down");
    }
  });

  it("describeOauth2Cache redacts the client_id but keeps the token_url", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          access_token: "secret",
          token_type: "Bearer",
          expires_in: 1800,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    await obtainClientCredentialsToken(BASE_CONFIG);
    const snapshot = describeOauth2Cache();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].token_url).toBe(TOKEN_URL);
    expect(snapshot[0].client_id_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot[0].client_id_hash).not.toContain("test-client");
    expect(snapshot[0].expires_at_ms).toBeGreaterThan(Date.now());
  });
});
