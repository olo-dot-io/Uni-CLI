import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("zhihu search", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("zhihu", "search");
    expectAdapterShape(output, {
      columns: ["type", "title", "excerpt", "voteup", "author"],
      minItems: 1,
    });
  });
});
