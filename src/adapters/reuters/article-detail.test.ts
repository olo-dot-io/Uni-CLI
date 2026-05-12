import { describe, expect, it } from "vitest";
import {
  extractReutersBody,
  mapReutersArticleDetail,
  requireReutersArticleUrl,
  reutersPathFromUrl,
} from "./article-detail.js";

describe("reuters agent-facing article-detail command", () => {
  it("validates Reuters URLs and extracts API URL paths", () => {
    const url =
      "https://www.reuters.com/world/us/fed-chair-says-rates-2026-05-12/?utm_source=x";
    expect(requireReutersArticleUrl(` ${url} `)).toBe(url);
    expect(reutersPathFromUrl(url)).toBe(
      "/world/us/fed-chair-says-rates-2026-05-12/?utm_source=x",
    );
    expect(() => requireReutersArticleUrl("https://example.com/a")).toThrow(
      "reuters.com",
    );
  });

  it("maps article metadata and body to stable columns", () => {
    expect(
      mapReutersArticleDetail(
        {
          title: "Fed chair says rates hold",
          display_date: "2026-05-12T01:02:03Z",
          taxonomy: { section: { name: "Markets", path: "/markets/" } },
          authors: [{ name: "Jane Doe" }, { byline: "John Roe" }],
          description: { basic: "Short summary" },
          word_count: 450,
          canonical_url: "/markets/rates-2026-05-12/",
          content_elements: [
            { type: "text", content: "First paragraph." },
            { type: "image", content: "ignored" },
            { type: "text", content: "Second paragraph." },
          ],
        },
        "https://www.reuters.com/fallback",
      ),
    ).toEqual({
      title: "Fed chair says rates hold",
      date: "2026-05-12",
      section: "Markets",
      section_path: "/markets/",
      authors: "Jane Doe, John Roe",
      description: "Short summary",
      word_count: 450,
      url: "https://www.reuters.com/markets/rates-2026-05-12/",
      body: "First paragraph.\n\nSecond paragraph.",
    });
  });

  it("extracts only text content elements", () => {
    expect(
      extractReutersBody({
        content_elements: [
          { type: "text", content: "A" },
          { type: "raw_html", content: "<p>B</p>" },
          { type: "text", content: "C" },
        ],
      }),
    ).toBe("A\n\nC");
  });
});
