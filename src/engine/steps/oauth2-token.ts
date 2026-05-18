/**
 * @owner       src::engine::steps::oauth2-token
 * @does        Pipeline step that resolves an OAuth2 client_credentials bearer token from env or auth file and exposes it under `ctx.auth.bearer` for downstream `fetch` steps to inject as `Authorization: Bearer …`.
 * @needs       src/engine/auth/oauth2-cc.ts, src/engine/step-registry.ts, src/engine/executor.ts
 * @feeds       src/engine/steps/index.ts (barrel), adapter YAML pipelines (`- oauth2-token: {...}`)
 * @breaks      throws PipelineError on missing credentials, token-endpoint failure, or upstream 4xx; never falls back silently (rule 02)
 * @invariants  step never logs the access_token; auth source resolution is env-first, file-fallback (rule 04 of CLAUDE.md auth pattern)
 * @side-effects reads process.env, optionally reads ~/.unicli/auth/<site>.json, network egress to token endpoint
 * @perf        amortized O(1) when oauth2-cc cache is warm
 * @concurrency safe; cache deduplication handled by oauth2-cc module
 * @test        tests/unit/engine/steps/oauth2-token.test.ts
 * @stability   stable
 * @since       2026-05-18
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { registerStep, type StepHandler } from "../step-registry.js";
import { PipelineError, type PipelineContext } from "../executor.js";
import {
  obtainClientCredentialsToken,
  Oauth2Error,
} from "../auth/oauth2-cc.js";

export interface Oauth2TokenStepConfig {
  /** Token endpoint URL (template-evaluated). */
  token_url: string;
  /**
   * Env var holding the client id. If absent the auth file is consulted under
   * `client_id`.
   */
  client_id_env: string;
  /** Env var holding the client secret. Same fallback rules as client_id_env. */
  client_secret_env: string;
  /** Optional OAuth2 scope. */
  scope?: string;
  /**
   * Adapter site name used to locate `~/.unicli/auth/<site>.json` when env
   * vars are missing.
   */
  site: string;
  /**
   * Where to put the resolved bearer token in the pipeline context. Default
   * `auth.bearer`. Downstream fetch step interpolates `${{ auth.bearer }}` in
   * its `headers.Authorization`.
   */
  destination?: string;
}

interface AuthFileShape {
  client_id?: unknown;
  client_secret?: unknown;
}

async function readAuthFile(
  site: string,
): Promise<{ client_id: string; client_secret: string } | undefined> {
  const path = join(homedir(), ".unicli", "auth", `${site}.json`);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as AuthFileShape;
    if (
      typeof parsed.client_id === "string" &&
      typeof parsed.client_secret === "string"
    ) {
      return {
        client_id: parsed.client_id,
        client_secret: parsed.client_secret,
      };
    }
    return undefined;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw err;
  }
}

function setByPath(
  bag: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const segments = path.split(".").filter((s) => s.length > 0);
  if (segments.length === 0) return bag;
  const next: Record<string, unknown> = { ...bag };
  let cursor: Record<string, unknown> = next;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i];
    const existing = cursor[key];
    const child =
      existing && typeof existing === "object" && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>) }
        : {};
    cursor[key] = child;
    cursor = child;
  }
  cursor[segments[segments.length - 1]] = value;
  return next;
}

export const stepOauth2Token: StepHandler<Oauth2TokenStepConfig> = async (
  ctx: PipelineContext,
  config: Oauth2TokenStepConfig,
  stepIndex?: number,
): Promise<PipelineContext> => {
  const fail = (suggestion: string, message: string): never => {
    throw new PipelineError(message, {
      step: stepIndex ?? 0,
      action: "oauth2-token",
      config,
      errorType: "permission_denied",
      suggestion,
      url: config.token_url,
    });
  };

  let client_id = process.env[config.client_id_env];
  let client_secret = process.env[config.client_secret_env];

  if (!client_id || !client_secret) {
    const fileCreds = await readAuthFile(config.site);
    if (fileCreds) {
      client_id = client_id || fileCreds.client_id;
      client_secret = client_secret || fileCreds.client_secret;
    }
  }

  if (!client_id || !client_secret) {
    fail(
      `Set env vars ${config.client_id_env} and ${config.client_secret_env}, or save credentials to ~/.unicli/auth/${config.site}.json with {"client_id":"…","client_secret":"…"}.`,
      `oauth2-token: missing credentials for site "${config.site}"`,
    );
    return ctx; // unreachable — fail() throws
  }

  let lease;
  try {
    lease = await obtainClientCredentialsToken({
      token_url: config.token_url,
      client_id,
      client_secret,
      scope: config.scope,
    });
  } catch (err) {
    if (err instanceof Oauth2Error) {
      throw new PipelineError(err.message, {
        step: stepIndex ?? 0,
        action: "oauth2-token",
        config,
        errorType: "http_error",
        url: err.token_url,
        statusCode: err.status,
        suggestion:
          err.status === 401 || err.status === 403
            ? `Verify ${config.client_id_env} / ${config.client_secret_env} are current; rotate the upstream credential if the issuer rejected the pair.`
            : "Retry after a short backoff; the OAuth2 issuer reported a transient failure.",
        retryable: err.status >= 500,
      });
    }
    throw err;
  }

  const destination = config.destination ?? "auth.bearer";
  const vars = setByPath(ctx.vars, destination, lease.access_token);
  return { ...ctx, vars };
};

registerStep("oauth2-token", stepOauth2Token);
