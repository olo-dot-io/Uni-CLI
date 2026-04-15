import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("bluesky followers", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("bluesky", "followers");
    expectAdapterShape(output, {
      columns: ["rank", "handle", "name", "description"],
      minItems: 1,
    });
  });
});
