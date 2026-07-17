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
import { buildServerDescription } from "../../scripts/build-readme.js";

const ROOT = process.cwd();

const CURRENT_DOCS = [
  "package.json",
  "server.json",
  "contributing/adapter.md",
  "contributing/schema.md",
  "docs/.vitepress/config.ts",
  "docs/ARCHITECTURE.md",
  "docs/glossary.md",
  "docs/how-it-works.md",
  "docs/faq.md",
  "docs/reference/pipeline.md",
  "docs/zh/BENCHMARK.md",
  "docs/zh/how-it-works.md",
  "docs/zh/faq.md",
  "docs/zh/glossary.md",
  "docs/ROADMAP.md",
  "docs/zh/ROADMAP.md",
  "docs/release-info.json",
  "docs/public/markdown/zh/BENCHMARK.md",
  "docs/public/markdown/zh/how-it-works.md",
  "docs/public/markdown/zh/faq.md",
  "docs/public/markdown/zh/glossary.md",
];

const RETIRED_CATALOG_CLAIMS = [
  /\b237\+ websites\b/i,
  /\b237\+ websites and apps\b/i,
  /\b920 declarative YAML adapters\b/i,
  /\b233 sites\b/i,
  /\b233 sites and 1448 commands\b/i,
  /\b233 sites and 1,448 commands\b/i,
  /\b1448 commands\b/i,
  /\b1,448 commands\b/i,
  /\b1038 adapters\b/i,
  /\b1,038 adapters\b/i,
  /\b7820 tests\b/i,
  /\b7,820 tests\b/i,
  /\b235 个站点\b/i,
  /\b1450 条命令\b/i,
  /\b1040 个适配器\b/i,
  /\b917 个 schema-v2 YAML adapter\b/i,
  /\b59 个 pipeline step\b/i,
  /\b59 个 pipeline steps\b/i,
  /\b59 步 pipeline\b/i,
  /\b59-step\b/i,
  /\b59 steps\b/i,
  /\b30 steps\b/i,
  /\b35 steps\b/i,
  /\b7591 个测试\b/i,
  /\b235\+ 站点\b/i,
  /\b235\+ supported sites\b/i,
  /\b235\+ sites\b/i,
  /\bv0\.217\b/i,
  /\bv0\.218\.0\b/i,
  new RegExp("\\byaml" + "-runner\\b", "i"),
];

interface PackageJson {
  version: string;
}

interface ReleaseInfo {
  version: string;
  codename: string;
  status: "local" | "published";
  releaseUrl: string;
  changelogUrl: string;
}

interface ServerJson {
  description: string;
  version: string;
  packages: Array<{ version: string }>;
}

function readRepoFile(path: string): string {
  return readFileSync(join(ROOT, path), "utf-8");
}

function versionSlug(version: string): string {
  return version.replace(/\./g, "");
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
    expect(releaseInfo.codename).toMatch(/^\S.+\s·\s\S.+$/);
    expect(releaseInfo.codename).not.toMatch(
      /\b(?:tbd|todo|unreleased|next)\b/i,
    );
    expect(["local", "published"]).toContain(releaseInfo.status);
    expect(releaseInfo.releaseUrl).toContain(`/v${pkg.version}`);
    expect(releaseInfo.changelogUrl).toContain(`${versionSlug(pkg.version)}--`);
  });

  it("generated home pages distinguish local delivery from publication", () => {
    const releaseInfo = JSON.parse(
      readRepoFile("docs/release-info.json"),
    ) as ReleaseInfo;
    const rootHome = readRepoFile("docs/public/markdown/index.md");
    const zhHome = readRepoFile("docs/public/markdown/zh/index.md");

    if (releaseInfo.status === "published") {
      expect(rootHome).toContain(`Latest: v${releaseInfo.version}`);
      expect(zhHome).toContain(`当前 latest：v${releaseInfo.version}`);
      return;
    }

    expect(rootHome).toContain(`Local release: v${releaseInfo.version}`);
    expect(zhHome).toContain(`本地版本：v${releaseInfo.version}`);
    expect(rootHome).not.toContain(`Latest: v${releaseInfo.version}`);
    expect(zhHome).not.toContain(`当前 latest：v${releaseInfo.version}`);
  });

  it("MCP registry manifest matches the package version", () => {
    const pkg = JSON.parse(readRepoFile("package.json")) as PackageJson;
    const server = JSON.parse(readRepoFile("server.json")) as ServerJson;

    expect(server.version).toBe(pkg.version);
    expect(server.packages.map((entry) => entry.version)).toEqual([
      pkg.version,
    ]);
  });

  it("MCP registry description is derived from current catalog stats", () => {
    const stats = JSON.parse(readRepoFile("stats.json")) as Record<
      string,
      unknown
    >;
    const server = JSON.parse(readRepoFile("server.json")) as ServerJson;

    expect(server.description).toBe(buildServerDescription(stats));
  });

  it.each(["docs/faq.md", "docs/zh/faq.md"])(
    "%s names the current package version",
    (path) => {
      const pkg = JSON.parse(readRepoFile("package.json")) as PackageJson;

      expect(readRepoFile(path)).toContain(`v${pkg.version}`);
    },
  );
});
