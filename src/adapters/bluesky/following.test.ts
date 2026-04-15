import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("bluesky following", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("bluesky", "following");
    expectAdapterShape(output, {
      columns: ["rank", "handle", "name", "description"],
      minItems: 1,
    });
  });
});
