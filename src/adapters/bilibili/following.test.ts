import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("bilibili following", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("bilibili", "following");
    expectAdapterShape(output, {
      columns: ["mid", "name", "sign"],
      minItems: 1,
    });
  });
});
