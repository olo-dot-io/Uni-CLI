import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("juejin search", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("juejin", "search", {
      args: { query: "Anthropic" },
    });
    expectAdapterShape(output, {
      columns: [
        "rank",
        "title",
        "excerpt",
        "author",
        "company",
        "views",
        "diggs",
        "comments",
        "url",
      ],
      minItems: 1,
    });
  });
});
