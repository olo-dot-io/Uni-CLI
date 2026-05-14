/**
 * @owner   tests/unit/public-private-boundary.test.ts
 * @does    Assert the public repo surface contains no paper-private
 *          theoretical framing or identity-bridge signals. Companion to
 *          scripts/boundary-guard.ts; this is the vitest mirror so the
 *          boundary check runs as part of `npm run test` -> `npm run verify`.
 * @needs   scripts/boundary-guard.ts (scanRepo export)
 * @feeds   npm run test, npm run verify, lefthook pre-push
 * @breaks  Public docs / source / config grow paper-private terminology or
 *          fingerprint signals that would compromise the public/private
 *          boundary or double-anonymous ICSE submission.
 */

import { describe, expect, it } from "vitest";

import { scanRepo } from "../../scripts/boundary-guard";

describe("public/private boundary", () => {
  it("public repo surface contains no paper-private framing or identity bridges", () => {
    const violations = scanRepo();
    if (violations.length > 0) {
      const summary = violations
        .map(
          (v) =>
            `${v.file}:${v.line} [${v.category}] "${v.match}" — ${v.reason}`,
        )
        .join("\n");
      throw new Error(
        `\nboundary-guard found ${violations.length} violation(s):\n\n${summary}\n\n` +
          "Public repo surface must not expose paper-private theoretical framing or identity-bridge signals.\n" +
          "Either move the file under ref/ or archive/, or rewrite using engineering vocabulary.",
      );
    }
    expect(violations).toEqual([]);
  });
});
