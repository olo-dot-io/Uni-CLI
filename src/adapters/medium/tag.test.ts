import { describe, expect, it } from "vitest";
import {
  decodeMediumHtml,
  extractMediumCategories,
  mediumRssDate,
  parseMediumTagRss,
  requireMediumLimit,
  requireMediumTag,
  stripMediumHtml,
} from "./tag.js";

describe("medium agent-facing tag command", () => {
  it("validates tag slugs and limits", () => {
    expect(requireMediumTag(" Machine-Learning ")).toBe("machine-learning");
    expect(() => requireMediumTag("bad/tag")).toThrow("not valid");
    expect(requireMediumLimit(undefined)).toBe(20);
    expect(requireMediumLimit("25")).toBe(25);
    expect(() => requireMediumLimit("26")).toThrow("[1, 25]");
  });

  it("decodes and strips Medium RSS text", () => {
    expect(decodeMediumHtml("A&#39;s &lt;B&gt; &amp; C")).toBe("A's <B> & C");
    expect(stripMediumHtml("<p>Hello&nbsp;<strong>world</strong></p>")).toBe(
      "Hello world",
    );
    expect(mediumRssDate("Tue, 12 May 2026 01:02:03 GMT")).toBe("2026-05-12");
    expect(mediumRssDate("not a date")).toBe("");
  });

  it("parses RSS items into stable columns", () => {
    const xml = `
      <rss><channel>
        <item>
          <title><![CDATA[AI &amp; Agents]]></title>
          <dc:creator><![CDATA[Jane Doe]]></dc:creator>
          <description><![CDATA[<p>Readable <a href="https://x.test">summary</a></p>]]></description>
          <category><![CDATA[AI]]></category>
          <category>Programming</category>
          <pubDate>Tue, 12 May 2026 01:02:03 GMT</pubDate>
          <link>https://medium.com/p/example</link>
        </item>
      </channel></rss>
    `;

    expect(extractMediumCategories(xml)).toEqual(["AI", "Programming"]);
    expect(parseMediumTagRss(xml, 20)).toEqual([
      {
        rank: 1,
        title: "AI & Agents",
        author: "Jane Doe",
        description: "Readable summary",
        categories: "AI, Programming",
        published: "2026-05-12",
        url: "https://medium.com/p/example",
      },
    ]);
  });

  it("rejects empty RSS feeds", () => {
    expect(() => parseMediumTagRss("<rss><channel /></rss>", 20)).toThrow(
      "no items",
    );
  });
});
