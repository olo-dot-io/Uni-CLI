import { describe, expect, it } from "vitest";
import {
  joinCountryCurrencies,
  joinCountryLanguages,
  mapCountryRows,
  requireRestCountriesLimit,
  requireRestCountriesRegion,
} from "./countries.js";

describe("rest-countries agent-facing commands", () => {
  it("validates region and limit arguments", () => {
    expect(requireRestCountriesRegion(" Asia ")).toBe("asia");
    expect(() => requireRestCountriesRegion("middle-earth")).toThrow(
      "not supported",
    );
    expect(requireRestCountriesLimit(undefined, 25, 250)).toBe(25);
    expect(requireRestCountriesLimit("250", 25, 250)).toBe(250);
    expect(() => requireRestCountriesLimit("251", 25, 250)).toThrow(
      "rest-countries limit must",
    );
  });

  it("joins currencies and languages from REST Countries maps", () => {
    expect(
      joinCountryCurrencies({
        JPY: { name: "Japanese yen", symbol: "yen" },
        USD: {},
      }),
    ).toBe("JPY (Japanese yen), USD");
    expect(joinCountryLanguages({ jpn: "Japanese", eng: "English" })).toBe(
      "Japanese, English",
    );
  });

  it("maps and sorts country rows by population", () => {
    expect(
      mapCountryRows(
        [
          {
            name: { common: "Small", official: "Small State" },
            cca2: "SS",
            cca3: "SML",
            population: 10,
            latlng: [1, 2],
            capital: ["One"],
            timezones: ["UTC"],
            languages: { eng: "English" },
            currencies: { USD: { name: "United States dollar" } },
            independent: true,
            unMember: false,
            landlocked: true,
          },
          {
            name: { common: "Large", official: "Large State" },
            cca2: "LS",
            cca3: "LRG",
            population: "20",
          },
        ],
        2,
      ),
    ).toMatchObject([
      {
        rank: 1,
        commonName: "Large",
        cca3: "LRG",
        population: 20,
        url: "https://restcountries.com/v3.1/alpha/lrg",
      },
      {
        rank: 2,
        commonName: "Small",
        latitude: 1,
        languages: "English",
        currencies: "USD (United States dollar)",
        independent: true,
      },
    ]);
  });
});
