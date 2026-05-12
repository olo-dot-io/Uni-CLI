import { describe, expect, it } from "vitest";
import {
  decodeSteamHtml,
  mapSteamAppRow,
  requireSteamAppId,
  requireSteamCountryCode,
  steamPriceCents,
} from "./app.js";

describe("steam agent-facing app command", () => {
  it("validates app ids and country codes", () => {
    expect(requireSteamAppId(" 620 ")).toBe("620");
    expect(() => requireSteamAppId("portal")).toThrow("positive integer");
    expect(requireSteamCountryCode(undefined)).toBe("us");
    expect(requireSteamCountryCode(" CN ")).toBe("cn");
    expect(() => requireSteamCountryCode("usa")).toThrow("two-letter");
  });

  it("decodes Steam text and converts cent prices", () => {
    expect(decodeSteamHtml("Portal &amp; Co-op&#39;s Test")).toBe(
      "Portal & Co-op's Test",
    );
    expect(steamPriceCents(999)).toBe(9.99);
    expect(steamPriceCents(null)).toBeNull();
  });

  it("maps Steam appdetails data to stable columns", () => {
    expect(
      mapSteamAppRow("620", {
        steam_appid: 620,
        name: "Portal 2 &amp; Soundtrack",
        type: "game",
        is_free: false,
        release_date: { date: "Apr 18, 2011" },
        developers: ["Valve"],
        publishers: ["Valve"],
        price_overview: { final: 999, currency: "USD" },
        metacritic: { score: 95 },
        recommendations: { total: 450000 },
        genres: [{ description: "Puzzle" }, { description: "Co-op" }],
        categories: [{ description: "Single-player" }, { name: "Steam Cloud" }],
        short_description: "The sequel &amp; test chambers.",
        website: "https://www.thinkwithportals.com/",
      }),
    ).toEqual({
      id: "620",
      name: "Portal 2 & Soundtrack",
      type: "game",
      isFree: false,
      releaseDate: "Apr 18, 2011",
      developers: "Valve",
      publishers: "Valve",
      price: 9.99,
      currency: "USD",
      metacritic: 95,
      recommendations: 450000,
      genres: "Puzzle, Co-op",
      categories: "Single-player, Steam Cloud",
      shortDescription: "The sequel & test chambers.",
      website: "https://www.thinkwithportals.com/",
      url: "https://store.steampowered.com/app/620/",
    });
  });

  it("returns zero price for free apps", () => {
    expect(mapSteamAppRow("10", { is_free: true }).price).toBe(0);
  });
});
