import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("bilibili favorites", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("bilibili", "favorites");
    expectAdapterShape(output, {
      columns: ["title", "author", "fav_time", "bvid"],
      minItems: 1,
    });
  });
});
