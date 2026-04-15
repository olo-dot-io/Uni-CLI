import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("bilibili trending", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("bilibili", "trending");
    expectAdapterShape(output, {
      columns: ["rank", "keyword", "icon"],
      minItems: 1,
    });
  });
});
