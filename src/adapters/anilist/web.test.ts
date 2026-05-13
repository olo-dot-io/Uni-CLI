import { describe, expect, it } from "vitest";
import { resolveCommand } from "../../registry.js";
import { mapAniListMedia, mapAniListNamed } from "./web.js";

describe("anilist public commands", () => {
  it("registers anime, manga, and entity commands", () => {
    expect(
      Object.keys(resolveCommand("anilist", "anime")!.adapter.commands),
    ).toEqual(
      expect.arrayContaining([
        "anime",
        "manga",
        "characters",
        "staff",
        "studios",
      ]),
    );
  });

  it("maps media rows", () => {
    expect(
      mapAniListMedia([
        {
          id: 102662,
          title: { romaji: "Hanabi", native: "花火" },
          type: "ANIME",
          format: "MUSIC",
          status: "FINISHED",
          averageScore: 56,
          popularity: 1059,
          siteUrl: "https://anilist.co/anime/102662",
        },
      ]),
    ).toMatchObject([
      {
        rank: 1,
        id: 102662,
        title: "Hanabi",
        native: "花火",
        type: "ANIME",
        url: "https://anilist.co/anime/102662",
      },
    ]);
  });

  it("maps named rows", () => {
    expect(
      mapAniListNamed(
        [
          {
            id: 1,
            name: { full: "Yuzusoft", native: "" },
            favourites: 9,
            siteUrl: "https://anilist.co/studio/1",
          },
        ],
        "studios",
      ),
    ).toMatchObject([{ rank: 1, id: 1, kind: "studios", name: "Yuzusoft" }]);
  });
});
