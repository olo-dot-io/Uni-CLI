import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("hackernews comments", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("hackernews", "comments");
    expectAdapterShape(output, {
      columns: ["author", "text", "replies", "time"],
      minItems: 1,
    });
  });
});
