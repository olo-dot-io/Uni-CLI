import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("bluesky search", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("bluesky", "search");
    expectAdapterShape(output, {
      columns: ["rank", "handle", "name", "followers", "description"],
      minItems: 1,
    });
  });
});
