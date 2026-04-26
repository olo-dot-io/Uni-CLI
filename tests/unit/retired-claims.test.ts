import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Retired-claim guard.
 *
 * The "~80 tokens per call" marketing figure conflated the invocation
 * string length with the full response payload. It was retired in v0.212
 * Phase 0.5 in favour of the measured numbers in docs/BENCHMARK.md.
 *
 * This test fails fast if the claim re-appears in any shipped surface
 * (README.md, AGENTS.md, DESIGN.md, docs/*.md, src/**). scripts/
 * lint-context.sh enforces the same rule in CI; keeping a vitest copy
 * means local `npm run test` catches it too.
 *
 * Gitignored local-only paths (.claude/**, ref/**) and the docs/BENCHMARK.md
 * file itself (which documents the retirement) are exempt.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

const SCAN_PATHS = ["README.md", "AGENTS.md", "DESIGN.md", "docs", "src"];

const EXEMPT = new Set<string>([join(ROOT, "docs", "BENCHMARK.md")]);

const RETIRED_PATTERNS = [/~80\s*tokens?/i, /80\s*tokens?\s+per/i, /80_tokens/];

function* walk(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      yield* walk(full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (
      entry.name.endsWith(".md") ||
      entry.name.endsWith(".ts") ||
      entry.name.endsWith(".js")
    ) {
      yield full;
    }
  }
}

function collectHits(): Array<{ file: string; line: number; text: string }> {
  const hits: Array<{ file: string; line: number; text: string }> = [];
  for (const target of SCAN_PATHS) {
    const full = join(ROOT, target);
    if (!existsSync(full)) continue;
    const paths = statSync(full).isDirectory() ? [...walk(full)] : [full];
    for (const path of paths) {
      if (EXEMPT.has(path)) continue;
      const source = readFileSync(path, "utf-8");
      const lines = source.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (RETIRED_PATTERNS.some((re) => re.test(line))) {
          hits.push({
            file: path.replace(ROOT + "/", ""),
            line: i + 1,
            text: line.trim().slice(0, 160),
          });
        }
      }
    }
  }
  return hits;
}

describe("retired '~80 tokens per call' claim is gone", () => {
  it("no shipped file cites the retired figure", () => {
    const hits = collectHits();
    expect(hits).toEqual([]);
  });
});
