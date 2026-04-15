import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("bluesky user", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("bluesky", "user");
    expectAdapterShape(output, {
      columns: ["rank", "text", "likes", "reposts", "replies"],
      minItems: 1,
    });
  });
});
