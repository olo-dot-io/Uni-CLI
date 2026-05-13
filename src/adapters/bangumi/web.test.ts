import { describe, expect, it } from "vitest";
import { resolveCommand } from "../../registry.js";
import {
  bangumiSubjectSearchBody,
  mapBangumiCharacters,
  mapBangumiSubject,
  mapBangumiSubjects,
} from "./web.js";

describe("bangumi public commands", () => {
  it("registers subject commands", () => {
    expect(
      Object.keys(resolveCommand("bangumi", "anime")!.adapter.commands),
    ).toEqual(
      expect.arrayContaining([
        "anime",
        "book",
        "game",
        "subject",
        "characters",
      ]),
    );
  });

  it("exposes year and sort filters on subject commands", () => {
    const args = resolveCommand("bangumi", "game")!.command.adapterArgs;

    expect(args).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "year", type: "int" }),
        expect.objectContaining({
          name: "sort",
          choices: ["match", "rank", "score", "heat"],
        }),
      ]),
    );
  });

  it("builds v0 subject search bodies with type, year, and sort filters", () => {
    expect(
      bangumiSubjectSearchBody("game", {
        query: "学園アイドルマスター",
        year: 2024,
        sort: "rank",
      }),
    ).toEqual({
      keyword: "学園アイドルマスター",
      sort: "rank",
      filter: {
        type: [4],
        air_date: [">=2024-01-01", "<2025-01-01"],
      },
    });
  });

  it("maps search rows", () => {
    expect(
      mapBangumiSubjects([
        {
          id: 344272,
          type: 4,
          name: "PARQUET",
          name_cn: "",
          url: "http://bgm.tv/subject/344272",
        },
      ]),
    ).toMatchObject([{ rank: 1, id: 344272, name: "PARQUET" }]);
  });

  it("maps subject detail", () => {
    expect(
      mapBangumiSubject({
        id: 344272,
        name: "PARQUET",
        platform: "游戏",
        rating: { score: 6.7, total: 200 },
      }),
    ).toMatchObject({
      id: 344272,
      name: "PARQUET",
      platform: "游戏",
      score: 6.7,
    });
  });

  it("maps character rows", () => {
    expect(
      mapBangumiCharacters([
        {
          id: 148287,
          name: "花火",
          gender: "female",
          stat: { comments: 21, collects: 59 },
          summary: "假面愚者",
        },
      ]),
    ).toMatchObject([
      {
        rank: 1,
        id: 148287,
        name: "花火",
        gender: "female",
        comments: 21,
        collects: 59,
        url: "https://bgm.tv/character/148287",
      },
    ]);
  });
});
