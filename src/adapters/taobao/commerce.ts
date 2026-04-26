import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { clickFirst, intArg, js, str } from "../_shared/browser-tools.js";

function itemUrl(id: unknown): string {
  const value = str(id);
  if (value.startsWith("http")) return value;
  return `https://item.taobao.com/item.htm?id=${encodeURIComponent(value)}`;
}

cli({
  site: "taobao",
  name: "detail",
  description: "Read Taobao product detail from the active browser session",
  domain: "taobao.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "id", type: "str", required: true, positional: true }],
  columns: ["title", "price", "shop", "sales", "url"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    await p.goto(itemUrl(kwargs.id), { settleMs: 3500 });
    const rows = (await p.evaluate(`(() => {
      const clean = (v) => (v || '').replace(/\\s+/g, ' ').trim();
      return [{
        title: clean(document.querySelector('h1, [class*="Title"], [class*="title"]')?.textContent),
        price: clean(document.querySelector('[class*="Price"], .tb-rmb-num, [class*="price"]')?.textContent),
        shop: clean(document.querySelector('[class*="Shop"], [class*="shop"], .tb-shop-name')?.textContent),
        sales: clean(document.querySelector('[class*="Sell"], [class*="sales"], [class*="Sales"]')?.textContent),
        url: location.href
      }];
    })()`)) as Record<string, unknown>[];
    return rows;
  },
});

cli({
  site: "taobao",
  name: "reviews",
  description: "Read visible Taobao product reviews",
  domain: "taobao.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "id", type: "str", required: true, positional: true },
    { name: "limit", type: "int", default: 20 },
  ],
  columns: ["author", "content", "date"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    await p.goto(itemUrl(kwargs.id), { settleMs: 3500 });
    await clickFirst(p, [
      "a[href*='rate']",
      "button[aria-label*='评价']",
      "[class*='Rate']",
      "[class*='review']",
    ]);
    await p.wait(1);
    const limit = intArg(kwargs.limit, 20, 100);
    const rows = (await p.evaluate(`(() => {
      const cards = [...document.querySelectorAll('[class*="rate"], [class*="Rate"], [class*="review"], [class*="Review"]')];
      return cards.map((card) => ({
        author: (card.querySelector('[class*="user"], [class*="User"], [class*="name"]')?.textContent || '').replace(/\\s+/g, ' ').trim(),
        content: (card.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 400),
        date: (card.querySelector('[class*="date"], [class*="time"]')?.textContent || '').replace(/\\s+/g, ' ').trim()
      })).filter((row) => row.content).slice(0, ${js(limit)});
    })()`)) as Record<string, unknown>[];
    return rows;
  },
});

cli({
  site: "taobao",
  name: "cart",
  description: "Read Taobao cart items from the active browser session",
  domain: "taobao.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "limit", type: "int", default: 30 }],
  columns: ["title", "price", "quantity", "url"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    await p.goto("https://cart.taobao.com/cart.htm", { settleMs: 3500 });
    const limit = intArg(kwargs.limit, 30, 100);
    const rows = (await p.evaluate(`(() => {
      const cards = [...document.querySelectorAll('.item-content, [class*="cart-item"], [class*="Item"]')];
      return cards.map((card) => {
        const link = card.querySelector('a[href*="item.taobao.com"], a[href*="detail.tmall.com"]');
        return {
          title: (link?.textContent || card.querySelector('[class*="title"], [class*="Title"]')?.textContent || '').replace(/\\s+/g, ' ').trim(),
          price: (card.querySelector('[class*="price"], [class*="Price"], .price-now')?.textContent || '').replace(/\\s+/g, ' ').trim(),
          quantity: (card.querySelector('input[type="text"], input[type="number"]')?.value || '').trim(),
          url: link ? new URL(link.getAttribute('href') || '', location.href).href : ''
        };
      }).filter((row) => row.title).slice(0, ${js(limit)});
    })()`)) as Record<string, unknown>[];
    return rows;
  },
});

cli({
  site: "taobao",
  name: "add-cart",
  description: "Add a Taobao product to cart in the active browser session",
  domain: "taobao.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "id", type: "str", required: true, positional: true },
    { name: "spec", type: "str", required: false },
  ],
  columns: ["ok", "selector", "url"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    await p.goto(itemUrl(kwargs.id), { settleMs: 3500 });
    if (kwargs.spec) {
      const spec = str(kwargs.spec);
      await p.evaluate(`(() => {
        const spec = ${js(spec)};
        const nodes = [...document.querySelectorAll('button, li, span')];
        const node = nodes.find((el) => (el.textContent || '').includes(spec));
        if (node) node.click();
      })()`);
      await p.wait(0.5);
    }
    const selector = await clickFirst(p, [
      "button[class*='cart']",
      "a[class*='cart']",
      "#J_LinkAdd",
      "[aria-label*='购物车']",
    ]);
    return [{ ok: selector !== null, selector, url: await p.url() }];
  },
});
