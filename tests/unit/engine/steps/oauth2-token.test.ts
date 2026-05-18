import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { stepOauth2Token } from "../../../../src/engine/steps/oauth2-token.js";
import { PipelineError } from "../../../../src/engine/executor.js";
import { resetOauth2Cache } from "../../../../src/engine/auth/oauth2-cc.js";

const BASE_CONFIG = {
  token_url: "https://ops.example.test/auth",
  client_id_env: "TEST_OAUTH_CLIENT_ID",
  client_secret_env: "TEST_OAUTH_CLIENT_SECRET",
  site: "test-site-no-file",
};

const EMPTY_CTX = {
  data: undefined,
  args: {},
  vars: {},
};

describe("oauth2-token step", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    originalEnv[BASE_CONFIG.client_id_env] =
      process.env[BASE_CONFIG.client_id_env];
    originalEnv[BASE_CONFIG.client_secret_env] =
      process.env[BASE_CONFIG.client_secret_env];
    delete process.env[BASE_CONFIG.client_id_env];
    delete process.env[BASE_CONFIG.client_secret_env];
    resetOauth2Cache();
    // Force the auth-file fallback to ENOENT by pointing HOME at /dev/null.
    originalEnv.HOME = process.env.HOME;
    process.env.HOME = "/nonexistent-home-for-oauth2-test";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetOauth2Cache();
  });

  it("resolves credentials from env and writes bearer to ctx.vars.auth.bearer", async () => {
    process.env[BASE_CONFIG.client_id_env] = "env-client";
    process.env[BASE_CONFIG.client_secret_env] = "env-secret";

    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "env-token",
            token_type: "Bearer",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const next = await stepOauth2Token(EMPTY_CTX, BASE_CONFIG);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((next.vars.auth as { bearer: string }).bearer).toBe("env-token");
    // Original ctx must not be mutated in place.
    expect(EMPTY_CTX.vars).toEqual({});
  });

  it("honors a custom destination path", async () => {
    process.env[BASE_CONFIG.client_id_env] = "env-client";
    process.env[BASE_CONFIG.client_secret_env] = "env-secret";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          access_token: "custom",
          token_type: "Bearer",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const next = await stepOauth2Token(EMPTY_CTX, {
      ...BASE_CONFIG,
      destination: "auth.epo.bearer",
    });
    const auth = next.vars.auth as { epo: { bearer: string } };
    expect(auth.epo.bearer).toBe("custom");
  });

  it("throws PipelineError when neither env nor auth file has credentials", async () => {
    await expect(
      stepOauth2Token(EMPTY_CTX, BASE_CONFIG),
    ).rejects.toBeInstanceOf(PipelineError);
    try {
      await stepOauth2Token(EMPTY_CTX, BASE_CONFIG);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineError);
      const pe = err as PipelineError;
      expect(pe.detail.action).toBe("oauth2-token");
      expect(pe.detail.suggestion).toContain(BASE_CONFIG.client_id_env);
      expect(pe.detail.suggestion).toContain(BASE_CONFIG.site);
    }
  });

  it("re-wraps Oauth2Error from a 401 into a PipelineError with http_error", async () => {
    process.env[BASE_CONFIG.client_id_env] = "env-client";
    process.env[BASE_CONFIG.client_secret_env] = "env-secret";
    globalThis.fetch = (async () =>
      new Response("bad client", { status: 401 })) as unknown as typeof fetch;

    try {
      await stepOauth2Token(EMPTY_CTX, BASE_CONFIG);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineError);
      const pe = err as PipelineError;
      expect(pe.detail.errorType).toBe("http_error");
      expect(pe.detail.statusCode).toBe(401);
      expect(pe.detail.retryable).toBe(false);
    }
  });
});
