import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("bluesky feeds", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("bluesky", "feeds");
    expectAdapterShape(output, {
      columns: ["rank", "name", "likes", "creator", "description"],
      minItems: 1,
    });
  });
});
