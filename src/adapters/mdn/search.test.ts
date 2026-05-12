import { describe, expect, it } from "vitest";
import { mapMdnRows, requireMdnLimit, requireMdnLocale } from "./search.js";

describe("mdn agent-facing search command", () => {
  it("validates limit and locale", () => {
    expect(requireMdnLimit(undefined)).toBe(10);
    expect(requireMdnLimit("50")).toBe(50);
    expect(() => requireMdnLimit("0")).toThrow("mdn limit must");
    expect(requireMdnLocale("zh-CN")).toBe("zh-CN");
    expect(() => requireMdnLocale("xx")).toThrow("not supported");
  });

  it("maps MDN search rows", () => {
    expect(
      mapMdnRows(
        [
          {
            title: "Fetch API",
            slug: "Web/API/Fetch_API",
            locale: "",
            summary: "  Promise-based\nHTTP requests. ",
            mdn_url: "/en-US/docs/Web/API/Fetch_API",
          },
        ],
        10,
        "en-US",
      ),
    ).toEqual([
      {
        rank: 1,
        title: "Fetch API",
        slug: "Web/API/Fetch_API",
        locale: "en-US",
        summary: "Promise-based HTTP requests.",
        url: "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API",
      },
    ]);
  });
});
