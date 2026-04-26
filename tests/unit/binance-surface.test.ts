import { describe, expect, it } from "vitest";
import { loadAllAdapters } from "../../src/discovery/loader.js";
import { getAdapter } from "../../src/registry.js";

describe("binance adapter surface", () => {
  it("covers public market-data discovery and order-book commands", () => {
    loadAllAdapters();
    const adapter = getAdapter("binance");

    expect(adapter).toBeDefined();
    expect(Object.keys(adapter!.commands).sort()).toEqual([
      "asks",
      "depth",
      "gainers",
      "hot",
      "kline",
      "klines",
      "losers",
      "pairs",
      "price",
      "prices",
      "ticker",
      "top",
      "trades",
    ]);
    expect(adapter!.commands.price.adapterArgs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "symbol",
          positional: true,
          required: true,
        }),
      ]),
    );
    expect(adapter!.commands.depth.adapterArgs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "symbol", required: true }),
        expect.objectContaining({ name: "limit", default: 20 }),
      ]),
    );
  });
});
