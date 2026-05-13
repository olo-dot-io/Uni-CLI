import { describe, expect, it } from "vitest";
import { resolveCommand } from "../../registry.js";
import { mapMangaDexAuthors, mapMangaDexManga } from "./web.js";

describe("mangadex public commands", () => {
  it("registers manga and author search", () => {
    expect(
      Object.keys(resolveCommand("mangadex", "manga")!.adapter.commands),
    ).toEqual(expect.arrayContaining(["manga", "authors"]));
  });

  it("maps manga rows", () => {
    expect(
      mapMangaDexManga([
        {
          id: "m1",
          attributes: { title: { en: "Hanabi" }, status: "ongoing" },
        },
      ]),
    ).toMatchObject([
      { rank: 1, id: "m1", title: "Hanabi", status: "ongoing" },
    ]);
  });

  it("maps author rows", () => {
    expect(
      mapMangaDexAuthors([{ id: "a1", attributes: { name: "Yuzusoft" } }]),
    ).toMatchObject([{ rank: 1, id: "a1", name: "Yuzusoft" }]);
  });
});
