import { describe, expect, it, vi } from "vitest";
import { resolveCommand } from "../../registry.js";
import {
  classifyDianpingShopFailure,
  mapDianpingShopFields,
  normalizeDianpingShopId,
  parseDianpingPrice,
  parseDianpingReviewCount,
} from "./shop.js";

function pageMock(evaluateResults: unknown[]) {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(async () => evaluateResults.shift()),
  };
}

describe("dianping shop agent-facing command", () => {
  it("validates shop ids and parses Dianping numbers", () => {
    expect(normalizeDianpingShopId("abc_123-DEF")).toBe("abc_123-DEF");
    expect(
      normalizeDianpingShopId("https://www.dianping.com/shop/abc_123?x=1"),
    ).toBe("abc_123");
    expect(() => normalizeDianpingShopId("")).toThrow("non-empty");
    expect(() => normalizeDianpingShopId("bad/id")).toThrow("shop_id");
    expect(parseDianpingReviewCount("1.2万条")).toBe(12000);
    expect(parseDianpingReviewCount("21241条")).toBe(21241);
    expect(parseDianpingReviewCount("")).toBeNull();
    expect(parseDianpingPrice("人均￥109")).toBe(109);
    expect(parseDianpingPrice("暂无")).toBeNull();
  });

  it("maps shop details to surface field rows", () => {
    expect(
      mapDianpingShopFields(
        "abc_123",
        {
          name: " 芈重山老火锅 ",
          rating: "4.8",
          reviewsRaw: "1.2万条",
          priceRaw: "人均￥109",
          rank: "海淀区重庆火锅口味榜 · 第1名",
          breakdown: { 口味: 4.8, 环境: "4.7", 服务: 4.6, 食材: 4.9 },
          hours: "营业中 11:00-次日02:00",
          address: "北京市海淀区",
          subway: "距地铁五道口站步行300m",
          features: ["可停车", "有包间"],
          url: "https://www.dianping.com/shop/abc_123",
        },
        "https://www.dianping.com/shop/abc_123",
      ),
    ).toEqual([
      { field: "shop_id", value: "abc_123" },
      { field: "name", value: "芈重山老火锅" },
      { field: "rating", value: 4.8 },
      { field: "reviews", value: 12000 },
      { field: "price", value: 109 },
      { field: "rank", value: "海淀区重庆火锅口味榜 · 第1名" },
      { field: "taste", value: 4.8 },
      { field: "environment", value: 4.7 },
      { field: "service", value: 4.6 },
      { field: "ingredients", value: 4.9 },
      { field: "hours", value: "营业中 11:00-次日02:00" },
      { field: "address", value: "北京市海淀区" },
      { field: "subway", value: "距地铁五道口站步行300m" },
      { field: "features", value: "可停车, 有包间" },
      { field: "url", value: "https://www.dianping.com/shop/abc_123" },
    ]);
  });

  it("extracts Dianping shop details", async () => {
    const command = resolveCommand("dianping", "shop")?.command;
    const page = pageMock([
      {
        ok: true,
        name: "芈重山老火锅",
        rating: "4.8",
        reviewsRaw: "21241条",
        priceRaw: "￥109",
        breakdown: { 口味: 4.8 },
        url: "https://www.dianping.com/shop/abc_123",
      },
    ]);
    await expect(command!.func!(page, { shop_id: "abc_123" })).resolves.toEqual(
      expect.arrayContaining([
        { field: "shop_id", value: "abc_123" },
        { field: "name", value: "芈重山老火锅" },
        { field: "rating", value: 4.8 },
        { field: "reviews", value: 21241 },
        { field: "price", value: 109 },
        { field: "taste", value: 4.8 },
      ]),
    );
    expect(page.goto).toHaveBeenCalledWith(
      "https://www.dianping.com/shop/abc_123",
      { waitUntil: "load", settleMs: 3000 },
    );
    expect(page.wait).toHaveBeenCalledWith(3);
  });

  it("fails before navigation on malformed shop ids", async () => {
    const command = resolveCommand("dianping", "shop")?.command;
    const page = pageMock([]);
    await expect(command!.func!(page, { shop_id: "bad/id" })).rejects.toThrow(
      "Dianping shop_id",
    );
    expect(page.goto).not.toHaveBeenCalled();
  });

  it("classifies Dianping auth, captcha, and empty pages", () => {
    expect(() =>
      classifyDianpingShopFailure(
        "美团安全验证 请依次点击",
        "https://verify.meituan.com",
        "abc",
      ),
    ).toThrow("blocked by captcha");
    expect(() =>
      classifyDianpingShopFailure(
        "请先登录",
        "https://login.dianping.com",
        "abc",
      ),
    ).toThrow("requires login");
    expect(() =>
      classifyDianpingShopFailure(
        "商户不存在",
        "https://www.dianping.com/shop/abc",
        "abc",
      ),
    ).toThrow("not found");
  });
});
