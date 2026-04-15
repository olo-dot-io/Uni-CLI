import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("zhihu trending", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("zhihu", "trending");
    expectAdapterShape(output, {
      columns: ["rank", "title", "heat", "excerpt", "url"],
      minItems: 1,
    });
  });
});
