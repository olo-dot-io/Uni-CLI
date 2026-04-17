import { describe, it, expect } from "vitest";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMd } from "../../../src/output/md.js";
import { CASES } from "./fixtures-cases.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "md",
);

describe("md golden fixtures", () => {
  for (const c of CASES) {
    it(c.name, () => {
      const actual = renderMd(c.envelope);
      const fixturePath = join(FIXTURES_DIR, `${c.name}.md`);
      // Regenerate: UPDATE_FIXTURES=1 npx vitest run tests/unit/output/fixtures.test.ts
      if (process.env["UPDATE_FIXTURES"] === "1") {
        if (!existsSync(FIXTURES_DIR))
          mkdirSync(FIXTURES_DIR, { recursive: true });
        writeFileSync(fixturePath, actual);
        return;
      }
      const expected = readFileSync(fixturePath, "utf-8");
      expect(actual).toBe(expected);
    });
  }

  it("no stray fixture files (catches renamed/deleted cases)", () => {
    if (!existsSync(FIXTURES_DIR)) return; // first-run safety
    const onDisk = new Set(
      readdirSync(FIXTURES_DIR)
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.replace(/\.md$/, "")),
    );
    const expected = new Set(CASES.map((c) => c.name));
    for (const f of onDisk) {
      if (!expected.has(f))
        throw new Error(`stray fixture: ${f}.md — delete or add to CASES`);
    }
  });
});
