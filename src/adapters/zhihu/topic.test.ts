import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("zhihu topic", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("zhihu", "topic");
    expectAdapterShape(output, {
      columns: ["title", "author", "voteup", "excerpt"],
      minItems: 1,
    });
  });
});
