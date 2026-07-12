import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveCookies } from "../../../src/engine/cookie-storage.js";
import { loadCookies } from "../../../src/engine/cookies.js";

// Regression: cookie-refresh.ts once wrote an ARRAY format that loadCookies
// silently rejected (returned null), so a successful refresh produced
// unusable cookies with no error. Lock the round-trip: whatever the canonical
// writer produces, loadCookies MUST read back.
describe("cookie write/read round-trip (format-drift regression)", () => {
  let dir: string;
  const prev = process.env.UNICLI_COOKIE_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "unicli-cookie-test-"));
    process.env.UNICLI_COOKIE_DIR = dir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.UNICLI_COOKIE_DIR;
    else process.env.UNICLI_COOKIE_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it("loadCookies reads back exactly what saveCookies wrote", () => {
    const cookies = { SESSDATA: "abc", bili_jct: "def" };
    saveCookies("bilibili", cookies);
    expect(loadCookies("bilibili")).toEqual(cookies);
  });

  it("loadCookies returns null (not crash) for a legitimately absent site", () => {
    expect(loadCookies("never-saved-site")).toBeNull();
  });
});
