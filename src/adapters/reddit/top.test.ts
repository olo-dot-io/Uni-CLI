import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("reddit top", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("reddit", "top");
    expectAdapterShape(output, {
      columns: ["rank", "title", "subreddit", "score", "comments"],
      minItems: 1,
    });
  });
});
