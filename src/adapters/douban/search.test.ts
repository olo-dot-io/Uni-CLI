import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("douban search", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("douban", "search");
    expectAdapterShape(output, {
      columns: ["title", "url", "rating"],
      minItems: 1,
    });
  });
});
