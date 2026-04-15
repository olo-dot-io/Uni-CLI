import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("lesswrong read", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("lesswrong", "read");
    expectAdapterShape(output, {
      columns: [
        "title",
        "author",
        "karma",
        "comments",
        "tags",
        "content",
        "url",
      ],
      minItems: 1,
    });
  });
});
