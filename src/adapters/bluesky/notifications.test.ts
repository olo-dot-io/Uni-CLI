import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("bluesky notifications", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("bluesky", "notifications");
    expectAdapterShape(output, {
      columns: ["reason", "author", "text", "indexed_at", "is_read"],
      minItems: 1,
    });
  });
});
