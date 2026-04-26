import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  flatDocPages,
  localizedSiteMaps,
  supportedLocales,
} from "../../docs/.vitepress/site-map.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

function sourcePathFor(routePath: string, localePrefix = ""): string {
  const cleanRoute = routePath.replace(/^\/zh(?=\/|$)/, "") || "/";

  if (cleanRoute === "/") {
    return join(ROOT, "docs", localePrefix, "index.md");
  }

  const relativeRoute = cleanRoute.replace(/^\/+/, "").replace(/\/$/, "");
  return join(ROOT, "docs", localePrefix, `${relativeRoute}.md`);
}

function sourceExistsFor(routePath: string, localePrefix = ""): boolean {
  const markdownPath = sourcePathFor(routePath, localePrefix);
  const indexPath = markdownPath.replace(/\.md$/, "/index.md");
  return existsSync(markdownPath) || existsSync(indexPath);
}

describe("docs i18n", () => {
  it("declares English and Simplified Chinese locales", () => {
    expect(supportedLocales).toEqual(["root", "zh"]);
    expect(localizedSiteMaps.zh.label).toBe("简体中文");
    expect(localizedSiteMaps.zh.lang).toBe("zh-CN");
  });

  it("has a Simplified Chinese source page for every public English page", () => {
    const englishPages = flatDocPages("root");
    const chinesePages = flatDocPages("zh");

    expect(chinesePages).toHaveLength(englishPages.length);

    for (const page of chinesePages) {
      expect(sourceExistsFor(page.link, "zh")).toBe(true);
    }
  });

  it("keeps the i18n switch in the VitePress config", () => {
    const config = readFileSync(
      join(ROOT, "docs", ".vitepress", "config.ts"),
      "utf-8",
    );

    expect(config).toContain("locales");
    expect(config).toContain("localizedSiteMaps.zh.label");
    expect(config).toContain("localizedSiteMaps.root.label");
  });

  it("maps Chinese markdown companions under /markdown/zh/", () => {
    const page = flatDocPages("zh").find((entry) => entry.link === "/zh/");
    expect(page?.markdownPath).toBe("/markdown/zh/index.md");

    const sites = flatDocPages("zh").find(
      (entry) => entry.link === "/zh/reference/sites",
    );
    expect(sites?.markdownPath).toBe("/markdown/zh/reference/sites.md");
  });
});
