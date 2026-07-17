/**
 * @owner   tests/unit/commands/dispatch.test.ts
 * @does    Pin CLI dispatch helpers that normalize Commander positional arguments.
 * @needs   src/commands/dispatch.ts exported helper contracts.
 * @feeds   optional positional command coverage.
 * @breaks  Commander action argument shape drift can reintroduce positional parsing crashes.
 */

import { describe, expect, it } from "vitest";
import {
  findAmbiguousLongOptionPositional,
  normalizeAdapterOptionValues,
} from "../../../src/commands/dispatch.js";

describe("CLI dispatch positional helpers", () => {
  it("ignores omitted optional positionals when checking long-option ambiguity", () => {
    expect(
      findAmbiguousLongOptionPositional([undefined, "plain", null]),
    ).toBeUndefined();
    expect(findAmbiguousLongOptionPositional([undefined, "--flag"])).toBe(
      "--flag",
    );
  });
});

describe("CLI dispatch option normalization", () => {
  it("maps canonical hyphenated flags and legacy underscored flags to adapter arg names", () => {
    const args = [{ name: "max_chars_k", type: "int" as const }];

    expect(normalizeAdapterOptionValues({ maxCharsK: "2" }, args)).toEqual({
      max_chars_k: "2",
    });
    expect(normalizeAdapterOptionValues({ max_chars_k: "3" }, args)).toEqual({
      max_chars_k: "3",
    });
  });
});
