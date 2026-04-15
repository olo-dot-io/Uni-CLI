import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("reddit saved", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("reddit", "saved");
    expectAdapterShape(output, {
      columns: ["title", "subreddit", "score", "comments", "url"],
      minItems: 1,
    });
  });
});
