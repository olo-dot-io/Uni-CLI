/**
 * @owner   src/adapters/coupang/product.ts
 * @does    Register agent-facing Coupang product detail extraction implemented with site-specific safety checks.
 * @needs   Coupang product page DOM and optional logged-in browser session for restricted products.
 * @feeds   surface coverage ledger and Coupang search-to-detail workflows.
 * @breaks  Coupang product page redirects, anti-bot pages, or product DOM/bootstrap schema drift can hide detail fields.
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { js, str } from "../_shared/browser-tools.js";

const COUPANG_ORIGIN = "https://www.coupang.com";
const PRODUCT_ID_RE = /^\d{6,}$/;

interface CoupangProductData {
  product_id?: unknown;
  title?: unknown;
  price?: unknown;
  original_price?: unknown;
  discount_rate?: unknown;
  rating?: unknown;
  review_count?: unknown;
  seller?: unknown;
  brand?: unknown;
  rocket?: unknown;
  delivery_promise?: unknown;
  image_url?: unknown;
}

interface CoupangProductResult {
  ok?: unknown;
  reason?: unknown;
  currentProductId?: unknown;
  loginHints?: { hasLoginLink?: unknown; hasMyCoupang?: unknown };
  data?: CoupangProductData;
}

export function normalizeCoupangProductId(value: unknown): string {
  const raw = str(value).trim();
  const match = raw.match(/(?:^|\/vp\/products\/)(\d{6,})(?:[/?#]|$)/);
  return match?.[1] ?? (PRODUCT_ID_RE.test(raw) ? raw : "");
}

export function requireCoupangProductId(value: unknown, label: string): string {
  const raw = str(value).trim();
  let id = "";
  if (label === "url") {
    let url: URL;
    try {
      url = new URL(raw.startsWith("http") ? raw : `${COUPANG_ORIGIN}${raw}`);
    } catch {
      throw new Error(
        "Coupang url must be a product URL containing /vp/products/<id>.",
      );
    }
    const host = url.hostname.toLowerCase();
    const match = url.pathname.match(/^\/vp\/products\/(\d{6,})(?:\/|$)/);
    if ((host === "coupang.com" || host.endsWith(".coupang.com")) && match)
      id = match[1];
  } else {
    id = normalizeCoupangProductId(raw);
  }
  if (!id)
    throw new Error(
      `Coupang ${label} must be a numeric product ID or product URL.`,
    );
  return id;
}

export function canonicalizeCoupangProductUrl(
  value: unknown,
  productId: string,
): string {
  const raw = str(value).trim();
  if (raw) {
    try {
      const url = new URL(
        raw.startsWith("http") ? raw : `${COUPANG_ORIGIN}${raw}`,
      );
      const host = url.hostname.toLowerCase();
      if (host !== "coupang.com" && !host.endsWith(".coupang.com")) return "";
      const id =
        normalizeCoupangProductId(url.pathname) ||
        normalizeCoupangProductId(productId);
      return id ? `${COUPANG_ORIGIN}/vp/products/${id}` : url.toString();
    } catch {
      return "";
    }
  }
  return productId ? `${COUPANG_ORIGIN}/vp/products/${productId}` : "";
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = str(value).replace(/[^\d.]/g, "");
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

export function mapCoupangProductRow(
  productId: string,
  data: CoupangProductData,
  url: string,
): Record<string, unknown> {
  const actualId = normalizeCoupangProductId(data.product_id) || productId;
  return {
    product_id: actualId,
    title: str(data.title).trim() || null,
    price: numberOrNull(data.price),
    original_price: numberOrNull(data.original_price),
    discount_rate: numberOrNull(data.discount_rate),
    rating: numberOrNull(data.rating),
    review_count: numberOrNull(data.review_count),
    seller: str(data.seller).trim() || null,
    brand: str(data.brand).trim() || null,
    rocket: str(data.rocket).trim() || null,
    delivery_promise: str(data.delivery_promise).trim() || null,
    image_url: str(data.image_url).trim() || null,
    url: canonicalizeCoupangProductUrl("", actualId) || url,
  };
}

function buildProductEvaluate(expectedProductId: string): string {
  return `(() => {
    const expectedProductId = ${js(expectedProductId)};
    const normalizeText = (value) => value == null ? '' : String(value).trim();
    const parseNum = (value) => {
      const text = normalizeText(value).replace(/[^\\d.]/g, '');
      if (!text) return null;
      const num = Number(text);
      return Number.isFinite(num) ? num : null;
    };
    const loginHints = {
      hasLoginLink: Boolean(document.querySelector('a[href*="login"], a[title*="로그인"]')),
      hasMyCoupang: /마이쿠팡/.test(document.body.innerText || ''),
    };
    const pathMatch = location.pathname.match(/\\/vp\\/products\\/(\\d+)/);
    const currentProductId = pathMatch?.[1] || '';
    if (expectedProductId && currentProductId && expectedProductId !== currentProductId) {
      return { ok: false, reason: 'PRODUCT_MISMATCH', currentProductId, loginHints };
    }
    const jsonLd = (() => {
      const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      for (const script of scripts) {
        try {
          const docs = JSON.parse(script.textContent || 'null');
          const items = Array.isArray(docs) ? docs : [docs];
          for (const doc of items) {
            if (!doc || typeof doc !== 'object') continue;
            const types = Array.isArray(doc['@type']) ? doc['@type'] : [doc['@type']];
            if (!types.some((type) => /Product/i.test(String(type || '')))) continue;
            const offer = Array.isArray(doc.offers) ? doc.offers[0] : doc.offers;
            return {
              title: normalizeText(doc.name),
              brand: normalizeText(doc.brand?.name || doc.brand),
              image_url: normalizeText(Array.isArray(doc.image) ? doc.image[0] : doc.image),
              price: parseNum(offer?.price),
              rating: parseNum(doc.aggregateRating?.ratingValue),
              review_count: parseNum(doc.aggregateRating?.reviewCount),
              seller: normalizeText(offer?.seller?.name),
            };
          }
        } catch {}
      }
      return null;
    })();
    const dom = (() => {
      const title = document.querySelector('.prod-buy-header__title, h1[class*="prod-buy-header"], h1[class*="ProductName"], h1[class*="product-name"]');
      const price = document.querySelector('.total-price strong, .prod-sale-price strong, [class*="finalPrice"], [class*="sellingPrice"], [class*="price-value"]');
      const original = document.querySelector('.origin-price, .base-price, del[class*="origin"], del[class*="base"], [class*="strike"], [class*="origin-price"]');
      const discount = document.querySelector('.discount-percentage, [class*="discount"][class*="percent"], [class*="discountRate"]');
      const rating = document.querySelector('.rating-star-num, [class*="ratingStar"], [class*="rating-star"], [class*="rating-num"], [class*="ProductRating"]');
      const reviews = document.querySelector('.count, .rating-total-count, [class*="reviewCount"], [class*="review-count"]');
      const seller = document.querySelector('.prod-sale-vendor-name, [class*="vendor-name"], [class*="vendorName"], [class*="sellerName"]');
      const image = document.querySelector('.prod-image__detail, [class*="prod-image"] img, [class*="ProductImage"] img');
      return {
        title: normalizeText(title?.textContent),
        price: parseNum(price?.textContent),
        original_price: parseNum(original?.textContent),
        discount_rate: parseNum(discount?.textContent),
        rating: parseNum(rating?.getAttribute?.('aria-label') || rating?.textContent),
        review_count: parseNum(reviews?.textContent),
        seller: normalizeText(seller?.textContent),
        image_url: normalizeText(image?.getAttribute?.('src') || image?.getAttribute?.('data-src')),
      };
    })();
    const data = { ...(jsonLd || {}) };
    for (const [key, value] of Object.entries(dom)) {
      if (data[key] == null || data[key] === '') data[key] = value;
    }
    if (!data.title && data.price == null) {
      return { ok: false, reason: 'NO_DATA_EXTRACTED', currentProductId, loginHints };
    }
    return { ok: true, currentProductId, loginHints, data };
  })()`;
}

cli({
  site: "coupang",
  name: "product",
  description: "Read full product detail for a Coupang product",
  domain: "www.coupang.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "product-id", type: "str", required: false, positional: true },
    { name: "url", type: "str", required: false },
  ],
  columns: [
    "product_id",
    "title",
    "price",
    "original_price",
    "discount_rate",
    "rating",
    "review_count",
    "seller",
    "brand",
    "rocket",
    "delivery_promise",
    "image_url",
    "url",
  ],
  func: async (page, kwargs) => {
    const rawProductId = kwargs["product-id"];
    if (!rawProductId && !kwargs.url)
      throw new Error("Either product-id or url is required.");
    const productId = rawProductId
      ? requireCoupangProductId(rawProductId, "product-id")
      : requireCoupangProductId(kwargs.url, "url");
    const url =
      canonicalizeCoupangProductUrl(kwargs.url, productId) ||
      canonicalizeCoupangProductUrl("", productId);
    const p = page as IPage;
    await p.goto(url, { waitUntil: "load", settleMs: 3000 });
    await p.wait(2);
    const result = (await p.evaluate(
      buildProductEvaluate(productId),
    )) as CoupangProductResult;
    const loginHints = result?.loginHints ?? {};
    if (loginHints.hasLoginLink && !loginHints.hasMyCoupang) {
      throw new Error("Coupang login is required.");
    }
    if (result?.reason === "PRODUCT_MISMATCH") {
      throw new Error(
        `Coupang product page redirected away from expected product ${productId}.`,
      );
    }
    if (!result?.ok || !result.data) {
      throw new Error(`No Coupang product data extracted from ${url}.`);
    }
    return [mapCoupangProductRow(productId, result.data, url)];
  },
});
