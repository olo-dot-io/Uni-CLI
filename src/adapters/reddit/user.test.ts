import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("reddit user", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("reddit", "user");
    expectAdapterShape(output, {
      columns: [
        "username",
        "post_karma",
        "comment_karma",
        "total_karma",
        "created",
      ],
      minItems: 1,
    });
  });
});
