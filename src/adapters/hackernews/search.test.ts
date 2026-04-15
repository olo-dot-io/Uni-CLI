import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("hackernews search", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("hackernews", "search");
    expectAdapterShape(output, {
      columns: ["rank", "title", "score", "author", "comments"],
      minItems: 1,
    });
  });
});
