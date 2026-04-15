import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("bilibili dynamic", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("bilibili", "dynamic");
    expectAdapterShape(output, {
      columns: ["type", "author", "text", "timestamp", "id"],
      minItems: 1,
    });
  });
});
