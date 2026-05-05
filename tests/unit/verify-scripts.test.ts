/**
 * @owner   tests/unit/verify-scripts.test.ts
 * @does    Verify package script wiring keeps release and verification gates complete.
 * @needs   vitest, package.json scripts
 * @feeds   npm run test, npm run verify
 * @breaks  Missing release or verification script gates fail unit verification.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");

function rootScripts(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  return pkg.scripts ?? {};
}

function rootPackage(): {
  bin?: Record<string, string>;
  files?: string[];
} {
  return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    bin?: Record<string, string>;
    files?: string[];
  };
}

describe("verify scripts", () => {
  it("runs the compute perf budget gate in the default verify chain", () => {
    const scripts = rootScripts();

    expect(scripts["test:perf"]).toBe("vitest run --project perf");
    expect(scripts.verify).toContain("npm run test:perf");
  });

  it("cleans stale dist output before building publishable files", () => {
    const scripts = rootScripts();

    expect(scripts.clean).toContain("rmSync('dist'");
    expect(scripts.build).toMatch(/^npm run clean && tsc && /);
  });

  it("packages a root MCP binary wrapper for npm payload inspection", () => {
    const pkg = rootPackage();

    expect(pkg.bin?.["unicli-mcp"]).toBe("bin/unicli-mcp");
    expect(pkg.files).toContain("bin/");
    expect(existsSync(join(ROOT, "bin", "unicli-mcp"))).toBe(true);
  });
});
