import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("reddit user-comments", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("reddit", "user-comments");
    expectAdapterShape(output, {
      columns: ["subreddit", "score", "body", "url"],
      minItems: 1,
    });
  });
});
