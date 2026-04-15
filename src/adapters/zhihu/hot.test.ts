import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("zhihu hot", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("zhihu", "hot");
    expectAdapterShape(output, {
      columns: ["rank", "title", "heat", "answers", "url"],
      minItems: 1,
    });
  });
});
