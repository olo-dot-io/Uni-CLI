import { describe, expect, it } from "vitest";
import { resolveCommand } from "../../registry.js";
import { mapBangumiSubject, mapBangumiSubjects } from "./web.js";

describe("bangumi public commands", () => {
  it("registers subject commands", () => {
    expect(
      Object.keys(resolveCommand("bangumi", "anime")!.adapter.commands),
    ).toEqual(expect.arrayContaining(["anime", "book", "game", "subject"]));
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
});
