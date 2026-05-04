import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");

function rootScripts(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  return pkg.scripts ?? {};
}

describe("verify scripts", () => {
  it("runs the compute perf budget gate in the default verify chain", () => {
    const scripts = rootScripts();

    expect(scripts["test:perf"]).toBe("vitest run --project perf");
    expect(scripts.verify).toContain("npm run test:perf");
  });
});
