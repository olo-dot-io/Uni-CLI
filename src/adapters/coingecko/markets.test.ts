import { describe, expect, it } from "vitest";
import {
  mapCategoryRows,
  mapCoinRow,
  mapDerivativeRows,
  mapExchangeRows,
  mapGlobalRow,
  mapTopRows,
  mapTrendingRows,
  requireCoinGeckoCurrency,
  requireCoinGeckoLimit,
} from "./markets.js";

describe("coingecko agent-facing market commands", () => {
  it("validates shared arguments", () => {
    expect(requireCoinGeckoCurrency(" CNY ")).toBe("cny");
    expect(() => requireCoinGeckoCurrency("$$$")).toThrow("currency");
    expect(requireCoinGeckoLimit(undefined, 20, 100)).toBe(20);
    expect(requireCoinGeckoLimit("100", 20, 100)).toBe(100);
    expect(() => requireCoinGeckoLimit("0", 20, 100)).toThrow(
      "coingecko limit must",
    );
  });

  it("maps coin market detail rows", () => {
    expect(
      mapCoinRow(
        {
          id: "bitcoin",
          symbol: "btc",
          name: "Bitcoin",
          market_cap_rank: 1,
          genesis_date: "2009-01-03",
          links: { homepage: ["https://bitcoin.org"] },
          market_data: {
            current_price: { cny: 7 },
            market_cap: { cny: 8 },
            total_volume: { cny: 9 },
            price_change_percentage_24h: 1.23,
            ath: { cny: 10 },
            ath_date: { cny: "2024-01-02T00:00:00Z" },
            atl: { cny: 1 },
            atl_date: { cny: "2015-01-14T00:00:00Z" },
            circulating_supply: 19,
          },
        },
        "cny",
      ),
    ).toMatchObject({
      id: "bitcoin",
      symbol: "BTC",
      rank: 1,
      price: 7,
      marketCap: 8,
      volume24h: 9,
      athDate: "2024-01-02",
      homepage: "https://bitcoin.org",
    });
    expect(() => mapCoinRow({ market_data: {} }, "zzz")).toThrow(
      "no market data",
    );
  });

  it("maps list-style market rows", () => {
    expect(
      mapTopRows([
        {
          market_cap_rank: 1,
          symbol: "eth",
          name: "Ethereum",
          current_price: 2,
          price_change_percentage_24h: 3,
          market_cap: 4,
          total_volume: 5,
          high_24h: 6,
          low_24h: 1,
        },
      ]),
    ).toEqual([
      {
        rank: 1,
        symbol: "ETH",
        name: "Ethereum",
        price: 2,
        change24hPct: 3,
        marketCap: 4,
        volume24h: 5,
        high24h: 6,
        low24h: 1,
      },
    ]);
    expect(
      mapTrendingRows([
        { item: { id: "btc", symbol: "btc", name: "Bitcoin", price_btc: 1 } },
      ]),
    ).toMatchObject([{ rank: 1, id: "btc", symbol: "BTC" }]);
  });

  it("maps category, exchange, derivative, and global rows", () => {
    expect(
      mapCategoryRows(
        [
          {
            id: "layer-1",
            name: "Layer 1",
            market_cap: 1,
            volume_24h: 2,
            market_cap_change_24h: 3,
            top_3_coins_id: ["btc", "eth"],
          },
        ],
        20,
      ),
    ).toMatchObject([{ rank: 1, top3Coins: "btc, eth" }]);
    expect(
      mapExchangeRows(
        [
          {
            id: "binance",
            name: "Binance",
            trust_score: 10,
            trade_volume_24h_btc: 100,
          },
        ],
        2,
        20,
      ),
    ).toMatchObject([{ rank: 21, id: "binance", trustScore: 10 }]);
    expect(
      mapDerivativeRows(
        [{ market: "Binance", symbol: "BTCUSDT", price: "1", volume_24h: "2" }],
        10,
        "btc",
      ),
    ).toMatchObject([{ rank: 1, symbol: "BTCUSDT", volume24hUsd: 2 }]);
    expect(
      mapGlobalRow(
        {
          data: {
            total_market_cap: { usd: 100 },
            total_volume: { usd: 10 },
            market_cap_percentage: { btc: 50, eth: 20 },
            active_cryptocurrencies: 1000,
            updated_at: 1,
          },
        },
        "usd",
      ),
    ).toMatchObject({
      currency: "USD",
      totalMarketCap: 100,
      btcDominancePct: 50,
      updatedAt: "1970-01-01T00:00:01.000Z",
    });
  });
});
