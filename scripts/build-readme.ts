/**
 * @owner   scripts/build-readme.ts
 * @does    Inject generated stats, logo-backed README coverage, and the MCP registry catalog description.
 * @needs   stats.json, dist/manifest.json, README/doc marker blocks, server.json
 * @feeds   README.md, README.zh-CN.md, AGENTS.md, roadmap/copy stats, server.json
 * @breaks  Stale public counts or placeholder badges misrepresent catalog quality.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const STATS_PATH = join(ROOT, "stats.json");
const MANIFEST_PATH = join(ROOT, "dist", "manifest.json");
const SERVER_JSON_PATH = join(ROOT, "server.json");

const TARGETS = [
  "README.md",
  "README.zh-CN.md",
  "AGENTS.md",
  join("docs", "ROADMAP.md"),
  join("docs", "zh", "ROADMAP.md"),
  join("docs", "ARCHITECTURE.md"),
  join("docs", "glossary.md"),
  join("docs", "how-it-works.md"),
  join("docs", "faq.md"),
  join("docs", "reference", "pipeline.md"),
  join("docs", "zh", "BENCHMARK.md"),
  join("docs", "zh", "how-it-works.md"),
  join("docs", "zh", "faq.md"),
  join("docs", "zh", "glossary.md"),
  join("contributing", "COPY.md"),
];

const MARKER = /<!--\s*STATS:([a-z_]+)\s*-->[\s\S]*?<!--\s*\/STATS\s*-->/g;
const SITE_GRID_START = "<!-- BEGIN README_SITE_GRID -->";
const SITE_GRID_END = "<!-- END README_SITE_GRID -->";
const README_SITE_GRID_TARGETS: Record<string, Record<string, string>> = {
  "README.md": {},
  "README.zh-CN.md": {
    social: "社交",
    video: "视频",
    news: "新闻",
    finance: "财经",
    shopping: "购物",
    dev: "开发",
    ai: "AI",
    scholarly: "学术",
    patent: "专利",
    reference: "知识",
    audio: "音频",
    content: "内容",
    productivity: "效率",
    jobs: "招聘",
    desktop: "桌面",
    games: "游戏",
    utility: "工具",
    agent: "Agent",
    other: "其他",
    travel: "旅行",
  },
};

interface ManifestCommand {
  name: string;
  quarantined?: boolean;
}

interface ManifestSite {
  category?: string;
  commands: ManifestCommand[];
}

interface Manifest {
  sites: Record<string, ManifestSite>;
}

const CATEGORY_ORDER = [
  "social",
  "video",
  "news",
  "finance",
  "shopping",
  "dev",
  "ai",
  "scholarly",
  "patent",
  "reference",
  "audio",
  "content",
  "productivity",
  "jobs",
  "desktop",
  "games",
  "utility",
  "agent",
  "other",
];

function loadStats(): Record<string, unknown> {
  if (!existsSync(STATS_PATH)) {
    console.error(
      "build-readme: stats.json is missing. Run `npm run stats` first.",
    );
    process.exit(1);
  }
  return JSON.parse(readFileSync(STATS_PATH, "utf-8"));
}

function loadManifest(): Manifest {
  if (!existsSync(MANIFEST_PATH)) {
    console.error(
      "build-readme: dist/manifest.json is missing. Run `npm run build:manifest` first.",
    );
    process.exit(1);
  }
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")) as Manifest;
}

export function inject(
  source: string,
  stats: Record<string, unknown>,
): { output: string; changed: number; missing: string[] } {
  const missing: string[] = [];
  let changed = 0;
  const output = source.replace(MARKER, (_full, key: string) => {
    if (!(key in stats)) {
      missing.push(key);
      return `<!-- STATS:${key} -->?<!-- /STATS -->`;
    }
    changed++;
    return `<!-- STATS:${key} -->${String(stats[key])}<!-- /STATS -->`;
  });
  return { output, changed, missing };
}

function requiredCount(
  stats: Record<string, unknown>,
  key: "site_count" | "command_count",
): number {
  const value = stats[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `build-readme: stats.${key} must be a non-negative integer`,
    );
  }
  return value;
}

export function buildServerDescription(stats: Record<string, unknown>): string {
  const sites = requiredCount(stats, "site_count");
  const commands = requiredCount(stats, "command_count");
  return `Give agents every interface—search ${String(sites)} sites and tools through ${String(commands)} declared operations across web, browser, desktop, local, and MCP surfaces.`;
}

function syncServerDescription(stats: Record<string, unknown>): boolean {
  if (!existsSync(SERVER_JSON_PATH)) {
    throw new Error("build-readme: server.json is missing");
  }
  const source = readFileSync(SERVER_JSON_PATH, "utf-8");
  const server = JSON.parse(source) as Record<string, unknown>;
  if (typeof server.description !== "string") {
    throw new Error("build-readme: server.json description must be a string");
  }
  const output = `${JSON.stringify(
    { ...server, description: buildServerDescription(stats) },
    null,
    2,
  )}\n`;
  if (output === source) return false;
  writeFileSync(SERVER_JSON_PATH, output, "utf-8");
  return true;
}

function categoryRank(category: string): number {
  const rank = CATEGORY_ORDER.indexOf(category);
  return rank === -1 ? CATEGORY_ORDER.length : rank;
}

export function buildSiteGrid(
  manifest: Manifest,
  categoryLabels: Record<string, string> = {},
): string {
  const rows = Object.entries(manifest.sites)
    .map(([site, info]) => ({
      site,
      category: info.category ?? "other",
      commandCount: info.commands.filter(
        (command) => command.quarantined !== true,
      ).length,
    }))
    .filter((row) => row.commandCount > 0);

  const byCategory = new Map<
    string,
    { sites: number; commands: number; examples: typeof rows }
  >();
  for (const row of rows) {
    const summary = byCategory.get(row.category) ?? {
      sites: 0,
      commands: 0,
      examples: [],
    };
    summary.sites += 1;
    summary.commands += row.commandCount;
    summary.examples.push(row);
    byCategory.set(row.category, summary);
  }

  const header = categoryLabels.social
    ? "| 类别 | 站点 | Operations | 示例 |\n| --- | ---: | ---: | --- |"
    : "| Surface | Sites | Operations | Examples |\n| --- | ---: | ---: | --- |";
  const sections = Array.from(byCategory.entries())
    .sort(([a], [b]) => categoryRank(a) - categoryRank(b))
    .map(([category, summary]) => {
      const examples = summary.examples
        .sort(
          (a, b) =>
            b.commandCount - a.commandCount || a.site.localeCompare(b.site),
        )
        .slice(0, 4)
        .map(
          (row) =>
            `[${row.site}](https://olo-dot-io.github.io/Uni-CLI/reference/sites#${row.site})`,
        )
        .join(", ");
      return `| ${categoryLabels[category] ?? category} | ${summary.sites} | ${summary.commands} | ${examples} |`;
    });

  return [
    SITE_GRID_START,
    "<!-- prettier-ignore -->",
    header,
    ...sections,
    "",
    SITE_GRID_END,
  ].join("\n");
}

export function injectSiteGrid(
  source: string,
  manifest: Manifest,
  categoryLabels: Record<string, string> = {},
): { output: string; changed: boolean } {
  const hasStart = source.includes(SITE_GRID_START);
  const hasEnd = source.includes(SITE_GRID_END);
  if (!hasStart && !hasEnd) return { output: source, changed: false };
  if (!hasStart || !hasEnd) {
    throw new Error("README site grid markers must appear as a pair");
  }

  const start = source.indexOf(SITE_GRID_START);
  const end = source.indexOf(SITE_GRID_END);
  if (end <= start) {
    throw new Error("README site grid end marker must follow start marker");
  }

  const replacement = buildSiteGrid(manifest, categoryLabels);
  const output =
    source.slice(0, start) +
    replacement +
    source.slice(end + SITE_GRID_END.length);
  return { output, changed: output !== source };
}

function main(): void {
  const stats = loadStats();
  const manifest = loadManifest();
  let totalChanged = 0;
  let gridChanged = 0;
  const missingAll: Array<{ file: string; keys: string[] }> = [];

  for (const rel of TARGETS) {
    const full = join(ROOT, rel);
    if (!existsSync(full)) continue;
    const source = readFileSync(full, "utf-8");
    const injected = inject(source, stats);
    const siteGridLabels = README_SITE_GRID_TARGETS[rel];
    const gridded = siteGridLabels
      ? injectSiteGrid(injected.output, manifest, siteGridLabels)
      : { output: injected.output, changed: false };
    if (gridded.output !== source) {
      writeFileSync(full, gridded.output, "utf-8");
    }
    totalChanged += injected.changed;
    if (gridded.changed) gridChanged++;
    if (injected.missing.length > 0) {
      missingAll.push({ file: rel, keys: injected.missing });
    }
  }

  console.log(
    `build-readme: injected ${totalChanged} STATS marker${totalChanged === 1 ? "" : "s"} across ${TARGETS.length} file${TARGETS.length === 1 ? "" : "s"}`,
  );
  console.log(`build-readme: updated ${gridChanged} README site grid block`);
  console.log(
    `build-readme: MCP registry description ${syncServerDescription(stats) ? "updated" : "already current"}`,
  );
  if (missingAll.length > 0) {
    for (const { file, keys } of missingAll) {
      console.error(
        `build-readme: ${file} references unknown stats: ${keys.join(", ")}`,
      );
    }
    process.exit(1);
  }
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] === thisFile) {
  main();
}
