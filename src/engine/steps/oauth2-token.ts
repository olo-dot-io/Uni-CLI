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

import { registerStep, type StepHandler } from "../step-registry.js";
import type { PipelineContext } from "../executor.js";

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

export const stepOauth2Token: StepHandler<Oauth2TokenStepConfig> = async (
  _ctx: PipelineContext,
  _config: Oauth2TokenStepConfig,
): Promise<PipelineContext> => {
  throw new Error(
    "oauth2-token step: not yet implemented (M0 stub — wave-1-subagent-A will fill body using engine/auth/oauth2-cc.ts)",
  );
};

registerStep("oauth2-token", stepOauth2Token);
