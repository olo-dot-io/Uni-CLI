import { describe, expect, it } from "vitest";
import { resolveCommand } from "../../registry.js";
import {
  mapMoegirlOpenSearch,
  parseMoegirlLinksHtml,
  parseMoegirlPageHtml,
} from "./web.js";

describe("moegirl public commands", () => {
  it("registers search, page, and links", () => {
    expect(
      Object.keys(resolveCommand("moegirl", "search")!.adapter.commands),
    ).toEqual(expect.arrayContaining(["search", "page", "links"]));
  });

  it("maps OpenSearch results", () => {
    expect(
      mapMoegirlOpenSearch(
        [
          "花火",
          ["花火", "花火(星穹铁道)"],
          ["", ""],
          [
            "https://zh.moegirl.org.cn/%E8%8A%B1%E7%81%AB",
            "https://zh.moegirl.org.cn/%E8%8A%B1%E7%81%AB(%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93)",
          ],
        ],
        5,
      ),
    ).toEqual([
      {
        rank: 1,
        title: "花火",
        description: "",
        url: "https://zh.moegirl.org.cn/%E8%8A%B1%E7%81%AB",
      },
      {
        rank: 2,
        title: "花火(星穹铁道)",
        description: "",
        url: "https://zh.moegirl.org.cn/%E8%8A%B1%E7%81%AB(%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93)",
      },
    ]);
  });

  it("parses page text and metadata", () => {
    const row = parseMoegirlPageHtml(
      `<title>花火(星穹铁道) - 萌娘百科 万物皆可萌的百科全书</title>
       <meta name="description" content="花火是游戏《崩坏：星穹铁道》中的登场角色。">
       <link rel="canonical" href="https://zh.moegirl.org.cn/%E8%8A%B1%E7%81%AB(%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93)">
       <script>RLCONF={"wgCategories":["崩坏：星穹铁道角色","游戏角色"]};</script>
       <template id="MOE_SKIN_TEMPLATE_BODYCONTENT"><div class="mw-parser-output">
       <p><b>花火</b>是游戏《崩坏：星穹铁道》中的角色。</p>
       <p>她属于假面愚者。</p></div></template>`,
      "花火(星穹铁道)",
      1,
    );
    expect(row).toMatchObject({
      title: "花火(星穹铁道)",
      description: "花火是游戏《崩坏：星穹铁道》中的登场角色。",
      categories: ["崩坏：星穹铁道角色", "游戏角色"],
      paragraphs: 1,
      url: "https://zh.moegirl.org.cn/%E8%8A%B1%E7%81%AB(%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93)",
    });
    expect(String(row.extract)).toContain("崩坏：星穹铁道");
  });

  it("extracts disambiguation links with contains filter", () => {
    expect(
      parseMoegirlLinksHtml(
        `<template id="MOE_SKIN_TEMPLATE_BODYCONTENT"><div>
          <a href="/%E8%8A%B1%E7%81%AB" title="花火">花火</a>
          <a href="/%E8%8A%B1%E7%81%AB(%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93)" title="花火(星穹铁道)">花火(星穹铁道)</a>
          <a href="/index.php?title=X&amp;action=edit&amp;redlink=1" title="X（页面不存在）">X</a>
        </div></template>`,
        5,
        "星穹铁道",
      ),
    ).toEqual([
      {
        rank: 1,
        title: "花火(星穹铁道)",
        url: "https://zh.moegirl.org.cn/%E8%8A%B1%E7%81%AB(%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93)",
      },
    ]);
  });
});
