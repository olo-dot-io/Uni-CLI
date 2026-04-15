import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("douban movie-hot", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("douban", "movie-hot");
    expectAdapterShape(output, {
      columns: ["title", "rate", "url"],
      minItems: 1,
    });
  });
});
