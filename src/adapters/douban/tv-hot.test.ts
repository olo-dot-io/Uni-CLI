import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("douban tv-hot", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("douban", "tv-hot");
    expectAdapterShape(output, {
      columns: ["rank", "title", "rate", "url"],
      minItems: 1,
    });
  });
});
