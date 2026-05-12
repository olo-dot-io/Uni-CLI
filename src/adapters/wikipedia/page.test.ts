import { describe, expect, it } from "vitest";
import {
  mapWikipediaPageRow,
  requireParagraphCap,
  requireWikiLang,
  requireWikiTitle,
} from "./page.js";

describe("wikipedia agent-facing page command", () => {
  it("validates title, language, and paragraph cap", () => {
    expect(requireWikiTitle(" Transformer ")).toBe("Transformer");
    expect(() => requireWikiTitle("")).toThrow("cannot be empty");
    expect(requireWikiLang("ZH-Hans")).toBe("zh-hans");
    expect(() => requireWikiLang("english")).toThrow("language code");
    expect(requireParagraphCap(undefined)).toBe(0);
    expect(requireParagraphCap("2")).toBe(2);
    expect(() => requireParagraphCap("-1")).toThrow("non-negative");
  });

  it("maps full extract with optional paragraph cap", () => {
    expect(
      mapWikipediaPageRow(
        {
          title: "Transformer",
          description: "ML model",
          pageid: 123,
          extract: "Para one.\n\nPara two.\n\nPara three.",
          fullurl: "https://en.wikipedia.org/wiki/Transformer",
        },
        "en",
        "Transformer",
        2,
      ),
    ).toEqual({
      title: "Transformer",
      description: "ML model",
      pageId: 123,
      paragraphs: 2,
      extract: "Para one.\n\nPara two.",
      url: "https://en.wikipedia.org/wiki/Transformer",
    });
    expect(() =>
      mapWikipediaPageRow({ missing: true }, "en", "Missing", 0),
    ).toThrow("No Wikipedia article");
    expect(() =>
      mapWikipediaPageRow({ title: "Empty", extract: "" }, "en", "Empty", 0),
    ).toThrow("no plain-text extract");
  });
});
