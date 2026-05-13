import { describe, expect, it } from "vitest";
import { resolveCommand } from "../../registry.js";
import { mapMangaDexAuthors, mapMangaDexManga } from "./web.js";

describe("mangadex public commands", () => {
  it("registers manga and author search", () => {
    expect(
      Object.keys(resolveCommand("mangadex", "manga")!.adapter.commands),
    ).toEqual(expect.arrayContaining(["manga", "authors"]));
  });

  it("exposes year, sort, and content rating controls for recent manga lookup", () => {
    expect(resolveCommand("mangadex", "manga")!.command.adapterArgs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "year", type: "int" }),
        expect.objectContaining({
          name: "sort",
          choices: expect.arrayContaining(["latest", "followed", "relevance"]),
        }),
        expect.objectContaining({
          name: "content-rating",
          choices: expect.arrayContaining(["safe", "suggestive", "erotica"]),
        }),
      ]),
    );
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
