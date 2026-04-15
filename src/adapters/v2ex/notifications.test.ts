import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("v2ex notifications", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("v2ex", "notifications");
    expectAdapterShape(output, {
      columns: ["member", "text", "created"],
      minItems: 1,
    });
  });
});
