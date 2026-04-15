import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("lesswrong sequences", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("lesswrong", "sequences");
    expectAdapterShape(output, {
      columns: ["rank", "title", "author"],
      minItems: 1,
    });
  });
});
