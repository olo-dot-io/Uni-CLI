import { describe, expect, it } from "vitest";
import { resolveCommand } from "../../registry.js";
import { mapVndbReleases, mapVndbVisualNovels } from "./web.js";

describe("vndb public commands", () => {
  it("registers core visual novel discovery commands", () => {
    expect(
      Object.keys(resolveCommand("vndb", "search")!.adapter.commands),
    ).toEqual(
      expect.arrayContaining([
        "search",
        "vn",
        "releases",
        "tags",
        "staff",
        "producers",
        "characters",
      ]),
    );
  });

  it("maps visual novel search rows with tags and developers", () => {
    expect(
      mapVndbVisualNovels([
        {
          id: "v57439",
          title: "Hanabi no Sakase Kata",
          alttitle: "花火の咲かせ方",
          released: "2017-12-29",
          languages: ["ja"],
          platforms: ["win"],
          rating: 70,
          votecount: 10,
          image: { url: "https://t.vndb.org/cv/70/112070.jpg" },
          developers: [{ name: "Ultimate Manju" }],
          tags: [
            { name: "Comedy", rating: 1 },
            { name: "ADV", rating: 2 },
          ],
        },
      ]),
    ).toEqual([
      {
        rank: 1,
        id: "v57439",
        title: "Hanabi no Sakase Kata",
        alttitle: "花火の咲かせ方",
        released: "2017-12-29",
        languages: "ja",
        platforms: "win",
        rating: 70,
        votecount: 10,
        developers: "Ultimate Manju",
        tags: "ADV, Comedy",
        image: "https://t.vndb.org/cv/70/112070.jpg",
        url: "https://vndb.org/v57439",
      },
    ]);
  });

  it("maps release rows", () => {
    expect(
      mapVndbReleases([
        {
          id: "r91050",
          title: "U-ena -Toohanabi no Shoujo-",
          released: "TBA",
          platforms: ["win"],
          producers: [{ name: "Hemiola Studio" }],
          vns: [{ title: "U-ena -Toohanabi no Shoujo-" }],
        },
      ]),
    ).toEqual([
      {
        rank: 1,
        id: "r91050",
        title: "U-ena -Toohanabi no Shoujo-",
        released: "TBA",
        platforms: "win",
        producers: "Hemiola Studio",
        vns: "U-ena -Toohanabi no Shoujo-",
        url: "https://vndb.org/r91050",
      },
    ]);
  });
});
