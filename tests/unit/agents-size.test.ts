import { describe, it, expect } from "vitest";
import { statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const AGENTS_PATH = join(ROOT, "AGENTS.md");

/**
 * AGENTS.md is injected at agent cold start (Claude Code, Codex, OpenCode,
 * Cursor). Every byte is a per-request tax, so the project caps it at 8192
 * bytes (~2K tokens). `scripts/validate-agents-size.ts` enforces the same
 * budget in `npm run verify`; this test is the fast unit-level signal.
 */

describe("AGENTS.md size budget", () => {
  const MAX_BYTES = 8192;

  it("is within the 8KB byte budget", () => {
    const { size } = statSync(AGENTS_PATH);
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThanOrEqual(MAX_BYTES);
  });
});
