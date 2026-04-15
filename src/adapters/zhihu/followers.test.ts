import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("zhihu followers", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("zhihu", "followers");
    expectAdapterShape(output, {
      columns: ["rank", "name", "headline", "followers", "answer_count"],
      minItems: 1,
    });
  });
});
