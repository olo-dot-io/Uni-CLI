import { describe, expect, it } from "vitest";
import { resolveCommand } from "../../registry.js";
import { mapJikanRows } from "./web.js";

describe("jikan public commands", () => {
  it("registers MAL search surfaces", () => {
    expect(
      Object.keys(resolveCommand("jikan", "anime")!.adapter.commands),
    ).toEqual(
      expect.arrayContaining(["anime", "manga", "characters", "people"]),
    );
  });

  it("exposes year and sort controls for 2024-2026 media lookup", () => {
    expect(resolveCommand("jikan", "anime")!.command.adapterArgs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "year", type: "int" }),
        expect.objectContaining({
          name: "sort",
          choices: expect.arrayContaining(["score", "popularity", "recent"]),
        }),
      ]),
    );
  });

  it("maps rows", () => {
    expect(
      mapJikanRows(
        [
          {
            mal_id: 141632,
            name: "Hanabi",
            name_kanji: "花火",
            favorites: 10,
            url: "https://myanimelist.net/character/141632/Hanabi",
          },
        ],
        "characters",
      ),
    ).toMatchObject([
      {
        rank: 1,
        id: 141632,
        kind: "characters",
        title: "Hanabi",
        title_japanese: "花火",
      },
    ]);
  });
});
