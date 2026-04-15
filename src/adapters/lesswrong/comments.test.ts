import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("lesswrong comments", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("lesswrong", "comments");
    expectAdapterShape(output, {
      columns: ["rank", "score", "author", "text"],
      minItems: 1,
    });
  });
});
