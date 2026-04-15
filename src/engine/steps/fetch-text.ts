import { USER_AGENT } from "../../constants.js";
import { registerStep, type StepHandler } from "../step-registry.js";
import { type PipelineContext, PipelineError } from "../executor.js";
import { assertSafeRequestUrl } from "../ssrf.js";
import { evalTemplate } from "../template.js";
import { getProxyAgent } from "../proxy.js";
import type { FetchConfig } from "./fetch.js";

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

  const resp = await fetch(url, fetchInit as RequestInit);
  if (!resp.ok) {
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
        retryable:
          resp.status === 429 ||
          resp.status === 500 ||
          resp.status === 502 ||
          resp.status === 503,
        alternatives:
          resp.status === 401 || resp.status === 403
            ? ["unicli auth setup <site>"]
            : [],
      },
    );
  }

  const text = await resp.text();
  return { ...ctx, data: text };
}

registerStep("fetch_text", stepFetchText as StepHandler);
