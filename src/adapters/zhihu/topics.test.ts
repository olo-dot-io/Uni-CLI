import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("zhihu topics", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("zhihu", "topics");
    expectAdapterShape(output, {
      columns: ["type", "title", "author", "excerpt", "voteup"],
      minItems: 1,
    });
  });
});
