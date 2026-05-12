import { describe, expect, it } from "vitest";
import {
  mapDefillamaDetailRow,
  mapDefillamaProtocolRows,
  requireDefillamaLimit,
  requireDefillamaSlug,
  unixToDate,
} from "./protocols.js";

describe("defillama agent-facing protocol commands", () => {
  it("validates limits and slugs", () => {
    expect(requireDefillamaLimit(undefined)).toBe(30);
    expect(requireDefillamaLimit("500")).toBe(500);
    expect(() => requireDefillamaLimit("501")).toThrow("defillama limit must");
    expect(requireDefillamaSlug("aave-v3")).toBe("aave-v3");
    expect(() => requireDefillamaSlug("../aave")).toThrow("not valid");
  });

  it("normalizes unix timestamps", () => {
    expect(unixToDate(1)).toBe("1970-01-01");
    expect(unixToDate(null)).toBeNull();
  });

  it("maps protocol list rows sorted by TVL", () => {
    expect(
      mapDefillamaProtocolRows(
        [
          { slug: "small", name: "Small", tvl: 1 },
          {
            slug: "large",
            name: "Large",
            category: "Lending",
            tvl: "10",
            chains: ["Ethereum"],
          },
        ],
        2,
      ),
    ).toMatchObject([
      {
        rank: 1,
        slug: "large",
        name: "Large",
        category: "Lending",
        tvl: 10,
        chains: "Ethereum",
      },
      { rank: 2, slug: "small", tvl: 1 },
    ]);
  });

  it("maps protocol detail rows with list metadata", () => {
    expect(
      mapDefillamaDetailRow(
        "aave",
        {
          name: "Aave",
          tvl: [{ date: 1, totalLiquidityUSD: "100" }],
          chains: ["Ethereum"],
          github: ["aave/protocol-v2"],
          twitter: "aave",
          url: "https://aave.com",
        },
        [{ slug: "aave", category: "Lending", chains: ["Polygon"] }],
      ),
    ).toMatchObject({
      slug: "aave",
      name: "Aave",
      category: "Lending",
      tvl: 100,
      chains: "Ethereum, Polygon",
      github: "aave/protocol-v2",
    });
  });
});
