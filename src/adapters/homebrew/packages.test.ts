import { describe, expect, it } from "vitest";
import {
  mapCaskRow,
  mapFormulaRow,
  mapPopularRows,
  requireHomebrewLimit,
  requireHomebrewToken,
  requirePopularType,
  requirePopularWindow,
} from "./packages.js";

describe("homebrew agent-facing package commands", () => {
  it("validates tokens, limits, and analytics selectors", () => {
    expect(requireHomebrewToken(" gcc@13 ", "formula")).toBe("gcc@13");
    expect(() => requireHomebrewToken("../gcc", "formula")).toThrow(
      "not valid",
    );
    expect(requireHomebrewLimit(undefined, 30)).toBe(30);
    expect(requireHomebrewLimit("500", 30)).toBe(500);
    expect(() => requireHomebrewLimit("501", 30)).toThrow(
      "limit must be an integer",
    );
    expect(requirePopularType("cask")).toBe("cask");
    expect(() => requirePopularType("tap")).toThrow(
      "type must be formula or cask",
    );
    expect(requirePopularWindow("365d")).toBe("365d");
    expect(() => requirePopularWindow("7d")).toThrow("window must be");
  });

  it("maps formula metadata with dependency and source columns", () => {
    expect(
      mapFormulaRow(
        {
          name: "wget",
          tap: "homebrew/core",
          versions: { stable: "1.25.0" },
          license: "GPL-3.0-or-later",
          desc: "Internet file retriever",
          homepage: "https://www.gnu.org/software/wget/",
          dependencies: ["openssl@3", "libidn2"],
          deprecated: false,
          disabled: true,
          urls: { stable: { url: "https://example.test/wget.tar.gz" } },
        },
        "wget",
      ),
    ).toEqual({
      formula: "wget",
      tap: "homebrew/core",
      version: "1.25.0",
      license: "GPL-3.0-or-later",
      description: "Internet file retriever",
      homepage: "https://www.gnu.org/software/wget/",
      dependencies: "openssl@3, libidn2",
      deprecated: false,
      disabled: true,
      source: "https://example.test/wget.tar.gz",
      url: "https://formulae.brew.sh/formula/wget",
    });
  });

  it("maps cask and analytics rows without sentinel output", () => {
    expect(
      mapCaskRow(
        {
          token: "firefox",
          tap: "homebrew/cask",
          name: ["Mozilla Firefox"],
          version: "100",
          desc: "Browser",
          homepage: "https://firefox.com",
          url: "https://example.test/firefox.dmg",
        },
        "firefox",
      ),
    ).toMatchObject({
      cask: "firefox",
      name: "Mozilla Firefox",
      download: "https://example.test/firefox.dmg",
    });

    expect(
      mapPopularRows(
        {
          items: [
            { number: "2", formula: "node", count: "1,234", percent: "12.5" },
          ],
        },
        "formula",
        "30d",
        10,
      ),
    ).toEqual([
      {
        rank: 2,
        token: "node",
        type: "formula",
        installs: 1234,
        percent: 12.5,
        window: "30d",
        url: "https://formulae.brew.sh/formula/node",
      },
    ]);
    expect(() => mapPopularRows({ items: [] }, "cask", "90d", 1)).toThrow(
      "returned no rows",
    );
  });
});
