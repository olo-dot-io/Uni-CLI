import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("zhihu collections", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("zhihu", "collections");
    expectAdapterShape(output, {
      columns: ["rank", "title", "item_count", "follower_count", "id"],
      minItems: 1,
    });
  });
});
