import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("reddit subreddit", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("reddit", "subreddit");
    expectAdapterShape(output, {
      columns: ["rank", "title", "score", "comments", "author"],
      minItems: 1,
    });
  });
});
