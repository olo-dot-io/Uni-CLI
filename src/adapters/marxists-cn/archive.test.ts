import { describe, expect, it } from "vitest";
import {
  decodeMarxistsBuffer,
  mapMarxistsReadRow,
  marxistsHtmlToText,
  marxistsReadingListRows,
  normalizeMarxistsPath,
  parseMarxistsIndex,
  parseMarxistsWorks,
  requireMarxistsLimit,
} from "./archive.js";

describe("marxists-cn agent-facing archive adapter", () => {
  it("normalizes paths and rejects off-archive URLs", () => {
    expect(normalizeMarxistsPath("marx", { directoryIndex: true })).toBe(
      "marx/index.htm",
    );
    expect(
      normalizeMarxistsPath("https://www.marxists.org/chinese/marx/01.htm#8"),
    ).toBe("marx/01.htm");
    expect(() =>
      normalizeMarxistsPath("https://example.com/chinese/marx/01.htm"),
    ).toThrow("must stay on www.marxists.org");
    expect(() => normalizeMarxistsPath("../index.htm")).toThrow(
      "must stay under /chinese/",
    );
  });

  it("validates bounded integer arguments", () => {
    expect(requireMarxistsLimit(undefined, 20, 100, "limit")).toBe(20);
    expect(requireMarxistsLimit("5", 20, 100, "limit")).toBe(5);
    expect(() => requireMarxistsLimit("0", 20, 100, "limit")).toThrow(
      "marxists-cn limit must",
    );
    expect(() => requireMarxistsLimit("101", 20, 100, "limit")).toThrow(
      "marxists-cn limit must",
    );
  });

  it("parses top-level people and reference links from the Chinese index", () => {
    const rows = parseMarxistsIndex(`
      <a title="马克思 Karl Marx" href="marx/index.htm">
        <img src="images/1-marx.jpg" alt="马克思">
      </a>
      <a href="abc/index.htm">马克思主义简介</a>
      <a href="search/index.html">中文马克思主义文库搜索</a>
    `);

    expect(rows).toEqual([
      {
        title: "马克思",
        latinName: "Karl Marx",
        kind: "directory",
        path: "marx/index.htm",
        url: "https://www.marxists.org/chinese/marx/index.htm",
      },
      {
        title: "马克思主义简介",
        latinName: "",
        kind: "reference",
        path: "abc/index.htm",
        url: "https://www.marxists.org/chinese/abc/index.htm",
      },
      {
        title: "中文马克思主义文库搜索",
        latinName: "",
        kind: "site-meta",
        path: "search/index.html",
        url: "https://www.marxists.org/chinese/search/index.html",
      },
    ]);
  });

  it("parses work links with section, note, and resource format", () => {
    const rows = parseMarxistsWorks(
      `
      <b><font color="#FF0000" size="5">著 作</font></b>
      <a href="01.htm">共产党宣言</a>（1848年）
      <a href="../pdf/marx/texts/3.pdf">马克思：黑格尔法哲学批判</a>
      `,
      "marx/index.htm",
      "https://www.marxists.org/chinese/marx/index.htm",
    );

    expect(rows).toEqual([
      {
        scope: "marx/index.htm",
        section: "著 作",
        title: "共产党宣言",
        note: "（1848年）",
        format: "htm",
        path: "marx/01.htm",
        url: "https://www.marxists.org/chinese/marx/01.htm",
      },
      {
        scope: "marx/index.htm",
        section: "著 作",
        title: "马克思：黑格尔法哲学批判",
        note: "",
        format: "pdf",
        path: "pdf/marx/texts/3.pdf",
        url: "https://www.marxists.org/chinese/pdf/marx/texts/3.pdf",
      },
    ]);
  });

  it("extracts readable article metadata and body text", () => {
    const html = `
      <html>
        <head><title>马克思 恩格斯：共产党宣言（1848年）</title></head>
        <body>
          <p class="title0">共产党宣言</p>
          <p class="author">马克思 恩格斯</p>
          <p class="date">（1848年）</p>
          <script>ignored()</script>
          <h3>一、资产者和无产者</h3>
          &amp;Oslash; 译序<br>
          至今一切社会的历史&nbsp;都是阶级斗争的历史。<br>
          <a href="#note">注释</a>
        </body>
      </html>
    `;

    expect(marxistsHtmlToText(html)).toContain(
      "至今一切社会的历史 都是阶级斗争的历史。",
    );
    expect(marxistsHtmlToText(html)).toContain("Ø 译序");
    expect(
      mapMarxistsReadRow(
        html,
        "https://www.marxists.org/chinese/marx/01.htm",
        500,
      ),
    ).toMatchObject({
      title: "共产党宣言",
      author: "马克思 恩格斯",
      date: "（1848年）",
      url: "https://www.marxists.org/chinese/marx/01.htm",
    });
  });

  it("sniffs UTF-8 pages without forcing GB18030", () => {
    const html = '<meta charset="UTF-8">中文马克思主义文库搜索';
    const bytes = new TextEncoder().encode(html);
    expect(decodeMarxistsBuffer(bytes.buffer)).toContain(
      "中文马克思主义文库搜索",
    );
  });

  it("returns a Western Marxism reading list with directly readable paths", () => {
    const rows = marxistsReadingListRows("western-marxism");

    expect(rows.map((row) => row.author)).toEqual(
      expect.arrayContaining(["葛兰西", "卢卡奇", "科尔施", "阿尔都塞"]),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({
        author: "卢卡奇",
        title: "《历史与阶级意识》",
        path: "georg-lukacs/1922/index.htm",
        readCommand: "unicli marxists-cn read georg-lukacs/1922/index.htm",
      }),
    );
    expect(
      rows.every((row) =>
        row.url.startsWith("https://www.marxists.org/chinese/"),
      ),
    ).toBe(true);
    expect(() => marxistsReadingListRows("unknown")).toThrow(
      "reading-list preset",
    );
  });
});
