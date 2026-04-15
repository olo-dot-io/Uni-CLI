import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("reddit new", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("reddit", "new");
    expectAdapterShape(output, {
      columns: ["title", "author", "subreddit", "score", "comments"],
      minItems: 1,
    });
  });
});
