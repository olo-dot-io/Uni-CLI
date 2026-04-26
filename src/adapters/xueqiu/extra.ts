import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { loadCookies, formatCookieHeader } from "../../engine/cookies.js";
import { USER_AGENT } from "../../constants.js";
import { intArg, js, str } from "../_shared/browser-tools.js";

async function xueqiuJson(url: string): Promise<Record<string, unknown>> {
  const cookies = loadCookies("xueqiu");
  const headers: Record<string, string> = {
    "user-agent": USER_AGENT,
    referer: "https://xueqiu.com",
    accept: "application/json",
  };
  if (cookies) headers.cookie = formatCookieHeader(cookies);
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Xueqiu request failed: HTTP ${response.status}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

cli({
  site: "xueqiu",
  name: "kline",
  description: "Fetch Xueqiu stock candlestick data",
  domain: "xueqiu.com",
  strategy: Strategy.COOKIE,
  args: [
    { name: "symbol", type: "str", required: true, positional: true },
    { name: "period", type: "str", default: "day" },
    { name: "count", type: "int", default: 120 },
  ],
  columns: ["timestamp", "open", "close", "high", "low", "volume"],
  func: async (_page, kwargs) => {
    const symbol = str(kwargs.symbol).toUpperCase();
    const count = intArg(kwargs.count, 120, 1000);
    const url = new URL("https://stock.xueqiu.com/v5/stock/chart/kline.json");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("begin", String(Date.now()));
    url.searchParams.set("period", str(kwargs.period, "day"));
    url.searchParams.set("type", "before");
    url.searchParams.set("count", `-${count}`);
    const data = await xueqiuJson(url.href);
    const item = (data.data ?? {}) as Record<string, unknown>;
    const columns = Array.isArray(item.column) ? (item.column as string[]) : [];
    const rows = Array.isArray(item.item) ? (item.item as unknown[][]) : [];
    return rows.map((row) =>
      Object.fromEntries(columns.map((name, i) => [name, row[i]])),
    );
  },
});

cli({
  site: "xueqiu",
  name: "groups",
  description: "Read visible Xueqiu portfolio or group lists",
  domain: "xueqiu.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "limit", type: "int", default: 20 }],
  columns: ["name", "url"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const limit = intArg(kwargs.limit, 20, 100);
    await p.goto("https://xueqiu.com/portfolio", { settleMs: 2500 });
    const rows = await p.evaluate(`(() => {
      const links = [...document.querySelectorAll('a[href*="/P/"], a[href*="portfolio"], a[href]')];
      const seen = new Set();
      return links.map((a) => {
        const url = new URL(a.getAttribute('href') || '', location.href).href;
        if (seen.has(url)) return null;
        seen.add(url);
        return { name: (a.textContent || '').replace(/\\s+/g, ' ').trim(), url };
      }).filter((row) => row && row.name).slice(0, ${js(limit)});
    })()`);
    return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  },
});
