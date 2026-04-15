import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("arxiv paper", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("arxiv", "paper");
    expectAdapterShape(output, {
      columns: ["id", "title", "authors", "published", "abstract", "url"],
      minItems: 1,
    });
  });
});
