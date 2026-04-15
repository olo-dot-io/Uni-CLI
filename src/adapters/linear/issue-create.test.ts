import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("linear issue-create", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("linear", "issue-create");
    expectAdapterShape(output, {
      columns: ["identifier", "title", "url"],
      minItems: 1,
    });
  });
});
