/**
 * @owner   src/adapters/uisdc/news.ts
 * @does    Register agent-facing UISDC news browser extraction command.
 * @needs   Public UISDC news page, browser runtime, selector-drift error reporting.
 * @feeds   surface coverage ledger, design/AI news discovery, Chinese design news surface.
 * @breaks  UISDC DOM drift or silent empty extraction hides news coverage failures.
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";

const UISDC_NEWS_URL = "https://www.uisdc.com/news";

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export function requireNewsLimit(value: unknown, fallback = 20): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    throw new Error("limit must be an integer in [1, 50].");
  }
  return n;
}

export function buildExtractUisdcNewsJs(): string {
  return `
    (() => {
      const cards = Array.from(document.querySelectorAll(
        '.news-list > .news-item:first-child > .item-content > .dubao-items > .dubao-item'
      ));
      if (cards.length === 0) {
        return {
          ok: false,
          reason: 'selector-missing',
          title: document.title || '',
          bodyText: (document.body?.innerText || document.body?.textContent || '').slice(0, 500),
        };
      }
      const rows = cards.map((el) => {
        const anchor = el.querySelector('a[href]');
        return {
          title: el.querySelector('.dubao-title')?.textContent || '',
          summary: el.querySelector('.dubao-content')?.textContent || '',
          url: anchor ? new URL(anchor.getAttribute('href'), location.href).href : '',
        };
      });
      return { ok: true, rows };
    })()
  `;
}

interface BrowserExtractPayload {
  ok?: unknown;
  reason?: unknown;
  title?: unknown;
  rows?: Array<{ title?: unknown; summary?: unknown; url?: unknown }>;
}

export function mapUisdcNewsPayload(
  payload: BrowserExtractPayload,
  limit: number,
): Array<Record<string, unknown>> {
  if (!payload || typeof payload !== "object") {
    throw new Error("UISDC news page returned an unreadable payload.");
  }
  if (payload.ok !== true) {
    const reason = normalizeText(payload.reason) || "selector-drift";
    const title = normalizeText(payload.title);
    throw new Error(
      `UISDC news selector drift: ${reason}${title ? ` (${title})` : ""}`,
    );
  }
  const rows = (Array.isArray(payload.rows) ? payload.rows : [])
    .map((row, index) => ({
      rank: index + 1,
      title: normalizeText(row.title),
      summary: normalizeText(row.summary),
      url: normalizeText(row.url),
    }))
    .filter((row) => row.title && row.url);
  if (rows.length === 0) {
    throw new Error("UISDC news page loaded, but no news rows were extracted.");
  }
  return rows
    .slice(0, limit)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

cli({
  site: "uisdc",
  name: "news",
  description: "UISDC latest AI and design news",
  domain: "www.uisdc.com",
  strategy: Strategy.PUBLIC,
  browser: true,
  args: [{ name: "limit", type: "int", default: 20, description: "Max rows" }],
  columns: ["rank", "title", "summary", "url"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const limit = requireNewsLimit(kwargs.limit);
    await p.goto(UISDC_NEWS_URL, { waitUntil: "load", settleMs: 3000 });
    const payload = (await p.evaluate(
      buildExtractUisdcNewsJs(),
    )) as BrowserExtractPayload;
    return mapUisdcNewsPayload(payload, limit);
  },
});
