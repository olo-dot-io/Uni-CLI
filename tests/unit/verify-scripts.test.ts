/**
 * @owner   tests/unit/verify-scripts.test.ts
 * @does    Verify package script wiring keeps release and verification gates complete.
 * @needs   vitest, package.json scripts
 * @feeds   npm run test, npm run verify
 * @breaks  Missing release or verification script gates fail unit verification.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const npxBin = process.platform === "win32" ? "npx.cmd" : "npx";

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

function runCatalogGenerator(catalogPath: string, siteIndexPath: string): void {
  const result = spawnSync(
    npxBin,
    ["tsx", "scripts/generate-catalog.ts", catalogPath, siteIndexPath],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
    },
  );

  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
}

function runReleaseDryRun(): void {
  const result = spawnSync(npxBin, ["tsx", "scripts/release.ts", "--dry-run"], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      RELEASE_CODENAME: "Vostok · Gagarin",
    },
    timeout: 60_000,
  });

  expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
  expect(result.stderr).toBe("");
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

  it("keeps generated docs catalog timestamps stable when content is unchanged", () => {
    const tmp = mkdtempSync(join(tmpdir(), "unicli-catalog-"));
    const catalogPath = join(tmp, "adapters-catalog.json");
    const siteIndexPath = join(tmp, "site-index.json");
    const sentinel = "2000-01-01T00:00:00.000Z";

    try {
      runCatalogGenerator(catalogPath, siteIndexPath);

      const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as {
        generated: string;
      };
      const siteIndex = JSON.parse(readFileSync(siteIndexPath, "utf8")) as {
        generated: string;
      };

      writeFileSync(
        catalogPath,
        JSON.stringify({ ...catalog, generated: sentinel }, null, 2),
        "utf8",
      );
      writeFileSync(
        siteIndexPath,
        JSON.stringify({ ...siteIndex, generated: sentinel }, null, 2),
        "utf8",
      );

      runCatalogGenerator(catalogPath, siteIndexPath);

      expect(JSON.parse(readFileSync(catalogPath, "utf8")).generated).toBe(
        sentinel,
      );
      expect(JSON.parse(readFileSync(siteIndexPath, "utf8")).generated).toBe(
        sentinel,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 70_000);

  it("runs release metadata propagation in dry-run mode", () => {
    runReleaseDryRun();
  }, 70_000);
});
