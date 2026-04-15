import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("github-trending daily", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("github-trending", "daily");
    expectAdapterShape(output, {
      columns: ["rank", "name", "language", "stars", "forks"],
      minItems: 1,
    });
  });
});
