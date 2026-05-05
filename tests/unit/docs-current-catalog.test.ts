/**
 * @owner   tests/unit/docs-current-catalog.test.ts
 * @does    Assert current docs do not publish stale catalog or release claims.
 * @needs   docs source files, stats.json, package.json, docs/release-info.json
 * @feeds   Feature 4.1 docs real-data gate, npm run test
 * @breaks  Public docs can ship old site, command, adapter, test, or release counts.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

const CURRENT_DOCS = [
  "docs/.vitepress/config.ts",
  "docs/ARCHITECTURE.md",
  "docs/THEORY.md",
  "docs/how-it-works.md",
  "docs/faq.md",
  "docs/ROADMAP.md",
  "docs/zh/ROADMAP.md",
  "docs/release-info.json",
];

const RETIRED_CATALOG_CLAIMS = [
  /\b233 sites\b/i,
  /\b233 sites and 1448 commands\b/i,
  /\b233 sites and 1,448 commands\b/i,
  /\b1448 commands\b/i,
  /\b1,448 commands\b/i,
  /\b1038 adapters\b/i,
  /\b1,038 adapters\b/i,
  /\b7820 tests\b/i,
  /\b7,820 tests\b/i,
  /\b235\+ supported sites\b/i,
  /\b235\+ sites\b/i,
  /\bv0\.217\b/i,
  /\bv0\.218\.0\b/i,
];

interface PackageJson {
  version: string;
}

interface ReleaseInfo {
  version: string;
  codename: string;
  releaseUrl: string;
  changelogUrl: string;
}

function readRepoFile(path: string): string {
  return readFileSync(join(ROOT, path), "utf-8");
}

describe("current docs catalog claims", () => {
  it.each(CURRENT_DOCS)(
    "%s has no retired catalog or release claims",
    (path) => {
      const source = readRepoFile(path);
      const hits = RETIRED_CATALOG_CLAIMS.filter((pattern) =>
        pattern.test(source),
      ).map((pattern) => String(pattern));

      expect(hits).toEqual([]);
    },
  );

  it("release info matches the package version", () => {
    const pkg = JSON.parse(readRepoFile("package.json")) as PackageJson;
    const releaseInfo = JSON.parse(
      readRepoFile("docs/release-info.json"),
    ) as ReleaseInfo;

    expect(releaseInfo.version).toBe(pkg.version);
    expect(releaseInfo.codename).toBe("Apollo · Cernan Patch");
    expect(releaseInfo.releaseUrl).toContain(`/v${pkg.version}`);
    expect(releaseInfo.changelogUrl).toContain("02181--");
  });
});
