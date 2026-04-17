/**
 * `unicli explore` / `unicli generate` are full-flow browser commands that
 * require a live Chrome CDP target. A proper integration test belongs in
 * the adapter harness (`npm run test:adapter`) rather than the unit suite —
 * both actions call `BrowserBridge.connect()` which can hang when no
 * browser is reachable and cannot be usefully mocked at the `registerX`
 * level without rewriting the action bodies.
 *
 * T5 exercises these two commands through:
 *   1. `npm run typecheck` — confirms envelope contract types compile.
 *   2. `npm run lint` — catches any envelope field misspellings.
 *   3. Static grep on `commands: "core.explore"` / `"core.generate"` — done
 *      during this task's implementation.
 *
 * If a future change regresses the envelope shape, the adapter-harness
 * run (`eval run`) will catch it because both commands write a JSON
 * envelope to stdout on the success path.
 */

import { describe, it, expect } from "vitest";
import { registerExploreCommand } from "../../../src/commands/explore.js";
import { registerGenerateCommand } from "../../../src/commands/generate.js";

describe("unicli explore/generate — registration smoke", () => {
  it("registerExploreCommand is a callable named function", () => {
    expect(typeof registerExploreCommand).toBe("function");
    expect(registerExploreCommand.length).toBe(1);
  });

  it("registerGenerateCommand is a callable named function", () => {
    expect(typeof registerGenerateCommand).toBe("function");
    expect(registerGenerateCommand.length).toBe(1);
  });
});
