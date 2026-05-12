import { describe, expect, it } from "vitest";
import {
  joinLocalizedAliases,
  mapWikidataEntityRow,
  mapWikidataSearchRows,
  pickLocalizedValue,
  requireWikidataEntityId,
  requireWikidataLanguage,
  requireWikidataLimit,
} from "./entities.js";

describe("wikidata agent-facing entity commands", () => {
  it("validates language, limit, and entity ids", () => {
    expect(requireWikidataLimit(undefined)).toBe(20);
    expect(requireWikidataLimit("50")).toBe(50);
    expect(() => requireWikidataLimit("51")).toThrow("wikidata limit must");
    expect(requireWikidataLanguage("zh-hans")).toBe("zh-hans");
    expect(() => requireWikidataLanguage("english")).toThrow("not valid");
    expect(requireWikidataEntityId("https://www.wikidata.org/wiki/Q937")).toBe(
      "Q937",
    );
    expect(() => requireWikidataEntityId("A1")).toThrow("not valid");
  });

  it("picks localized values and aliases with English fallback", () => {
    expect(
      pickLocalizedValue(
        {
          en: { value: "Albert Einstein" },
          fr: { value: "Albert Einstein FR" },
        },
        "fr",
      ),
    ).toBe("Albert Einstein FR");
    expect(
      joinLocalizedAliases(
        {
          en: [
            { value: "Einstein" },
            { value: "A. Einstein" },
            { value: "third" },
            { value: "fourth" },
            { value: "fifth" },
            { value: "sixth" },
          ],
        },
        "zh",
      ),
    ).toBe("Einstein, A. Einstein, third, fourth, fifth, (+1)");
  });

  it("maps search rows", () => {
    expect(
      mapWikidataSearchRows(
        [
          {
            id: "Q937",
            label: "Albert Einstein",
            description: "German-born physicist",
            match: { type: "label", text: "Albert Einstein" },
          },
        ],
        20,
      ),
    ).toEqual([
      {
        rank: 1,
        qid: "Q937",
        label: "Albert Einstein",
        description: "German-born physicist",
        matchType: "label",
        matchText: "Albert Einstein",
        url: "https://www.wikidata.org/wiki/Q937",
      },
    ]);
  });

  it("maps entity detail rows", () => {
    expect(
      mapWikidataEntityRow(
        "Q937",
        {
          type: "item",
          labels: { en: { value: "Albert Einstein" } },
          descriptions: { en: { value: "German-born physicist" } },
          aliases: { en: [{ value: "Einstein" }] },
          claims: { P31: [], P21: [] },
          sitelinks: { enwiki: { title: "Albert Einstein" }, dewiki: {} },
          modified: "2026-05-12T00:00:00Z",
        },
        "en",
      ),
    ).toMatchObject({
      qid: "Q937",
      type: "item",
      label: "Albert Einstein",
      aliases: "Einstein",
      claimPropertyCount: 2,
      sitelinkCount: 2,
      enwikiTitle: "Albert Einstein",
    });
  });
});
