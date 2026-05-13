import { describe, expect, it } from "vitest";
import { resolveCommand } from "../../registry.js";
import {
  decodeDlsiteHtml,
  dlsiteCreatorUrl,
  dlsiteGenreUrl,
  dlsiteMakerUrl,
  dlsiteSearchUrl,
  parseDlsiteDetailHtml,
  parseDlsiteSearchHtml,
} from "./web.js";

describe("dlsite public commands", () => {
  it("registers search, type shortcuts, and detail", () => {
    expect(
      Object.keys(resolveCommand("dlsite", "search")!.adapter.commands),
    ).toEqual(
      expect.arrayContaining([
        "search",
        "manga",
        "cg",
        "game",
        "maker",
        "creator",
        "genre",
        "work",
      ]),
    );
  });

  it("builds search URLs with sort and work type filters", () => {
    expect(
      dlsiteSearchUrl({
        query: "花火",
        sort: "hot",
        type: "cg",
        page: 2,
      }),
    ).toBe(
      "https://www.dlsite.com/maniax/fsr/=/work_type/ICG/keyword/%E8%8A%B1%E7%81%AB/order/dl_d/page/2",
    );
    expect(
      dlsiteMakerUrl({ maker_id: "RG01012594", sort: "hot", page: 1 }),
    ).toBe(
      "https://www.dlsite.com/maniax/circle/profile/=/page/1/maker_id/RG01012594.html/order/dl_d",
    );
    expect(dlsiteCreatorUrl({ creator: "わかなはなび" })).toBe(
      "https://www.dlsite.com/maniax/fsr/=/keyword_creater/%22%E3%82%8F%E3%81%8B%E3%81%AA%E3%81%AF%E3%81%AA%E3%81%B3%22/ana_flg/all/order/release/page/1",
    );
    expect(dlsiteGenreUrl({ genre: "001", sort: "rating" })).toBe(
      "https://www.dlsite.com/maniax/fsr/=/genre/001/order/rate/page/1",
    );
  });

  it("parses search result cards", () => {
    const rows = parseDlsiteSearchHtml(
      `<div data-list_item_product_id="RJ005751" class="search_result_img_box_inner">
        <thumb-with-ng-filter-block link="https://www.dlsite.com/maniax/work/=/product_id/RJ005751.html"
          :thumb-candidates="['//img.dlsite.jp/resize/images2/work/doujin/RJ006000/RJ005751_img_main_240x240.webp']"></thumb-with-ng-filter-block>
        <dd class="work_category_free_sample"><div class="work_category type_MNG"><a>マンガ</a></div></dd>
        <dd class="work_name"><div><a href="https://www.dlsite.com/maniax/work/=/product_id/RJ005751.html" title="Komm.susser Tod.">Komm.susser Tod.</a></div></dd>
        <dd class="maker_name"><a>スタジオきゃうん</a></dd>
        <span class="work_price_base">770</span>
        <dd class="work_genre"><span class="icon_ADL" title="R18">R18</span></dd>
        <dd class="work_dl">販売数:&nbsp;<span>745</span></dd>
        <dd class="work_rating"><div class="star_rating star_40 mini">(327)</div></dd>
      </div>`,
      5,
    );
    expect(rows).toEqual([
      {
        rank: 1,
        product_id: "RJ005751",
        title: "Komm.susser Tod.",
        maker: "スタジオきゃうん",
        work_type: "マンガ",
        age: "R18",
        price_jpy: "770",
        sales: "745",
        rating: "star_40",
        reviews: "327",
        thumb:
          "https://img.dlsite.jp/resize/images2/work/doujin/RJ006000/RJ005751_img_main_240x240.webp",
        url: "https://www.dlsite.com/maniax/work/=/product_id/RJ005751.html",
      },
    ]);
  });

  it("parses detail page metadata", () => {
    expect(
      parseDlsiteDetailHtml(
        `<meta property="og:image" content="https://img.dlsite.jp/main.jpg">
         <h1 itemprop="name" id="work_name">Komm.susser Tod.</h1>
         <span itemprop="brand" class="maker_name"><a>スタジオきゃうん</a></span>
         <table id="work_outline"><tr><th>販売日</th><td>2001年10月02日</td></tr>
         <tr><th>作品形式</th><td><span title="マンガ">マンガ</span></td></tr>
         <tr><th>ページ数</th><td>36ページ</td></tr></table>
         <div hidden class="ga4_event_item_RJ005751" data-product_id="RJ005751" data-maker_id="RG01444" data-work_type="MNG" data-price="770"></div>`,
        "RJ005751",
      ),
    ).toMatchObject({
      product_id: "RJ005751",
      title: "Komm.susser Tod.",
      maker: "スタジオきゃうん",
      maker_id: "RG01444",
      work_type: "MNG",
      release_date: "2001年10月02日",
      pages: "36ページ",
      price_jpy: "770",
      image: "https://img.dlsite.jp/main.jpg",
    });
    expect(decodeDlsiteHtml("A &amp; B<br>C")).toBe("A & B C");
  });
});
