import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("arxiv search", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("arxiv", "search");
    expectAdapterShape(output, {
      columns: ["title", "authors", "published", "id"],
      minItems: 1,
    });
  });
});
