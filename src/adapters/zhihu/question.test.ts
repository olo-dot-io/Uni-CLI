import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("zhihu question", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("zhihu", "question");
    expectAdapterShape(output, {
      columns: ["author", "content", "voteup", "comments"],
      minItems: 1,
    });
  });
});
