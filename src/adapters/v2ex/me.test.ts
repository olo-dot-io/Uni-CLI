import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("v2ex me", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("v2ex", "me");
    expectAdapterShape(output, {
      columns: ["id", "username", "bio", "created"],
      minItems: 1,
    });
  });
});
