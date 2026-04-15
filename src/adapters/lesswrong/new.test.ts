import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("lesswrong new", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("lesswrong", "new");
    expectAdapterShape(output, {
      columns: ["rank", "title", "author", "karma", "comments", "url"],
      minItems: 1,
    });
  });
});
