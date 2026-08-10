#!/usr/bin/env tsx
/**
 * Generate the public cross-version release pages and machine-readable history
 * from the root CHANGELOG.md. CHANGELOG.md remains the only authored history.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";

export interface ReleaseHistorySection {
  title: string;
  entries: string[];
}

export interface ReleaseHistoryEntry {
  version: string;
  date?: string;
  codename?: string;
  releaseUrl: string;
  npmUrl: string;
  compareUrl?: string;
  sections: ReleaseHistorySection[];
  markdown: string;
}

export interface ReleaseHistory {
  schema_version: "1";
  package: "@zenalexa/unicli";
  current: string;
  generated_from: "CHANGELOG.md";
  releases: ReleaseHistoryEntry[];
}

const PACKAGE_NAME = "@zenalexa/unicli" as const;
const REPOSITORY_URL = "https://github.com/olo-dot-io/Uni-CLI";
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function parseReleaseHistory(
  changelog: string,
  current: string,
): ReleaseHistory {
  const heading =
    /^## \[([^\]]+)\](?:\s+—\s+(\d{4}-\d{2}-\d{2}))?(?:\s+—\s+([^\n]+))?\s*$/gm;
  const matches = [...changelog.matchAll(heading)];
  const parsed = matches
    .map((match, index) => {
      const version = match[1]?.trim() ?? "";
      if (!SEMVER.test(version)) return undefined;
      const bodyStart = (match.index ?? 0) + match[0].length;
      const bodyEnd = matches[index + 1]?.index ?? changelog.length;
      const markdown = changelog.slice(bodyStart, bodyEnd).trim();
      return {
        version,
        ...(match[2] ? { date: match[2] } : {}),
        ...(match[3] ? { codename: match[3].trim() } : {}),
        releaseUrl: `${REPOSITORY_URL}/releases/tag/v${version}`,
        npmUrl: `https://www.npmjs.com/package/${PACKAGE_NAME}/v/${version}`,
        sections: parseSections(markdown),
        markdown,
      } satisfies Omit<ReleaseHistoryEntry, "compareUrl">;
    })
    .filter(
      (entry): entry is Omit<ReleaseHistoryEntry, "compareUrl"> =>
        entry !== undefined,
    );

  const releases = parsed.map((entry, index): ReleaseHistoryEntry => {
    const previous = parsed[index + 1];
    return {
      ...entry,
      ...(previous
        ? {
            compareUrl: `${REPOSITORY_URL}/compare/v${previous.version}...v${entry.version}`,
          }
        : {}),
    };
  });
  if (!releases.some((release) => release.version === current)) {
    throw new Error(`CHANGELOG.md has no release heading for ${current}`);
  }
  return {
    schema_version: "1",
    package: PACKAGE_NAME,
    current,
    generated_from: "CHANGELOG.md",
    releases,
  };
}

function parseSections(markdown: string): ReleaseHistorySection[] {
  const sectionHeading = /^### ([^\n]+)\s*$/gm;
  const matches = [...markdown.matchAll(sectionHeading)];
  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? markdown.length;
    return {
      title: match[1]?.trim() ?? "Changes",
      entries: parseListEntries(markdown.slice(start, end)),
    };
  });
}

function parseListEntries(markdown: string): string[] {
  const entries: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length === 0) return;
    entries.push(current.join(" ").replace(/\s+/g, " ").trim());
    current = [];
  };
  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith("- ")) {
      flush();
      current.push(line.slice(2).trim());
      continue;
    }
    if (current.length > 0 && /^\s{2,}\S/.test(line)) {
      current.push(line.trim());
      continue;
    }
    if (line.trim() === "") continue;
    flush();
  }
  flush();
  return entries;
}

export function renderReleaseHistoryPage(
  history: ReleaseHistory,
  locale: "root" | "zh",
): string {
  const isZh = locale === "zh";
  const lines = [
    "---",
    `title: ${isZh ? "版本记录" : "Release History"}`,
    `description: ${
      isZh
        ? "按版本查看 Uni-CLI 的新增能力、行为变化、修复和完整比较链接。"
        : "Browse every Uni-CLI release with additions, behavior changes, fixes, and exact comparison links."
    }`,
    "---",
    "",
    `# ${isZh ? "版本记录" : "Release History"}`,
    "",
    isZh
      ? "本页由仓库根目录的 `CHANGELOG.md` 生成。Changesets 负责收集每项改动，发布脚本负责版本号、日期和代号，文档构建负责生成本页与机器可读记录。历史版本说明保留发布时原文。"
      : "This page is generated from the repository root `CHANGELOG.md`. Changesets collect each change, the release script owns version metadata, and the docs build publishes this page plus a machine-readable history.",
    "",
    isZh
      ? "机器可读记录位于 [`release-history.json`](./release-history.json)。"
      : "The machine-readable record is available as [`release-history.json`](./release-history.json).",
    "",
    `## ${isZh ? "版本索引" : "Version Index"}`,
    "",
    isZh
      ? "| 版本 | 日期 | 代号 | 完整差异 |"
      : "| Version | Date | Codename | Full diff |",
    "| --- | --- | --- | --- |",
    ...history.releases.map((release) => {
      const anchor = releaseAnchor(release.version);
      const compare = release.compareUrl
        ? `[${isZh ? "比较" : "Compare"}](${release.compareUrl})`
        : "";
      return `| [v${release.version}](#${anchor}) | ${release.date ?? ""} | ${release.codename ?? ""} | ${compare} |`;
    }),
    "",
  ];

  for (const release of history.releases) {
    lines.push(
      `<a id="${releaseAnchor(release.version)}"></a>`,
      "",
      `## v${release.version}${release.date ? ` · ${release.date}` : ""}${release.codename ? ` · ${release.codename}` : ""}`,
      "",
      `[GitHub Release](${release.releaseUrl}) · [npm](${release.npmUrl})${
        release.compareUrl
          ? ` · [${isZh ? "与上一版本比较" : "Compare with previous"}](${release.compareUrl})`
          : ""
      }`,
      "",
      escapeVueHtml(rewriteRepositoryLinks(release.markdown)),
      "",
    );
  }
  return `${lines.join("\n").trim()}\n`;
}

function releaseAnchor(version: string): string {
  return `v${version.replace(/\./g, "").replace(/[^a-zA-Z0-9-]/g, "-")}`;
}

function escapeVueHtml(markdown: string): string {
  return markdown.replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^>\n]*)?>/g, (tag) =>
    tag.replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
  );
}

function rewriteRepositoryLinks(markdown: string): string {
  return markdown.replace(
    /(\[[^\]]+\]\()([^)\s]+)(\))/g,
    (_match, prefix: string, target: string, suffix: string) => {
      if (
        target.startsWith("#") ||
        target.startsWith("/") ||
        /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)
      ) {
        return `${prefix}${target}${suffix}`;
      }
      const path = target.replace(/^\.\//, "");
      return `${prefix}${REPOSITORY_URL}/blob/main/${path}${suffix}`;
    },
  );
}

async function writeFormatted(path: string, contents: string): Promise<void> {
  writeFileSync(path, await format(contents, { filepath: path }));
}

async function main(): Promise<void> {
  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf-8")) as {
    version: string;
  };
  const changelog = readFileSync(resolve("CHANGELOG.md"), "utf-8");
  const history = parseReleaseHistory(changelog, pkg.version);
  await writeFormatted(
    resolve("docs/public/release-history.json"),
    `${JSON.stringify(history, null, 2)}\n`,
  );
  await writeFormatted(
    resolve("docs/releases.md"),
    renderReleaseHistoryPage(history, "root"),
  );
  await writeFormatted(
    resolve("docs/zh/releases.md"),
    renderReleaseHistoryPage(history, "zh"),
  );
  process.stdout.write(
    `wrote release history: ${history.releases.length} versions -> docs/releases.md\n`,
  );
}

if (
  resolve(process.argv[1] ?? "") === resolve(fileURLToPath(import.meta.url))
) {
  await main();
}
