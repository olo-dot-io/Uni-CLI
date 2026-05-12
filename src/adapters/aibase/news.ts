/**
 * @owner   src/adapters/aibase/news.ts
 * @does    Register agent-facing AIbase daily-news browser extraction command.
 * @needs   Public AIbase daily page, browser runtime, selector-drift error reporting.
 * @feeds   surface coverage ledger, AI news discovery, Chinese AI daily brief surface.
 * @breaks  AIbase DOM drift or silent empty extraction hides news coverage failures.
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";

const AIBASE_DAILY_URL = "https://www.aibase.com/zh/daily";

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

export function buildExtractAibaseNewsJs(): string {
  return `
    (() => {
      const anchors = Array.from(document.querySelectorAll('.bg-white .grid a[href], a[href*="/zh/daily/"]'))
        .filter((anchor) => {
          const href = anchor.getAttribute('href') || '';
          const text = (anchor.innerText || anchor.textContent || '').trim();
          return text && href && !href.endsWith('/zh/daily') && !href.endsWith('/zh/daily/');
        });
      if (anchors.length === 0) {
        return {
          ok: false,
          reason: 'selector-missing',
          title: document.title || '',
          bodyText: (document.body?.innerText || document.body?.textContent || '').slice(0, 500),
        };
      }
      const seen = new Set();
      const rows = [];
      for (const anchor of anchors) {
        const url = new URL(anchor.getAttribute('href'), location.href).href;
        if (seen.has(url)) continue;
        seen.add(url);
        rows.push({
          title: anchor.innerText || anchor.textContent || '',
          url,
        });
      }
      return { ok: true, rows };
    })()
  `;
}

interface BrowserExtractPayload {
  ok?: unknown;
  reason?: unknown;
  title?: unknown;
  rows?: Array<{ title?: unknown; url?: unknown }>;
}

export function mapAibaseNewsPayload(
  payload: BrowserExtractPayload,
  limit: number,
): Array<Record<string, unknown>> {
  if (!payload || typeof payload !== "object") {
    throw new Error("AIbase daily page returned an unreadable payload.");
  }
  if (payload.ok !== true) {
    const reason = normalizeText(payload.reason) || "selector-drift";
    const title = normalizeText(payload.title);
    throw new Error(
      `AIbase daily selector drift: ${reason}${title ? ` (${title})` : ""}`,
    );
  }
  const rows = (Array.isArray(payload.rows) ? payload.rows : [])
    .map((row, index) => ({
      rank: index + 1,
      title: normalizeText(row.title),
      url: normalizeText(row.url),
    }))
    .filter((row) => row.title && row.url);
  if (rows.length === 0) {
    throw new Error(
      "AIbase daily page loaded, but no article rows were extracted.",
    );
  }
  return rows
    .slice(0, limit)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

cli({
  site: "aibase",
  name: "news",
  description: "AIbase daily AI industry news",
  domain: "www.aibase.com",
  strategy: Strategy.PUBLIC,
  browser: true,
  args: [{ name: "limit", type: "int", default: 20, description: "Max rows" }],
  columns: ["rank", "title", "url"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const limit = requireNewsLimit(kwargs.limit);
    await p.goto(AIBASE_DAILY_URL, { waitUntil: "load", settleMs: 3000 });
    const payload = (await p.evaluate(
      buildExtractAibaseNewsJs(),
    )) as BrowserExtractPayload;
    return mapAibaseNewsPayload(payload, limit);
  },
});
