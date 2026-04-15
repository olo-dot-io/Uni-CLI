import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("bluesky thread", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("bluesky", "thread");
    expectAdapterShape(output, {
      columns: ["author", "text", "likes", "reposts", "replies_count"],
      minItems: 1,
    });
  });
});
