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
): Promise<Record<string, string>> {
  if (port === undefined) return extractCookiesViaBroker(domain);
  const { CDPClient, resolveCdpPort } =
    await import("../browser/cdp-client.js");
  const cdpPort = resolveCdpPort(port);
  const client = await CDPClient.connectToChrome(cdpPort);

  return extractCookiesWithClient(domain, {
    sendCDP: (method, params) => client.send(method, params),
    close: () => client.close(),
  });
}

async function extractCookiesViaBroker(
  domain: string,
): Promise<Record<string, string>> {
  const { BrowserBridge } = await import("../browser/bridge.js");
  const page = await new BrowserBridge().connect();
  return extractCookiesWithClient(domain, page);
}

interface CookieCommandClient {
  sendCDP(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

async function extractCookiesWithClient(
  domain: string,
  client: CookieCommandClient,
): Promise<Record<string, string>> {
  let result: Record<string, string> | undefined;
  let operationError: unknown;
  try {
    const { cookies } = (await client.sendCDP("Network.getCookies", {
      urls: [
        `https://${domain}`,
        `https://www.${domain}`,
        `http://${domain}`,
        `http://www.${domain}`,
      ],
    })) as { cookies: CDPCookie[] };

    result = {};
    for (const cookie of cookies) result[cookie.name] = cookie.value;
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
