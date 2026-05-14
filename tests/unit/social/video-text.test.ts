import { describe, expect, it } from "vitest";

import { buildYtdlpSubtitleArgs } from "../../../src/social/video-text.js";

describe("video subtitle extraction arguments", () => {
  it("builds yt-dlp subtitle arguments with language and browser-cookie reuse", () => {
    expect(
      buildYtdlpSubtitleArgs({
        url: "https://www.youtube.com/watch?v=abc",
        outputTemplate: "/tmp/unicli/%(id)s.%(ext)s",
        languages: ["zh-Hans", "en"],
        cookiesFromBrowser: "chrome",
      }),
    ).toEqual([
      "--skip-download",
      "--write-sub",
      "--write-auto-sub",
      "--sub-lang",
      "zh-Hans,en",
      "--sub-format",
      "vtt/best",
      "--convert-subs",
      "vtt",
      "--cookies-from-browser",
      "chrome",
      "-o",
      "/tmp/unicli/%(id)s.%(ext)s",
      "https://www.youtube.com/watch?v=abc",
    ]);
  });

  it("rejects empty URLs and empty language lists", () => {
    expect(() =>
      buildYtdlpSubtitleArgs({
        url: "",
        outputTemplate: "/tmp/%(id)s.%(ext)s",
      }),
    ).toThrow("url is required");

    expect(() =>
      buildYtdlpSubtitleArgs({
        url: "https://example.com/video",
        outputTemplate: "/tmp/%(id)s.%(ext)s",
        languages: [],
      }),
    ).toThrow("at least one subtitle language is required");
  });
});
