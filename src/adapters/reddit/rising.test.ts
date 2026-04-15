import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("reddit rising", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("reddit", "rising");
    expectAdapterShape(output, {
      columns: ["title", "author", "subreddit", "score", "comments"],
      minItems: 1,
    });
  });
});
