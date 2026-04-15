import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("bilibili hot", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("bilibili", "hot");
    expectAdapterShape(output, {
      columns: ["rank", "title", "author", "views", "danmaku", "bvid"],
      minItems: 1,
    });
  });
});
