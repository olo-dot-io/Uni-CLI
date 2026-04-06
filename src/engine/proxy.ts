/**
 * HTTP proxy support via undici EnvHttpProxyAgent.
 * Respects http_proxy, https_proxy, HTTP_PROXY, HTTPS_PROXY, no_proxy, NO_PROXY.
 */

import { EnvHttpProxyAgent } from "undici";

let _agent: EnvHttpProxyAgent | undefined;

/**
 * Get a shared EnvHttpProxyAgent that respects proxy environment variables.
 * Returns undefined if no proxy env vars are set (use default fetch behavior).
 */
export function getProxyAgent(): EnvHttpProxyAgent | undefined {
  const proxyUrl =
    process.env.http_proxy ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.HTTPS_PROXY;
  if (!proxyUrl) return undefined;

  if (!_agent) {
    _agent = new EnvHttpProxyAgent();
  }
  return _agent;
}

/**
 * Check if proxy environment is configured.
 */
export function hasProxyConfig(): boolean {
  return !!(
    process.env.http_proxy ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.HTTPS_PROXY
  );
}
