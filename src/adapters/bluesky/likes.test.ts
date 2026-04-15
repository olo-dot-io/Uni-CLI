import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("bluesky likes", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("bluesky", "likes");
    expectAdapterShape(output, {
      columns: ["author", "text", "likes", "reposts", "date"],
      minItems: 1,
    });
  });
});
