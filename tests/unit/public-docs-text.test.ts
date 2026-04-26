import { describe, expect, it } from "vitest";
import { publicEnglishDescription } from "../../scripts/public-docs-text.js";

describe("publicEnglishDescription", () => {
  it("preserves normal English domains and file names", () => {
    expect(
      publicEnglishDescription(
        "1688.com product detail page for agent.py and .blend files",
        "fallback",
      ),
    ).toBe("1688.com product detail page for agent.py and .blend files");
  });

  it("keeps English text inside mixed parentheticals", () => {
    expect(
      publicEnglishDescription(
        "Current weather from QWeather (和风天气, free tier)",
        "fallback",
      ),
    ).toBe("Current weather from QWeather (free tier)");
  });

  it("removes parentheticals that only contain CJK text", () => {
    expect(
      publicEnglishDescription(
        "Zsxq (知识星球) group topics/posts",
        "fallback",
      ),
    ).toBe("Zsxq group topics/posts");
  });

  it("trims CJK suffixes without breaking English punctuation", () => {
    expect(
      publicEnglishDescription(
        "Dump visible text from the app via CDP DOM. 读取桌面版可见文本。",
        "fallback",
      ),
    ).toBe("Dump visible text from the app via CDP DOM.");
  });

  it("falls back when the description starts with CJK text", () => {
    expect(publicEnglishDescription("读取桌面版可见文本。", "dump")).toBe(
      "dump",
    );
  });

  it("normalizes fullwidth separators before trimming CJK suffixes", () => {
    expect(publicEnglishDescription("Open app：打开应用", "fallback")).toBe(
      "Open app",
    );
  });
});
