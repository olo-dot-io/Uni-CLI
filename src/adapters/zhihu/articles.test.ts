import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("zhihu articles", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("zhihu", "articles");
    expectAdapterShape(output, {
      columns: ["rank", "title", "excerpt", "voteup", "comments"],
      minItems: 1,
    });
  });
});
