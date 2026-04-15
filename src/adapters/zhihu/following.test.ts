import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("zhihu following", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("zhihu", "following");
    expectAdapterShape(output, {
      columns: ["rank", "name", "headline", "followers", "answer_count"],
      minItems: 1,
    });
  });
});
