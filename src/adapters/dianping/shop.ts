/**
 * @owner   src/adapters/dianping/shop.ts
 * @does    Register agent-facing Dianping shop detail extraction implemented with site-specific safety checks.
 * @needs   Dianping shop page DOM and a browser profile that can pass Dianping anti-bot checks.
 * @feeds   surface coverage ledger and restaurant search-to-detail workflows.
 * @breaks  Dianping shop-head DOM drift, login redirects, captcha gates, or deleted shops can hide detail fields.
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { str } from "../_shared/browser-tools.js";

const DIANPING_ORIGIN = "https://www.dianping.com";
const SHOP_ID_RE = /^[A-Za-z0-9_-]+$/;
const SHOP_FIELDS = [
  "shop_id",
  "name",
  "rating",
  "reviews",
  "price",
  "rank",
  "taste",
  "environment",
  "service",
  "ingredients",
  "hours",
  "address",
  "subway",
  "features",
  "url",
] as const;

type DianpingShopField = (typeof SHOP_FIELDS)[number];

interface DianpingShopBreakdown {
  口味?: unknown;
  环境?: unknown;
  服务?: unknown;
  食材?: unknown;
}

interface DianpingShopData {
  name?: unknown;
  rating?: unknown;
  reviewsRaw?: unknown;
  priceRaw?: unknown;
  rank?: unknown;
  breakdown?: DianpingShopBreakdown;
  hours?: unknown;
  address?: unknown;
  subway?: unknown;
  features?: unknown;
  url?: unknown;
}

interface DianpingShopResult extends DianpingShopData {
  ok?: unknown;
  sample?: unknown;
}

export function normalizeDianpingShopId(value: unknown): string {
  const raw = str(value).trim();
  if (!raw) throw new Error("Dianping shop_id must be a non-empty string.");
  const match = raw.match(/\/shop\/([^/?#]+)/);
  const shopId = match?.[1] ?? raw;
  if (!SHOP_ID_RE.test(shopId)) {
    throw new Error(
      `Dianping shop_id must be an alphanumeric shop ID or /shop/<id> URL.`,
    );
  }
  return shopId;
}

export function parseDianpingReviewCount(value: unknown): number | null {
  const text = str(value).trim();
  if (!text) return null;
  const wan = text.match(/^([\d.]+)\s*万/);
  if (wan) {
    const count = Number(wan[1]);
    return Number.isFinite(count) ? Math.round(count * 10000) : null;
  }
  const plain = text.match(/(\d+(?:\.\d+)?)/);
  if (!plain) return null;
  const count = Number(plain[1]);
  return Number.isFinite(count) ? Math.round(count) : null;
}

export function parseDianpingPrice(value: unknown): number | null {
  const match = str(value).match(/[¥￥]\s*(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const price = Number(match[1]);
  return Number.isFinite(price) ? price : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = str(value).trim();
  if (!text) return null;
  const valueNumber = Number(text);
  return Number.isFinite(valueNumber) ? valueNumber : null;
}

function featuresText(value: unknown): string {
  if (Array.isArray(value))
    return value
      .map((item) => str(item).trim())
      .filter(Boolean)
      .join(", ");
  return str(value).trim();
}

export function mapDianpingShopFields(
  shopId: string,
  data: DianpingShopData,
  fallbackUrl: string,
): Array<{ field: DianpingShopField; value: unknown }> {
  const rating = numberOrNull(data.rating);
  const breakdown = data.breakdown ?? {};
  const values: Record<DianpingShopField, unknown> = {
    shop_id: shopId,
    name: str(data.name).trim(),
    rating,
    reviews: parseDianpingReviewCount(data.reviewsRaw),
    price: parseDianpingPrice(data.priceRaw),
    rank: str(data.rank).trim(),
    taste: numberOrNull(breakdown["口味"]),
    environment: numberOrNull(breakdown["环境"]),
    service: numberOrNull(breakdown["服务"]),
    ingredients: numberOrNull(breakdown["食材"]),
    hours: str(data.hours).trim(),
    address: str(data.address).trim(),
    subway: str(data.subway).trim(),
    features: featuresText(data.features),
    url: str(data.url).trim() || fallbackUrl,
  };
  return SHOP_FIELDS.map((field) => ({ field, value: values[field] }));
}

export function classifyDianpingShopFailure(
  sample: unknown,
  url: string,
  shopId: string,
): never {
  const signal = `${url} ${str(sample)}`;
  if (
    /verify\.meituan\.com|verifyimg|身份核实|请依次点击|美团安全验证|Yoda/i.test(
      signal,
    )
  ) {
    throw new Error(
      `Dianping shop ${shopId} is blocked by captcha; solve the Dianping captcha in this browser profile and retry.`,
    );
  }
  if (
    /login\.dianping\.com|account\.dianping\.com|请先登录|未登录|请登录/.test(
      signal,
    )
  ) {
    throw new Error(
      `Dianping shop ${shopId} requires login; sign in to dianping.com in this browser profile and retry.`,
    );
  }
  if (
    /商户不存在|店铺不存在|店铺已关闭|页面不存在|404|已下线|没有找到相关商户/i.test(
      signal,
    )
  ) {
    throw new Error(`Dianping shop ${shopId} was not found or is unavailable.`);
  }
  const preview = str(sample).slice(0, 160);
  throw new Error(
    `Dianping shop ${shopId} did not render expected shop data${preview ? `; sample: ${preview}` : ""}.`,
  );
}

function buildDianpingShopEvaluate(): string {
  return `(() => {
    const clean = (value) => value == null ? '' : String(value).replace(/\\s+/g, ' ').trim();
    const head = document.querySelector('.shop-head');
    if (!head) {
      const sample = clean(document.body?.innerText || document.body?.textContent || '').slice(0, 800);
      return { ok: false, sample, url: location.href };
    }
    const headText = clean(head.textContent);
    const titleEl = document.querySelector('.shop-name, .shop-head h2, .shop-head h1');
    let name = clean(titleEl?.textContent);
    if (!name) {
      const match = String(document.title || '').match(/【([^】]+)】/);
      if (match) name = clean(match[1]);
    }
    const rating = clean(document.querySelector('.star-score')?.textContent);
    const reviewEl = document.querySelector('.reviews, .review-num, .reviewCount, .reviewCountSentence');
    let reviewsRaw = clean(reviewEl?.textContent);
    if (!reviewsRaw) {
      const titleText = clean(document.querySelector('.review-title')?.textContent);
      const titleMatch = titleText.match(/评价\\(([\\d.,万]+)\\)/);
      if (titleMatch) reviewsRaw = titleMatch[1];
    }
    const priceMatch = headText.match(/[¥￥]\\s*\\d+(?:\\.\\d+)?/);
    const breakdown = {};
    for (const key of ['口味', '环境', '服务', '食材']) {
      const match = headText.match(new RegExp(key + '[:：]\\\\s*([0-9.]+)'));
      if (match) breakdown[key] = Number(match[1]);
    }
    const features = Array.from(document.querySelectorAll('.shop-feature')).map((node) => clean(node.textContent)).filter(Boolean);
    const subwayMatch = headText.match(/距(?:地铁)?[^\\s]+?步行\\d+m/);
    const hoursMatch = headText.match(/营业中[^\\s]*\\d{1,2}:\\d{2}-(?:次日)?\\d{1,2}:\\d{2}|今日休息|暂停营业/);
    const rankMatch = headText.match(/[^\\s]+?(?:口味|人气|环境|服务)榜\\s*[·•]\\s*第\\d+名/);
    return {
      ok: true,
      name,
      rating,
      reviewsRaw,
      priceRaw: priceMatch?.[0] || '',
      rank: rankMatch?.[0] || '',
      breakdown,
      hours: hoursMatch?.[0] || '',
      address: clean(document.querySelector('.desc-info')?.textContent),
      subway: subwayMatch?.[0] || '',
      features,
      url: location.href,
    };
  })()`;
}

cli({
  site: "dianping",
  name: "shop",
  description: "Read Dianping shop details by shop ID or shop URL",
  domain: "www.dianping.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "shop_id",
      type: "str",
      required: true,
      positional: true,
      description: "Dianping shop ID or https://www.dianping.com/shop/<id> URL",
    },
  ],
  columns: ["field", "value"],
  func: async (page, kwargs) => {
    const shopId = normalizeDianpingShopId(kwargs.shop_id);
    const url = `${DIANPING_ORIGIN}/shop/${shopId}`;
    const p = page as IPage;
    await p.goto(url, { waitUntil: "load", settleMs: 3000 });
    await p.wait(3);
    const result = (await p.evaluate(
      buildDianpingShopEvaluate(),
    )) as DianpingShopResult;
    if (!result?.ok) {
      classifyDianpingShopFailure(
        result?.sample,
        str(result?.url) || url,
        shopId,
      );
    }
    return mapDianpingShopFields(shopId, result, url);
  },
});
