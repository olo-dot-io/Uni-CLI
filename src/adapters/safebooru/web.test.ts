import { describe, expect, it } from "vitest";
import { resolveCommand } from "../../registry.js";
import { mergeSafebooruTags, parseSafebooruTags } from "./web.js";

describe("safebooru tag command", () => {
  it("registers tags command", () => {
    expect(
      Object.keys(resolveCommand("safebooru", "tags")!.adapter.commands),
    ).toEqual(expect.arrayContaining(["tags"]));
  });

  it("parses DAPI tag XML", () => {
    expect(
      parseSafebooruTags(
        '<tags><tag type="3" count="108328" name="blue_archive" ambiguous="false" id="1167631"/></tags>',
      ),
    ).toMatchObject([
      {
        rank: 1,
        id: "1167631",
        name: "blue_archive",
        count: "108328",
        type: "3",
        ambiguous: "false",
      },
    ]);
  });

  it("keeps exact tag rows ahead of prefix matches", () => {
    expect(
      mergeSafebooruTags([
        [
          {
            rank: 1,
            id: "1167631",
            name: "blue_archive",
            count: "108328",
            type: "3",
            ambiguous: "false",
            url: "https://safebooru.org/index.php?page=post&s=list&tags=blue_archive",
          },
        ],
        [
          {
            rank: 1,
            id: "33300201",
            name: "blue_archive_2025_hack",
            count: "22",
            type: "0",
            ambiguous: "false",
            url: "https://safebooru.org/index.php?page=post&s=list&tags=blue_archive_2025_hack",
          },
        ],
      ]),
    ).toMatchObject([
      { rank: 1, name: "blue_archive" },
      { rank: 2, name: "blue_archive_2025_hack" },
    ]);
  });
});
