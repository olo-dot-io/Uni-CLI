import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("zhihu columns", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("zhihu", "columns");
    expectAdapterShape(output, {
      columns: ["rank", "title", "author", "voteup", "comments", "url"],
      minItems: 1,
    });
  });
});
