/**
 * Extract cookies from a running Chrome instance via CDP.
 * No extension. No cookie files. No manual export.
 *
 * Usage:
 *   const cookies = await extractCookiesViaCDP("bilibili.com");
 *   // -> { SESSDATA: "abc", bili_jct: "def", ... }
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

interface CDPCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
}

/**
 * Extract cookies for a domain from a running Chrome instance.
 * Connects to Chrome's CDP debug port, calls Network.getCookies,
 * and returns cookies as a flat key-value record.
 */
export async function extractCookiesViaCDP(
  domain: string,
  port?: number,
): Promise<Record<string, string>> {
  const { CDPClient } = await import("../browser/cdp-client.js");
  const rawPort = process.env.UNICLI_CDP_PORT;
  let cdpPort = port ?? 9222;
  if (!port && rawPort) {
    const p = parseInt(rawPort, 10);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      throw new Error(`Invalid UNICLI_CDP_PORT: "${rawPort}"`);
    }
    cdpPort = p;
  }
  const client = await CDPClient.connectToChrome(cdpPort);

  try {
    const { cookies } = (await client.send("Network.getCookies", {
      urls: [
        `https://${domain}`,
        `https://www.${domain}`,
        `http://${domain}`,
        `http://www.${domain}`,
      ],
    })) as { cookies: CDPCookie[] };

    const result: Record<string, string> = {};
    for (const c of cookies) {
      result[c.name] = c.value;
    }
    return result;
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Save extracted cookies to disk for offline use.
 * Writes to ~/.unicli/cookies/<site>.json
 */
export function saveCookies(
  site: string,
  cookies: Record<string, string>,
): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(site)) {
    throw new Error(
      `Invalid site name: "${site}" — only alphanumeric, dot, dash, underscore allowed`,
    );
  }
  const dir =
    process.env.UNICLI_COOKIE_DIR ??
    join(process.env.HOME ?? "~", ".unicli", "cookies");
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${site}.json`);
  writeFileSync(filePath, JSON.stringify(cookies, null, 2), "utf-8");
  return filePath;
}
