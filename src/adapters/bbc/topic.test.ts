import { describe, expect, it } from "vitest";
import {
  bbcPubDateToIso,
  decodeBbcEntities,
  extractRssTag,
  parseBbcRssItems,
  requireBbcLimit,
  requireBbcTopic,
} from "./topic.js";

describe("bbc agent-facing topic command", () => {
  it("validates topics and limits", () => {
    expect(requireBbcTopic("science-and-environment")).toBe(
      "science_and_environment",
    );
    expect(requireBbcTopic(" Entertainment and Arts ")).toBe(
      "entertainment_and_arts",
    );
    expect(() => requireBbcTopic("sport")).toThrow("not supported");
    expect(requireBbcLimit(undefined)).toBe(20);
    expect(requireBbcLimit("50")).toBe(50);
    expect(() => requireBbcLimit("51")).toThrow("bbc limit");
  });

  it("parses RSS items with CDATA and entities", () => {
    expect(decodeBbcEntities("A &amp; B &#39;C&#39;")).toBe("A & B 'C'");
    const block = "<title><![CDATA[World &amp; News]]></title>";
    expect(extractRssTag(block, "title")).toBe("World &amp; News");
    expect(
      parseBbcRssItems(`
        <rss><channel>
          <item>
            <title><![CDATA[World &amp; News]]></title>
            <description>Summary &lt;one&gt;</description>
            <link>https://www.bbc.com/news/world-1</link>
            <pubDate>Tue, 12 May 2026 10:00:00 GMT</pubDate>
            <guid>guid-1</guid>
          </item>
        </channel></rss>
      `),
    ).toEqual([
      {
        title: "World & News",
        description: "Summary <one>",
        link: "https://www.bbc.com/news/world-1",
        pubDate: "Tue, 12 May 2026 10:00:00 GMT",
        guid: "guid-1",
      },
    ]);
    expect(bbcPubDateToIso("Tue, 12 May 2026 10:00:00 GMT")).toBe("2026-05-12");
  });
});
