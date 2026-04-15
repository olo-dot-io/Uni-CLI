import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("lesswrong shortform", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("lesswrong", "shortform");
    expectAdapterShape(output, {
      columns: ["rank", "title", "author", "karma", "comments", "url"],
      minItems: 1,
    });
  });
});
