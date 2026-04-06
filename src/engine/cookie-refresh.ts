/**
 * Smart Cookie Refresh — automatically refresh expired cookies via CDP.
 *
 * When an adapter gets a 401/403, this module attempts to navigate Chrome
 * to the site's main page (refreshing the session), extract fresh cookies
 * via CDP, and write them to the cookie file for subsequent requests.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { BrowserPage } from "../browser/page.js";

/**
 * Attempt to refresh cookies for a site by navigating Chrome to it.
 * Returns true if cookies were refreshed, false if not possible.
 */
export async function refreshCookies(
  site: string,
  domain?: string,
): Promise<boolean> {
  try {
    const { BrowserPage: BP } = await import("../browser/page.js");

    // Try connecting to an existing Chrome instance
    let port = 9222;
    const rawPort = process.env.UNICLI_CDP_PORT;
    if (rawPort) {
      const p = parseInt(rawPort, 10);
      if (Number.isInteger(p) && p >= 1 && p <= 65535) {
        port = p;
      }
    }

    let page: BrowserPage | undefined;
    try {
      page = await BP.connect(port);
    } catch {
      // No Chrome CDP available — cannot refresh
      return false;
    }

    try {
      // Navigate to the site's main page to refresh session
      const targetUrl = domain
        ? `https://${domain}`
        : `https://www.${site}.com`;

      await page.goto(targetUrl, { settleMs: 3000 });

      // Extract cookies
      const cookies = await page.cookies();
      if (Object.keys(cookies).length === 0) {
        return false;
      }

      // Write cookies to file
      const cookiesDir = join(homedir(), ".unicli", "cookies");
      mkdirSync(cookiesDir, { recursive: true });

      const cookieArray = Object.entries(cookies).map(([name, value]) => ({
        name,
        value,
        domain: domain ?? `${site}.com`,
      }));

      const cookiePath = join(cookiesDir, `${site}.json`);
      writeFileSync(cookiePath, JSON.stringify(cookieArray, null, 2), "utf-8");

      return true;
    } finally {
      try {
        await page.close();
      } catch {
        /* best effort */
      }
    }
  } catch {
    return false;
  }
}
