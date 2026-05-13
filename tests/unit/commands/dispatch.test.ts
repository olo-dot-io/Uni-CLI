/**
 * @owner   tests/unit/commands/dispatch.test.ts
 * @does    Pin CLI dispatch helpers that normalize Commander positional arguments.
 * @needs   src/commands/dispatch.ts exported helper contracts.
 * @feeds   optional positional command coverage.
 * @breaks  Commander action argument shape drift can reintroduce positional parsing crashes.
 */

import { describe, expect, it } from "vitest";
import { findAmbiguousLongOptionPositional } from "../../../src/commands/dispatch.js";

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
