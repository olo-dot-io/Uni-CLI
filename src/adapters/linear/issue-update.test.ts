import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("linear issue-update", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("linear", "issue-update");
    expectAdapterShape(output, {
      columns: ["identifier", "title", "url"],
      minItems: 1,
    });
  });
});
