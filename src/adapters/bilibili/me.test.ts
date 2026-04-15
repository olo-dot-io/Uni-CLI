import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("bilibili me", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("bilibili", "me");
    expectAdapterShape(output, {
      columns: ["uid", "name", "coins", "level", "vip"],
      minItems: 1,
    });
  });
});
