import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("zhihu answers", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("zhihu", "answers");
    expectAdapterShape(output, {
      columns: ["rank", "question", "excerpt", "voteup", "comments"],
      minItems: 1,
    });
  });
});
