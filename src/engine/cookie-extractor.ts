/**
 * @owner       src::engine::cookie-extractor
 * @does        Extracts domain-scoped cookies through a broker-owned hidden target by default or an explicitly requested CDP port.
 * @needs       browser bridge, browser CDP client, ambient invocation scope, and a validated domain/optional explicit port
 * @feeds       cookie acquisition and explicit browser cookie export commands
 * @breaks      CDP connection, protocol, cookie-read, and connection-close failures propagate to the caller.
 * @invariants  An omitted port never discovers, creates, or controls a direct Chrome CDP tab; this module never persists cookies; the caller chooses whether to use memory or explicit storage.
 * @side-effects Acquires/releases one broker target or opens/closes one explicitly requested CDP connection; cookie values exist in memory for the call lifetime.
 * @perf        One Network.getCookies request.
 * @concurrency Each extraction owns its CDP client.
 * @test        tests/unit/cookie-extractor.test.ts
 * @stability   stable
 * @since       2026-04-05
 */

import { cookieValuesForUrl } from "./cookie-scope.js";
import { currentBrowserInvocationScope } from "../browser/invocation-scope.js";

interface CDPCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
}

export async function extractCookiesViaCDP(
  domain: string,
  port?: number,
  url?: string,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  signal?.throwIfAborted();
  if (port === undefined) return extractCookiesViaBroker(domain, url, signal);
  const { CDPClient, resolveCdpPort } =
    await import("../browser/cdp-client.js");
  const cdpPort = resolveCdpPort(port);
  const client = await CDPClient.connectToChrome(cdpPort);

  return extractCookiesWithClient(
    domain,
    {
      sendCDP: (method, params, sessionId, requestSignal) =>
        client.send(method, params, sessionId, requestSignal),
      close: () => client.close(),
    },
    url,
    signal,
  );
}

async function extractCookiesViaBroker(
  domain: string,
  url?: string,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  const { BrowserBridge } = await import("../browser/bridge.js");
  signal?.throwIfAborted();
  const page = await new BrowserBridge().connect(
    process.platform === "win32" && !currentBrowserInvocationScope()
      ? { provider: "chrome", visibility: "background" }
      : undefined,
  );
  return extractCookiesWithClient(domain, page, url, signal);
}

interface CookieCommandClient {
  sendCDP(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
  close(): Promise<void>;
}

async function extractCookiesWithClient(
  domain: string,
  client: CookieCommandClient,
  url?: string,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  let result: Record<string, string> | undefined;
  let operationError: unknown;
  try {
    signal?.throwIfAborted();
    const { cookies } = (await client.sendCDP(
      "Network.getCookies",
      {
        urls: url
          ? [url]
          : [
              `https://${domain}`,
              `https://www.${domain}`,
              `http://${domain}`,
              `http://www.${domain}`,
            ],
      },
      undefined,
      signal,
    )) as { cookies: CDPCookie[] };
    signal?.throwIfAborted();

    result = cookieValuesForUrl(cookies, url ?? `https://${domain}/`);
  } catch (error) {
    operationError = error;
  }

  let closeError: unknown;
  try {
    await client.close();
  } catch (error) {
    closeError = error;
  }

  if (operationError !== undefined && closeError !== undefined) {
    throw new AggregateError(
      [operationError, closeError],
      "Cookie extraction and CDP cleanup both failed",
    );
  }
  if (operationError !== undefined) throw operationError;
  if (closeError !== undefined) throw closeError;
  return result ?? {};
}
