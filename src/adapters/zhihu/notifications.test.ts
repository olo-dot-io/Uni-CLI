import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("zhihu notifications", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("zhihu", "notifications");
    expectAdapterShape(output, {
      columns: ["type", "content", "created"],
      minItems: 1,
    });
  });
});
