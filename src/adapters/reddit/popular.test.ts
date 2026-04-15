import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("reddit popular", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("reddit", "popular");
    expectAdapterShape(output, {
      columns: ["rank", "title", "subreddit", "score", "comments", "author"],
      minItems: 1,
    });
  });
});
