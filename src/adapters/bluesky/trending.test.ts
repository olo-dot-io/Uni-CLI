import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("bluesky trending", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("bluesky", "trending");
    expectAdapterShape(output, {
      columns: ["rank", "topic", "link"],
      minItems: 1,
    });
  });
});
