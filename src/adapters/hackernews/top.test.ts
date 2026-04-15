import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("hackernews top", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("hackernews", "top");
    expectAdapterShape(output, {
      columns: ["rank", "title", "score", "author", "comments"],
      minItems: 1,
    });
  });
});
