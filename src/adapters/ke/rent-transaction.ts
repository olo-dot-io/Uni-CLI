import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { intArg, js, str } from "../_shared/browser-tools.js";

async function extractKe(
  page: IPage,
  url: string,
  limit: number,
): Promise<Record<string, unknown>[]> {
  await page.goto(url, { settleMs: 3000 });
  const rows = await page.evaluate(`(() => {
    const cards = [...document.querySelectorAll('.content__list--item, .sellListContent li, .listContent li, li.clear')];
    return cards.map((card) => {
      const link = card.querySelector('a[href]');
      const text = (card.textContent || '').replace(/\\s+/g, ' ').trim();
      return {
        title: (card.querySelector('.title, .content__list--item--title, a[href]')?.textContent || '').replace(/\\s+/g, ' ').trim(),
        location: (card.querySelector('.positionInfo, .content__list--item--des')?.textContent || '').replace(/\\s+/g, ' ').trim(),
        price: (card.querySelector('.totalPrice, .content__list--item-price, .unitPrice')?.textContent || '').replace(/\\s+/g, ' ').trim(),
        date: (text.match(/\\d{4}[-年.]\\d{1,2}[-月.]\\d{1,2}/) || [''])[0],
        url: link ? new URL(link.getAttribute('href') || '', location.href).href : '',
        summary: text.slice(0, 260)
      };
    }).filter((row) => row.title).slice(0, ${js(limit)});
  })()`);
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

cli({
  site: "ke",
  name: "zufang",
  description: "Browse Ke.com rental listings",
  domain: "ke.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "city", type: "str", default: "bj" },
    { name: "district", type: "str", required: false },
    { name: "max_price", type: "int", required: false },
    { name: "limit", type: "int", default: 20 },
  ],
  columns: ["title", "location", "price", "url"],
  func: async (page, kwargs) => {
    const city = str(kwargs.city, "bj");
    const district = str(kwargs.district);
    const url = `https://${city}.ke.com/zufang/${district}`;
    return extractKe(page as IPage, url, intArg(kwargs.limit, 20, 100));
  },
});

cli({
  site: "ke",
  name: "chengjiao",
  description: "Browse Ke.com recent transaction records",
  domain: "ke.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "city", type: "str", default: "bj" },
    { name: "district", type: "str", required: false },
    { name: "limit", type: "int", default: 20 },
  ],
  columns: ["title", "location", "price", "date", "url"],
  func: async (page, kwargs) => {
    const city = str(kwargs.city, "bj");
    const district = str(kwargs.district);
    const url = `https://${city}.ke.com/chengjiao/${district}`;
    return extractKe(page as IPage, url, intArg(kwargs.limit, 20, 100));
  },
});
