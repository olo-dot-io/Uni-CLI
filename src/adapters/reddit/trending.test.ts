import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("reddit trending", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("reddit", "trending");
    expectAdapterShape(output, {
      columns: ["name", "subscribers", "title", "description"],
      minItems: 1,
    });
  });
});
