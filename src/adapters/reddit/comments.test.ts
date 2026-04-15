import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("reddit comments", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("reddit", "comments");
    expectAdapterShape(output, {
      columns: ["author", "body", "score", "created"],
      minItems: 1,
    });
  });
});
