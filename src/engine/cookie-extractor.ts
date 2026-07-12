/**
 * @owner       src::engine::cookie-extractor
 * @does        Extracts domain-scoped cookies from a running Chromium CDP session into process memory.
 * @needs       browser CDP client and a validated domain/port
 * @feeds       cookie acquisition and explicit browser cookie export commands
 * @breaks      CDP connection, protocol, cookie-read, and connection-close failures propagate to the caller.
 * @invariants  This module never persists cookies; the caller chooses whether to use memory or explicit storage.
 * @side-effects Opens and closes one CDP connection; cookie values exist in memory for the call lifetime.
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
  const { CDPClient, resolveCdpPort } =
    await import("../browser/cdp-client.js");
  const cdpPort = resolveCdpPort(port);
  const client = await CDPClient.connectToChrome(cdpPort);

  let result: Record<string, string> | undefined;
  let operationError: unknown;
  try {
    const { cookies } = (await client.send("Network.getCookies", {
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
