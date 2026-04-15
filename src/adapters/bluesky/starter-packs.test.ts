import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("bluesky starter-packs", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("bluesky", "starter-packs");
    expectAdapterShape(output, {
      columns: ["rank", "name", "description", "members", "joins"],
      minItems: 1,
    });
  });
});
