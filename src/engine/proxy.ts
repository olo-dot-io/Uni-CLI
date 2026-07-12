/**
 * @owner       src::engine::proxy
 * @does        Routes Node HTTP(S) fetches through environment proxies without crossing Undici dispatcher versions.
 * @needs       undici fetch and EnvHttpProxyAgent, process environment
 * @feeds       CLI/MCP global fetch, pipeline fetch/fetch_text, core extract
 * @breaks      Invalid proxy URLs and proxy connection failures propagate from Undici fetch.
 * @invariants  A proxied request's fetch and dispatcher come from the same Undici package; loopback always bypasses proxies.
 * @side-effects Owns cached proxy connection pools and may replace globalThis.fetch when installed.
 * @perf        O(1) environment resolution; one cached dispatcher per distinct proxy configuration.
 * @concurrency Process-wide installation is idempotent; dispatcher cache is shared by async callers.
 * @test        tests/unit/proxy.test.ts
 * @stability   stable
 * @since       2026-04-06
 */

import {
  EnvHttpProxyAgent,
  fetch as undiciFetch,
  type Dispatcher,
} from "undici";

const LOOPBACK_NO_PROXY = ["127.0.0.1", "localhost", "::1"] as const;
const nativeFetch = globalThis.fetch.bind(globalThis);
const dispatchers = new Map<string, Dispatcher>();
let isInstalled = false;

export interface ProxyConfig {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy: string;
}

type FetchInput = Parameters<typeof globalThis.fetch>[0];

function firstEnv(
  env: NodeJS.ProcessEnv,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = env[key]?.trim();
    if (candidate) return candidate;
  }
  return undefined;
}

export function resolveProxyConfig(
  env: NodeJS.ProcessEnv = process.env,
): ProxyConfig {
  const allProxy = firstEnv(env, ["all_proxy", "ALL_PROXY"]);
  const httpProxy = firstEnv(env, ["http_proxy", "HTTP_PROXY"]) ?? allProxy;
  const httpsProxy =
    firstEnv(env, ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"]) ??
    allProxy;
  const configuredNoProxy = firstEnv(env, ["no_proxy", "NO_PROXY"]);
  const noProxy = [configuredNoProxy, ...LOOPBACK_NO_PROXY]
    .filter((entry): entry is string => Boolean(entry))
    .join(",");
  return { httpProxy, httpsProxy, noProxy };
}

export function hasProxyConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  const config = resolveProxyConfig(env);
  return Boolean(config.httpProxy || config.httpsProxy);
}

function getProxyAgent(
  env: NodeJS.ProcessEnv = process.env,
): Dispatcher | undefined {
  const config = resolveProxyConfig(env);
  if (!config.httpProxy && !config.httpsProxy) return undefined;

  const key = JSON.stringify(config);
  const cached = dispatchers.get(key);
  if (cached) return cached;

  const dispatcher = new EnvHttpProxyAgent(config);
  dispatchers.set(key, dispatcher);
  return dispatcher;
}

export async function fetchWithProxy(
  input: FetchInput,
  init: RequestInit = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<Response> {
  const dispatcher = getProxyAgent(env);
  if (!dispatcher) return nativeFetch(input, init);

  return (await undiciFetch(
    input as Parameters<typeof undiciFetch>[0],
    {
      ...init,
      dispatcher,
    } as Parameters<typeof undiciFetch>[1],
  )) as unknown as Response;
}

export function installProxyAwareFetch(): void {
  if (isInstalled) return;
  globalThis.fetch = ((input: FetchInput, init?: RequestInit) =>
    fetchWithProxy(input, init)) as typeof globalThis.fetch;
  isInstalled = true;
}

export function describeNetworkFailure(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();

  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      const code = (current as Error & { code?: unknown }).code;
      messages.push(
        typeof code === "string"
          ? `${current.message} (${code})`
          : current.message,
      );
      current = (current as Error & { cause?: unknown }).cause;
      continue;
    }
    messages.push(String(current));
    break;
  }

  return [...new Set(messages.filter(Boolean))].join(": ");
}
