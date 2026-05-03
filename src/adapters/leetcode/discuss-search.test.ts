import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("leetcode discuss-search", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture(
      "leetcode",
      "discuss-search",
      {
        args: { query: "Anthropic" },
      },
    );
    expectAdapterShape(output, {
      columns: [
        "rank",
        "title",
        "summary",
        "author",
        "views",
        "created",
        "url",
      ],
      minItems: 1,
    });
  });
});
