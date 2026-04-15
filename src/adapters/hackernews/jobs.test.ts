import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("hackernews jobs", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("hackernews", "jobs");
    expectAdapterShape(output, {
      columns: ["rank", "title", "author", "url"],
      minItems: 1,
    });
  });
});
