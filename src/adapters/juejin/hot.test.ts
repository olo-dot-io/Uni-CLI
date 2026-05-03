import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("juejin hot", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("juejin", "hot");
    expectAdapterShape(output, {
      columns: [
        "rank",
        "title",
        "author",
        "company",
        "views",
        "diggs",
        "comments",
        "hot_index",
        "url",
      ],
      minItems: 1,
    });
  });
});
