import { describe, expect, it } from "vitest";
import { resolveCommand } from "../../registry.js";
import { mapAniListMedia, mapAniListNamed, rerankAniListNamed } from "./web.js";

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

  it("exposes year and sort controls for recent media search", () => {
    expect(resolveCommand("anilist", "anime")!.command.adapterArgs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "year", type: "int" }),
        expect.objectContaining({
          name: "sort",
          choices: expect.arrayContaining(["popular", "trending", "recent"]),
        }),
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

  it("reranks native character matches ahead of popularity-only hits", () => {
    const rows = rerankAniListNamed(
      [
        {
          id: 1,
          name: { full: "Levi", native: "リヴァイ" },
          favourites: 40000,
        },
        {
          id: 2,
          name: { full: "Hanabi Yasuraoka", native: "安楽岡花火" },
          favourites: 1500,
        },
      ],
      "花火",
    );

    expect((rows[0] as { id: number }).id).toBe(2);
  });
});
