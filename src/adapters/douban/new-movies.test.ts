import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("douban new-movies", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("douban", "new-movies");
    expectAdapterShape(output, {
      columns: ["rank", "title", "rate", "url"],
      minItems: 1,
    });
  });
});
