/**
 * @owner   src/adapters/facebook/marketplace-extra.ts
 * @does    Register agent-facing Facebook Marketplace seller listings and inbox readers.
 * @needs   Logged-in www.facebook.com browser session with Marketplace access.
 * @feeds   surface coverage ledger and Marketplace selling/conversation workflows.
 * @breaks  Facebook Marketplace DOM text changes, login redirects, or unavailable Marketplace account access.
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";

interface MarketplaceListingsResult {
  authRequired?: unknown;
  rows?: unknown;
}

interface MarketplaceListingRow {
  title?: unknown;
  price?: unknown;
  status?: unknown;
  listed?: unknown;
  clicks?: unknown;
  actions?: unknown;
}

interface MarketplaceInboxRow {
  buyer?: unknown;
  listing?: unknown;
  snippet?: unknown;
  time?: unknown;
  unread?: unknown;
}

export function requireFacebookMarketplaceLimit(value: unknown): number {
  const limit = Number(value ?? 20);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("Facebook Marketplace limit must be a positive integer.");
  }
  if (limit > 100) {
    throw new Error("Facebook Marketplace limit must be <= 100.");
  }
  return limit;
}

function requireBrowserPage(page: unknown, command: string): IPage {
  if (!page || typeof page !== "object") {
    throw new Error(`Browser session required for facebook ${command}.`);
  }
  return page as IPage;
}

function text(value: unknown): string {
  return value == null ? "" : String(value);
}

function readRows(
  result: MarketplaceListingsResult,
  command: string,
): unknown[] {
  if (result?.authRequired) {
    throw new Error(
      `Facebook Marketplace ${command} requires an active signed-in Facebook session.`,
    );
  }
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  if (!rows.length) {
    throw new Error(
      `No Facebook Marketplace ${command} rows were visible. Check Marketplace access for this account.`,
    );
  }
  return rows;
}

function marketplaceListingsScript(): string {
  return String.raw`(() => {
    const clean = (value) => String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const allText = document.body?.innerText || '';
    if (/log in|sign in/i.test(allText) && !/Marketplace/i.test(allText)) {
      return { authRequired: true, rows: [] };
    }
    const lines = allText.split(/\n+/).map(clean).filter(Boolean);
    const seen = new Set();
    const rows = [];
    for (let index = 1; index < lines.length; index += 1) {
      if (!/^(?:CA\$|\$)\s*\d+/.test(lines[index])) continue;
      const title = lines[index - 1];
      if (!title || /^(Hide|All listings|Needs attention|Marketplace|Selling)$/i.test(title)) continue;
      if (seen.has(title)) continue;
      seen.add(title);
      const windowLines = lines.slice(index, index + 12);
      const status = windowLines.find((line) => /^(Active|Sold|Pending|Draft)$/i.test(line)) || '';
      const listed = windowLines.find((line) => /Listed on\b/i.test(line))?.replace(/^·\s*/, '') || '';
      const clickLine = windowLines.find((line) => /clicks? on listing/i.test(line)) || '';
      const clickMatch = clickLine.match(/([\d,.]+)\s+clicks? on listing/i);
      const actions = windowLines.filter((line) => /^(Mark as sold|Mark as available|Relist this item|Share|Boost listing)$/i.test(line));
      rows.push({
        title,
        price: lines[index],
        status,
        listed,
        clicks: clickMatch ? clickMatch[1] : '',
        actions,
      });
    }
    return { authRequired: false, rows };
  })()`;
}

function marketplaceInboxScript(): string {
  return String.raw`(() => {
    const clean = (value) => String(value || '').replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
    const timeRe = /^(?:\d{1,2}:\d{2}\s?(?:AM|PM|am|pm|上午|下午)?|Mon|Tue|Wed|Thu|Fri|Sat|Sun|Today|Yesterday|\d+[mhdw]|\d+\s*(?:min|h|d|w))$/;
    const allText = document.body?.innerText || '';
    if (/log in|sign in/i.test(allText) && !/Marketplace/i.test(allText)) {
      return { authRequired: true, rows: [] };
    }
    const lines = allText.split(/\n+/).map(clean).filter(Boolean);
    const rows = [];
    const seen = new Set();
    const skipBuyer = /^(Marketplace|Browse all|Notifications|Inbox|Marketplace access|Buying|Selling|Create new listing|Create multiple listings|Location|Categories|Vehicles|Property Rentals|All|Pending payment|Paid|To be shipped|Shipped|Cash on delivery|Completed|Filter by label)$/i;
    for (let index = 0; index < lines.length - 2; index += 1) {
      const buyer = lines[index];
      const meta = lines[index + 1];
      if (skipBuyer.test(buyer) || !/^·\s+/.test(meta)) continue;
      const listing = meta.replace(/^·\s*/, '');
      if (!listing || /^Within\b/i.test(listing)) continue;
      const snippet = lines[index + 2] || '';
      const time = timeRe.test(lines[index + 3] || '') ? lines[index + 3] : '';
      const key = buyer + '|' + listing;
      if (seen.has(key)) continue;
      seen.add(key);
      const nearby = lines.slice(Math.max(0, index - 2), index + 5).join(' ');
      rows.push({
        buyer,
        listing,
        snippet,
        time,
        unread: /Unread/i.test(nearby),
      });
    }
    return { authRequired: false, rows };
  })()`;
}

cli({
  site: "facebook",
  name: "marketplace-listings",
  description: "List your Facebook Marketplace seller listings",
  domain: "www.facebook.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "limit", type: "int", default: 20 }],
  columns: ["index", "title", "price", "status", "listed", "clicks", "actions"],
  func: async (page, kwargs) => {
    const p = requireBrowserPage(page, "marketplace-listings");
    const limit = requireFacebookMarketplaceLimit(kwargs.limit);
    await p.goto("https://www.facebook.com/marketplace/you/selling/");
    await p.wait(4);
    const result = (await p.evaluate(
      marketplaceListingsScript(),
    )) as MarketplaceListingsResult;
    return readRows(result, "seller listings")
      .slice(0, limit)
      .map((item, index) => {
        const row = item as MarketplaceListingRow;
        return {
          index: index + 1,
          title: text(row.title),
          price: text(row.price),
          status: text(row.status),
          listed: text(row.listed),
          clicks: text(row.clicks),
          actions: Array.isArray(row.actions)
            ? row.actions.map(text).join(", ")
            : text(row.actions),
        };
      });
  },
});

cli({
  site: "facebook",
  name: "marketplace-inbox",
  description:
    "List recent Facebook Marketplace buyer and seller conversations",
  domain: "www.facebook.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "limit", type: "int", default: 20 }],
  columns: ["index", "buyer", "listing", "snippet", "time", "unread"],
  func: async (page, kwargs) => {
    const p = requireBrowserPage(page, "marketplace-inbox");
    const limit = requireFacebookMarketplaceLimit(kwargs.limit);
    await p.goto("https://www.facebook.com/marketplace/inbox/");
    await p.wait(4);
    const result = (await p.evaluate(
      marketplaceInboxScript(),
    )) as MarketplaceListingsResult;
    return readRows(result, "inbox conversations")
      .slice(0, limit)
      .map((item, index) => {
        const row = item as MarketplaceInboxRow;
        return {
          index: index + 1,
          buyer: text(row.buyer),
          listing: text(row.listing),
          snippet: text(row.snippet),
          time: text(row.time),
          unread: Boolean(row.unread),
        };
      });
  },
});
