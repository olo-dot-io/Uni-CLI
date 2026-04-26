import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { clickFirst, intArg, js, str } from "../_shared/browser-tools.js";

async function jdDetail(sku: string): Promise<Record<string, unknown>> {
  const body = JSON.stringify({ skuId: sku });
  const url = new URL("https://api.m.jd.com/api");
  url.searchParams.set("appid", "item-v3");
  url.searchParams.set("functionId", "pc_detailpage_wareBusiness");
  url.searchParams.set("body", body);
  const response = await fetch(url);
  const data = (await response.json()) as Record<string, unknown>;
  const ware = (data.wareInfo ?? {}) as Record<string, unknown>;
  const price = (data.priceInfo ?? {}) as Record<string, unknown>;
  const shop = (data.shopInfo ?? {}) as Record<string, unknown>;
  const stock = (data.stockInfo ?? {}) as Record<string, unknown>;
  return {
    sku,
    title: str(ware.wname),
    brand: str(ware.brand),
    price: str(price.price),
    shop: str(shop.shop),
    stock: str(stock.stockDesc),
    url: `https://item.jd.com/${sku}.html`,
  };
}

cli({
  site: "jd",
  name: "detail",
  description: "Fetch JD product detail by SKU",
  domain: "jd.com",
  strategy: Strategy.PUBLIC,
  args: [{ name: "sku", type: "str", required: true, positional: true }],
  columns: ["title", "price", "shop", "stock", "sku"],
  func: async (_page, kwargs) => [await jdDetail(str(kwargs.sku))],
});

cli({
  site: "jd",
  name: "reviews",
  description: "Fetch JD product reviews by SKU",
  domain: "jd.com",
  strategy: Strategy.PUBLIC,
  args: [
    { name: "sku", type: "str", required: true, positional: true },
    { name: "limit", type: "int", default: 10 },
  ],
  columns: ["nickname", "score", "content", "creationTime"],
  func: async (_page, kwargs) => {
    const sku = str(kwargs.sku);
    const limit = intArg(kwargs.limit, 10, 50);
    const url = new URL(
      "https://club.jd.com/comment/productPageComments.action",
    );
    url.searchParams.set("productId", sku);
    url.searchParams.set("score", "0");
    url.searchParams.set("sortType", "5");
    url.searchParams.set("page", "0");
    url.searchParams.set("pageSize", String(limit));
    const response = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; Uni-CLI)" },
    });
    const data = (await response.json()) as {
      comments?: Record<string, unknown>[];
    };
    return (data.comments ?? []).slice(0, limit).map((item) => ({
      nickname: str(item.nickname),
      score: item.score ?? "",
      content: str(item.content).slice(0, 300),
      creationTime: str(item.creationTime),
    }));
  },
});

cli({
  site: "jd",
  name: "cart",
  description: "Read JD cart items from the active browser session",
  domain: "jd.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "limit", type: "int", default: 30 }],
  columns: ["title", "price", "quantity", "url"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    await p.goto("https://cart.jd.com/cart_index", { settleMs: 3000 });
    const limit = intArg(kwargs.limit, 30, 100);
    const rows = (await p.evaluate(`(() => {
      const cards = [...document.querySelectorAll('.item-list .item-item, .cart-item-list .item-form')];
      return cards.map((card) => {
        const link = card.querySelector('.p-name a, a[href*="item.jd.com"]');
        return {
          title: (link?.textContent || '').replace(/\\s+/g, ' ').trim(),
          price: (card.querySelector('.p-price, .price')?.textContent || '').replace(/\\s+/g, ' ').trim(),
          quantity: (card.querySelector('input.itxt, input[type="text"]')?.value || '').trim(),
          url: link ? new URL(link.getAttribute('href') || '', location.href).href : ''
        };
      }).filter((row) => row.title).slice(0, ${js(limit)});
    })()`)) as Record<string, unknown>[];
    return rows;
  },
});

cli({
  site: "jd",
  name: "add-cart",
  description: "Add a JD product to cart in the active browser session",
  domain: "jd.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "sku", type: "str", required: true, positional: true },
    { name: "quantity", type: "int", default: 1 },
  ],
  columns: ["ok", "selector", "url"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const sku = str(kwargs.sku);
    await p.goto(`https://item.jd.com/${encodeURIComponent(sku)}.html`, {
      settleMs: 3000,
    });
    const quantity = intArg(kwargs.quantity, 1, 99);
    if (quantity > 1) {
      await p.evaluate(`(() => {
        const input = document.querySelector('#buy-num, input.quantity, input[type="text"]');
        if (input) {
          input.value = ${js(String(quantity))};
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })()`);
    }
    const selector = await clickFirst(p, [
      "#InitCartUrl",
      "#btn-add-cart",
      ".btn-append",
      "a[href*='cart']",
    ]);
    return [{ ok: selector !== null, selector, url: await p.url() }];
  },
});
