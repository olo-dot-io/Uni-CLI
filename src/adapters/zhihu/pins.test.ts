import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("zhihu pins", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("zhihu", "pins");
    expectAdapterShape(output, {
      columns: ["rank", "content", "likes", "comments", "created"],
      minItems: 1,
    });
  });
});
