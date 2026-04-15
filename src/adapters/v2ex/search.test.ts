import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("v2ex search", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("v2ex", "search");
    expectAdapterShape(output, {
      columns: ["title", "node", "author", "replies", "created"],
      minItems: 1,
    });
  });
});
