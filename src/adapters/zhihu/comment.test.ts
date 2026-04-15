import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("zhihu comment", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("zhihu", "comment");
    expectAdapterShape(output, {
      columns: ["author", "content", "likes", "replies", "created"],
      minItems: 1,
    });
  });
});
