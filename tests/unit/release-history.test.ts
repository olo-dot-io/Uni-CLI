import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  parseReleaseHistory,
  renderReleaseHistoryPage,
} from "../../scripts/generate-release-history.js";

describe("cross-version release history", () => {
  it("parses version metadata, structured notes, and exact comparisons", () => {
    const history = parseReleaseHistory(
      `# Changelog

## [1.1.1] — 2026-08-10 — Artemis · Koch

### Added

- Add automatic Agent updates.
  Preserve exact package-manager selection.
- Keep \`unicli <site> <command>\` discoverable.

### Fixed

- Fix release navigation.

## [1.0.4] — 2026-08-09 — Artemis · Glover

### Added

- Add research sources.
`,
      "1.1.1",
    );

    expect(history.current).toBe("1.1.1");
    expect(history.releases[0]).toMatchObject({
      version: "1.1.1",
      date: "2026-08-10",
      codename: "Artemis · Koch",
      compareUrl:
        "https://github.com/olo-dot-io/Uni-CLI/compare/v1.0.4...v1.1.1",
      sections: [
        {
          title: "Added",
          entries: [
            "Add automatic Agent updates. Preserve exact package-manager selection.",
            "Keep `unicli <site> <command>` discoverable.",
          ],
        },
        { title: "Fixed", entries: ["Fix release navigation."] },
      ],
    });
  });

  it("generates indexed English and Chinese pages from one canonical history", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as {
      version: string;
    };
    const history = parseReleaseHistory(
      readFileSync("CHANGELOG.md", "utf-8"),
      pkg.version,
    );
    const root = renderReleaseHistoryPage(history, "root");
    const zh = renderReleaseHistoryPage(history, "zh");

    expect(root).toContain("# Release History");
    expect(root).toContain(`<a id="v${pkg.version.replaceAll(".", "")}"></a>`);
    expect(root).toContain("Compare with previous");
    expect(zh).toContain("# 版本记录");
    expect(zh).toContain("历史版本说明保留发布时原文");
    expect(renderReleaseHistoryPage(history, "root")).not.toContain("<site>");
  });
});
