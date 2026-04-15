import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("lesswrong tags", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("lesswrong", "tags");
    expectAdapterShape(output, {
      columns: ["rank", "name", "posts"],
      minItems: 1,
    });
  });
});
