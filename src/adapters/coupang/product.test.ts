import { describe, expect, it, vi } from "vitest";
import { resolveCommand } from "../../registry.js";
import {
  canonicalizeCoupangProductUrl,
  mapCoupangProductRow,
  normalizeCoupangProductId,
  requireCoupangProductId,
} from "./product.js";

function pageMock(evaluateResults: unknown[]) {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(async () => evaluateResults.shift()),
  };
}

describe("coupang product agent-facing command", () => {
  it("validates ids and maps product detail rows", () => {
    expect(
      normalizeCoupangProductId(
        "https://www.coupang.com/vp/products/123456789?itemId=1",
      ),
    ).toBe("123456789");
    expect(requireCoupangProductId("123456789", "product-id")).toBe(
      "123456789",
    );
    expect(
      requireCoupangProductId("/vp/products/123456789?itemId=1", "url"),
    ).toBe("123456789");
    expect(() => requireCoupangProductId("abc", "product-id")).toThrow(
      "Coupang product-id",
    );
    expect(canonicalizeCoupangProductUrl("", "123456789")).toBe(
      "https://www.coupang.com/vp/products/123456789",
    );
    expect(
      mapCoupangProductRow(
        "123456789",
        {
          title: " Mouse ",
          price: "29,900원",
          rating: "4.8",
          review_count: "1,234",
          seller: "Coupang",
        },
        "https://www.coupang.com/vp/products/123456789",
      ),
    ).toMatchObject({
      product_id: "123456789",
      title: "Mouse",
      price: 29900,
      rating: 4.8,
      review_count: 1234,
      seller: "Coupang",
      url: "https://www.coupang.com/vp/products/123456789",
    });
  });

  it("extracts Coupang product details", async () => {
    const command = resolveCommand("coupang", "product")?.command;
    const page = pageMock([
      {
        ok: true,
        currentProductId: "123456789",
        loginHints: { hasLoginLink: false, hasMyCoupang: false },
        data: {
          product_id: "123456789",
          title: "Mouse",
          price: 29900,
          rating: 4.8,
          review_count: 1234,
          seller: "Coupang",
        },
      },
    ]);
    await expect(
      command!.func!(page, { "product-id": "123456789" }),
    ).resolves.toEqual([
      {
        product_id: "123456789",
        title: "Mouse",
        price: 29900,
        original_price: null,
        discount_rate: null,
        rating: 4.8,
        review_count: 1234,
        seller: "Coupang",
        brand: null,
        rocket: null,
        delivery_promise: null,
        image_url: null,
        url: "https://www.coupang.com/vp/products/123456789",
      },
    ]);
    expect(page.goto).toHaveBeenCalledWith(
      "https://www.coupang.com/vp/products/123456789",
      { waitUntil: "load", settleMs: 3000 },
    );
    expect(page.wait).toHaveBeenCalledWith(2);
  });

  it("fails before navigation on malformed ids", async () => {
    const command = resolveCommand("coupang", "product")?.command;
    const page = pageMock([]);
    await expect(command!.func!(page, { "product-id": "abc" })).rejects.toThrow(
      "Coupang product-id",
    );
    expect(page.goto).not.toHaveBeenCalled();
  });
});
