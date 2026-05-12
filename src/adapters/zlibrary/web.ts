/**
 * @owner   src/adapters/zlibrary/web.ts
 * @does    Register agent-facing Z-Library search and info commands implemented with site-specific safety checks.
 * @needs   Logged-in z-library.im browser session and Z-Library search/book page DOM.
 * @feeds   surface coverage ledger, book search rows, and book detail/download-format discovery.
 * @breaks  Z-Library host changes, login redirects, or z-bookcard shadow DOM drift can hide results.
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { str } from "../_shared/browser-tools.js";

const ZLIBRARY_DOMAIN = "z-library.im";
const ZLIBRARY_ORIGIN = `https://${ZLIBRARY_DOMAIN}`;
const ALLOWED_HOSTS = new Set([ZLIBRARY_DOMAIN, `www.${ZLIBRARY_DOMAIN}`]);

interface ZlibraryFormatLinks {
  pdf?: unknown;
  epub?: unknown;
}

interface ZlibrarySearchRow {
  rank?: unknown;
  title?: unknown;
  author?: unknown;
  url?: unknown;
}

export function normalizeZlibraryBookUrl(value: unknown): string {
  const raw = str(value).trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `Z-Library book URL must be a valid http(s) URL under ${ZLIBRARY_DOMAIN}.`,
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !ALLOWED_HOSTS.has(url.hostname)
  ) {
    throw new Error(
      `Unsupported Z-Library URL host: ${url.hostname}. Expected ${ZLIBRARY_DOMAIN}.`,
    );
  }
  return url.toString();
}

export function buildZlibrarySearchUrl(value: unknown): string {
  const query = str(value).trim();
  if (!query) throw new Error("Z-Library search query cannot be empty.");
  return `${ZLIBRARY_ORIGIN}/s/${encodeURIComponent(query)}`;
}

export function requireZlibraryLimit(value: unknown, fallback = 10): number {
  const raw = value ?? fallback;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Z-Library search limit must be a positive integer.");
  }
  if (limit > 25) throw new Error("Z-Library search limit must be <= 25.");
  return limit;
}

export function mapZlibrarySearchRows(
  rows: ZlibrarySearchRow[],
): Record<string, unknown>[] {
  return rows
    .map((row, index) => ({
      rank: Number(row.rank) || index + 1,
      title: str(row.title).trim(),
      author: str(row.author).trim(),
      url: str(row.url).trim(),
    }))
    .filter((row) => row.title && row.url);
}

async function extractBookTitle(page: IPage): Promise<string> {
  const title = await page.evaluate(`(() => {
    const card = document.querySelector('z-bookcard');
    if (card?.shadowRoot) {
      const el = card.shadowRoot.querySelector('[class*="title"], h1, a');
      if (el) return el.textContent.trim().split('\\n')[0].trim();
    }
    return document.title.replace(/\\s*[-|].*$/, '').trim();
  })()`);
  return str(title).trim();
}

async function extractFormats(
  page: IPage,
): Promise<{ pdf: string; epub: string }> {
  await page.evaluate(`(() => {
    const button = document.querySelector('button[aria-label*="more" i], [class*="dots" i], [class*="more" i]');
    if (button instanceof HTMLElement) button.click();
  })()`);
  await page.wait(3);
  const formats = await page.evaluate(`(() => {
    const result = { pdf: '', epub: '' };
    document.querySelectorAll('a[href]').forEach((anchor) => {
      const href = anchor.href || '';
      const text = (anchor.textContent || '').toUpperCase();
      if (href.includes('/dl/') && text.includes('PDF')) result.pdf = href;
      if (href.includes('/dl/') && text.includes('EPUB')) result.epub = href;
    });
    return result;
  })()`);
  const row =
    typeof formats === "object" && formats !== null
      ? (formats as ZlibraryFormatLinks)
      : {};
  return { pdf: str(row.pdf), epub: str(row.epub) };
}

async function extractSearchResults(
  page: IPage,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const result = await page.evaluate(`(() => {
    return Array.from(document.querySelectorAll('z-bookcard'))
      .slice(0, ${JSON.stringify(limit)})
      .map((card, index) => {
        const text = (card.textContent || '').trim();
        const lines = text.split('\\n').map((line) => line.trim()).filter(Boolean);
        const title = lines[0] || '';
        const author = lines[1] || '';
        let url = '';
        if (card.shadowRoot) {
          const link = card.shadowRoot.querySelector('a');
          if (link) url = link.href || '';
        }
        return { rank: index + 1, title, author, url };
      });
  })()`);
  return mapZlibrarySearchRows(
    Array.isArray(result) ? (result as ZlibrarySearchRow[]) : [],
  );
}

cli({
  site: "zlibrary",
  name: "search",
  description: "Search Z-Library for books by title, author, ISBN, or keyword",
  domain: ZLIBRARY_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "query", type: "str", required: true, positional: true },
    { name: "limit", type: "int", default: 10 },
  ],
  columns: ["rank", "title", "author", "url"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const limit = requireZlibraryLimit(kwargs.limit);
    await p.goto(buildZlibrarySearchUrl(kwargs.query), {
      waitUntil: "load",
      settleMs: 3000,
    });
    await p.wait(5);
    const rows = await extractSearchResults(p, limit);
    if (!rows.length)
      throw new Error("No Z-Library books found for the query.");
    return rows;
  },
});

cli({
  site: "zlibrary",
  name: "info",
  description:
    "Get book details and available download formats from a Z-Library book page",
  domain: ZLIBRARY_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "url", type: "str", required: true, positional: true }],
  columns: ["title", "pdf", "epub", "url"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const url = normalizeZlibraryBookUrl(kwargs.url);
    await p.goto(url, { waitUntil: "load", settleMs: 3000 });
    await p.wait(5);
    const title = await extractBookTitle(p);
    const formats = await extractFormats(p);
    if (!title || (!formats.pdf && !formats.epub)) {
      throw new Error(
        "Could not extract Z-Library title and download formats.",
      );
    }
    return [{ title, pdf: formats.pdf, epub: formats.epub, url }];
  },
});
