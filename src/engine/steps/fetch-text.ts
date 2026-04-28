import { USER_AGENT } from "../../constants.js";
import { registerStep, type StepHandler } from "../step-registry.js";
import { type PipelineContext, PipelineError } from "../executor.js";
import { assertSafeRequestUrl } from "../ssrf.js";
import { evalTemplate } from "../template.js";
import { getProxyAgent } from "../proxy.js";
import { normalizeFetchAttempts, type FetchConfig } from "./fetch.js";

export async function stepFetchText(
  ctx: PipelineContext,
  config: FetchConfig,
): Promise<PipelineContext> {
  let url = evalTemplate(config.url, ctx);
  assertSafeRequestUrl(url);

  if (config.params) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(config.params)) {
      params.set(k, evalTemplate(String(v), ctx));
    }
    url += (url.includes("?") ? "&" : "?") + params.toString();
  }

  const method = config.method ?? "GET";
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    ...config.headers,
  };

  if (ctx.cookieHeader) {
    headers["Cookie"] = ctx.cookieHeader;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dispatcher from undici not in standard RequestInit
  const fetchInit: Record<string, any> = { method, headers };
  const ftAgent = getProxyAgent();
  if (ftAgent) fetchInit.dispatcher = ftAgent;

  const maxAttempts = normalizeFetchAttempts(config.retry);
  const baseDelay = config.backoff ?? 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const resp = await fetch(url, fetchInit as RequestInit);
      if (resp.ok) {
        const text = await resp.text();
        return { ...ctx, data: text };
      }

      const retryable =
        resp.status === 429 ||
        resp.status === 500 ||
        resp.status === 502 ||
        resp.status === 503;
      const isLastAttempt = attempt === maxAttempts;
      if (retryable && !isLastAttempt) {
        await new Promise((r) => setTimeout(r, baseDelay * 2 ** (attempt - 1)));
        continue;
      }

      throw new PipelineError(
        `HTTP ${resp.status} ${resp.statusText} from ${url}`,
        {
          step: -1,
          action: "fetch_text",
          config: { url, method },
          errorType: "http_error",
          url,
          statusCode: resp.status,
          suggestion: `Check if the URL is still valid: ${url}`,
          retryable,
          alternatives:
            resp.status === 401 || resp.status === 403
              ? ["unicli auth setup <site>"]
              : [],
        },
      );
    } catch (err) {
      const isLastAttempt = attempt === maxAttempts;
      if (err instanceof PipelineError) {
        throw err;
      }
      if (isLastAttempt) {
        const message = err instanceof Error ? err.message : String(err);
        throw new PipelineError(`fetch_text failed for ${url}: ${message}`, {
          step: -1,
          action: "fetch_text",
          config: { url, method },
          errorType: "network_error",
          url,
          suggestion: `Network fetch failed. Retry or check connectivity to: ${url}`,
          retryable: true,
          alternatives: [],
        });
      }
      await new Promise((r) => setTimeout(r, baseDelay * 2 ** (attempt - 1)));
    }
  }

  throw new Error("fetch_text: unreachable");
}

registerStep("fetch_text", stepFetchText as StepHandler);
