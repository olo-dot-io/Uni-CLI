import { describe, expect, it } from "vitest";
import { resolveCommand } from "../../registry.js";
import {
  buildEhentaiSearchQuery,
  decodeEhentaiHtml,
  ehentaiCategoryMask,
  ehentaiSearchUrl,
  mapEhentaiTorrents,
  parseEhentaiGallery,
  parseEhentaiGalleryPages,
  parseEhentaiSearchHtml,
  requireEhentaiLimit,
} from "./web.js";

describe("ehentai public gallery commands", () => {
  it("registers search, tag, artist, gallery, pages, and torrents", () => {
    expect(
      Object.keys(resolveCommand("ehentai", "search")!.adapter.commands),
    ).toEqual(
      expect.arrayContaining([
        "search",
        "tag",
        "artist",
        "gallery",
        "pages",
        "torrents",
      ]),
    );
  });

  it("builds accurate structured search URLs for category and tag filters", () => {
    expect(ehentaiCategoryMask("artistcg")).toBe(1015);
    expect(ehentaiCategoryMask("cg")).toBe(999);
    expect(ehentaiCategoryMask("manga,doujinshi")).toBe(1017);
    expect(
      buildEhentaiSearchQuery({
        artist: "Tony Taka",
        language: "chinese",
        other: "full color",
      }),
    ).toBe("artist:tony_taka$ language:chinese$ other:full_color$");
    expect(
      buildEhentaiSearchQuery({
        tags: "artist:Tony Taka,language:chinese",
        exact_tags: false,
      }),
    ).toBe("artist:tony_taka language:chinese");
    expect(() => buildEhentaiSearchQuery({ tags: "tony taka" })).toThrow(
      "namespaced",
    );
    expect(
      ehentaiSearchUrl({
        query: "artist:tony_taka$",
        page: 0,
        cursor: "",
        categoryMask: 1015,
        requireTorrent: true,
        includeExpunged: false,
        minPages: "",
        maxPages: "",
        minRating: "",
      }),
    ).toBe(
      "https://e-hentai.org/?f_search=artist%3Atony_taka%24&f_cats=1015&advsearch=1&f_sto=on",
    );
  });

  it("validates gallery identity and limits", () => {
    expect(parseEhentaiGallery("3316027/8c4fbe8822")).toEqual({
      gid: 3316027,
      token: "8c4fbe8822",
      url: "https://e-hentai.org/g/3316027/8c4fbe8822/",
    });
    expect(
      parseEhentaiGallery("https://e-hentai.org/g/3316027/8c4fbe8822/"),
    ).toEqual({
      gid: 3316027,
      token: "8c4fbe8822",
      url: "https://e-hentai.org/g/3316027/8c4fbe8822/",
    });
    expect(() =>
      parseEhentaiGallery("https://example.com/g/1/abcdef1234/"),
    ).toThrow("e-hentai.org");
    expect(requireEhentaiLimit(undefined)).toBe(20);
    expect(() => requireEhentaiLimit(101)).toThrow("integer");
    expect(decodeEhentaiHtml("A &amp; B &#39; C")).toBe("A & B ' C");
  });

  it("parses search rows from compact gallery table markup", () => {
    const rows = parseEhentaiSearchHtml(
      `<table><tr><td class="gl1c glcat"><div class="cn ct9">Non-H</div></td>
        <td class="gl2c"><div><div id="posted_3316027">2025-04-15 08:13</div>
        <div>8 pages</div><a href="https://e-hentai.org/gallerytorrents.php?gid=3316027&amp;t=8c4fbe8822">T</a></div>
        <img alt="thumb" data-src="https://ehgt.org/thumb.webp" /></td>
        <td class="gl3c glname"><a href="https://e-hentai.org/g/3316027/8c4fbe8822/">
        <div class="glink">Copyright free landscape</div><div><div class="gt" title="language:english">english</div></div></a></td>
        <td class="gl4c glhide"><div><a>7qweij</a></div><div>8 pages</div></td></tr></table>`,
      10,
    );
    expect(rows).toEqual([
      {
        rank: 1,
        gid: 3316027,
        token: "8c4fbe8822",
        title: "Copyright free landscape",
        category: "Non-H",
        published: "2025-04-15 08:13",
        pages: "8 pages",
        uploader: "7qweij",
        thumb: "https://ehgt.org/thumb.webp",
        torrent_available: true,
        tags: "language:english",
        url: "https://e-hentai.org/g/3316027/8c4fbe8822/",
      },
    ]);
  });

  it("maps torrent metadata and gallery pages", () => {
    expect(
      mapEhentaiTorrents({
        gid: 3316027,
        title: "Gallery",
        torrents: [
          { hash: "abc", added: "1", name: "g.zip", tsize: "2", fsize: "3" },
        ],
      }),
    ).toEqual([
      {
        rank: 1,
        gid: 3316027,
        title: "Gallery",
        hash: "abc",
        added: "1",
        name: "g.zip",
        tsize: "2",
        fsize: "3",
      },
    ]);
    expect(
      parseEhentaiGalleryPages(
        `<h1 id="gn">Gallery</h1><div id="gdt"><a href="https://e-hentai.org/s/f7ee85eea1/3316027-1"><div title="Page 1: 123.png" style="background:transparent url(https://thumb.webp) -0px 0 no-repeat"></div></a></div>`,
        parseEhentaiGallery("3316027/8c4fbe8822"),
        5,
      ),
    ).toEqual([
      {
        page: 1,
        gid: 3316027,
        title: "Gallery",
        filename: "123.png",
        page_url: "https://e-hentai.org/s/f7ee85eea1/3316027-1",
        thumb_sprite_url: "https://thumb.webp",
        gallery_url: "https://e-hentai.org/g/3316027/8c4fbe8822/",
      },
    ]);
  });
});
