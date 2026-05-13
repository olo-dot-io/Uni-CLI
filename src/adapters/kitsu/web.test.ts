import { describe, expect, it } from "vitest";
import { resolveCommand } from "../../registry.js";
import { mapKitsuMedia } from "./web.js";

describe("kitsu public commands", () => {
  it("registers anime and manga commands", () => {
    expect(
      Object.keys(resolveCommand("kitsu", "anime")!.adapter.commands),
    ).toEqual(expect.arrayContaining(["anime", "manga"]));
  });

  it("maps media rows", () => {
    expect(
      mapKitsuMedia([
        {
          id: "12794",
          type: "anime",
          attributes: {
            canonicalTitle: "Fireworks",
            slug: "uchiage-hanabi",
            subtype: "movie",
          },
        },
      ]),
    ).toMatchObject([
      { rank: 1, id: "12794", title: "Fireworks", subtype: "movie" },
    ]);
  });
});
