/**
 * @owner   scripts/build-readme.ts
 * @does    Inject generated stats and logo-backed README coverage content.
 * @needs   stats.json, dist/manifest.json, README/doc marker blocks
 * @feeds   README.md, README.zh-CN.md, AGENTS.md, roadmap/copy stats
 * @breaks  Stale public counts or placeholder badges misrepresent catalog quality.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const STATS_PATH = join(ROOT, "stats.json");
const MANIFEST_PATH = join(ROOT, "dist", "manifest.json");

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

const CATEGORY_COLORS: Record<string, string> = {
  social: "2563eb",
  video: "dc2626",
  news: "b45309",
  finance: "047857",
  shopping: "be185d",
  dev: "4f46e5",
  ai: "7c3aed",
  reference: "0f766e",
  audio: "16a34a",
  content: "c2410c",
  productivity: "475569",
  jobs: "0891b2",
  desktop: "334155",
  games: "9333ea",
  utility: "0d9488",
  agent: "111827",
  other: "64748b",
};

const SITE_LOGOS: Record<string, string> = {
  "apple-notes": "apple",
  "apple-podcasts": "applepodcasts",
  "apple-tv": "appletv",
  "claude-code": "anthropic",
  "codex-cli": "openai",
  "crates-io": "rust",
  "discord-app": "discord",
  "docker-desktop": "docker",
  "docker-hub": "docker",
  firefox: "firefoxbrowser",
  "github-desktop": "github",
  "github-trending": "github",
  "google-scholar": "google",
  "huggingface-papers": "huggingface",
  "lm-studio": "lmstudio",
  "microsoft-excel": "microsoftexcel",
  "microsoft-powerpoint": "microsoftpowerpoint",
  "microsoft-teams": "microsoftteams",
  "microsoft-word": "microsoftword",
  "netease-music": "neteasecloudmusic",
  "npm-trends": "npm",
  "openai-responses": "openai",
  "pub-dev": "dart",
  qweather: "icloud",
  "slay-the-spire-ii": "steam",
  "wechat-channels": "wechat",
  "wechat-work": "wechat",
  "yahoo-finance": "yahoo",
  "yt-dlp": "youtube",
  "zoom-app": "zoom",
  "1688": "alibabadotcom",
  amazon: "amazon",
  antigravity: "google",
  arxiv: "arxiv",
  aws: "amazonaws",
  band: "bandlab",
  barchart: "chartdotjs",
  bbc: "bbc",
  bilibili: "bilibili",
  binance: "binance",
  blender: "blender",
  bluesky: "bluesky",
  bloomberg: "bloomberg",
  chatgpt: "openai",
  chrome: "googlechrome",
  cnn: "cnn",
  claude: "anthropic",
  cloudcompare: "cloudinary",
  cocoapods: "cocoapods",
  codex: "openai",
  coinbase: "coinbase",
  coupang: "coupang",
  cursor: "cursor",
  deepseek: "deepseek",
  dingtalk: "dingtalk",
  docker: "docker",
  douban: "douban",
  douyin: "tiktok",
  figma: "figma",
  ffmpeg: "ffmpeg",
  freecad: "freecad",
  gemini: "googlegemini",
  gh: "github",
  gimp: "gimp",
  gitkraken: "gitkraken",
  gitlab: "gitlab",
  google: "google",
  hackernews: "ycombinator",
  hf: "huggingface",
  homebrew: "homebrew",
  imagemagick: "imagemagick",
  instagram: "instagram",
  insomnia: "insomnia",
  jq: "json",
  lark: "lark",
  linear: "linear",
  macos: "apple",
  mastodon: "mastodon",
  maven: "apachemaven",
  mermaid: "mermaid",
  netlify: "netlify",
  notion: "notion",
  npm: "npm",
  nytimes: "newyorktimes",
  nuget: "nuget",
  obsidian: "obsidian",
  openrouter: "openai",
  packagist: "packagist",
  pandoc: "pandoc",
  pexels: "pexels",
  pixiv: "pixiv",
  postman: "postman",
  powerpoint: "microsoftpowerpoint",
  producthunt: "producthunt",
  pypi: "pypi",
  qwen: "alibabacloud",
  reddit: "reddit",
  replicate: "replicate",
  reuters: "reuters",
  rubygems: "rubygems",
  signal: "signal",
  slack: "slack",
  spotify: "spotify",
  stackoverflow: "stackoverflow",
  steam: "steam",
  supabase: "supabase",
  teams: "microsoftteams",
  tiktok: "tiktok",
  todoist: "todoist",
  twitch: "twitch",
  twitter: "x",
  typora: "typora",
  unsplash: "unsplash",
  vercel: "vercel",
  viber: "viber",
  vscode: "visualstudiocode",
  weibo: "sinaweibo",
  whatsapp: "whatsapp",
  wikipedia: "wikipedia",
  word: "microsoftword",
  xiaohongshu: "xiaohongshu",
  youtube: "youtube",
  zhihu: "zhihu",
  zoom: "zoom",
  zotero: "zotero",
};

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

function categoryRank(category: string): number {
  const rank = CATEGORY_ORDER.indexOf(category);
  return rank === -1 ? CATEGORY_ORDER.length : rank;
}

function badgeUrl(
  site: string,
  commandCount: number,
  category: string,
): string {
  const params = new URLSearchParams({
    label: site,
    message: `${commandCount} cmds`,
    color: CATEGORY_COLORS[category] ?? CATEGORY_COLORS.other,
    style: "flat-square",
  });
  const logo = SITE_LOGOS[site];
  if (logo) {
    params.set("logo", logo);
    params.set("logoColor", "white");
  }
  return `https://img.shields.io/static/v1?${params.toString()}`;
}

export function buildSiteGrid(
  manifest: Manifest,
  categoryLabels: Record<string, string> = {},
): string {
  const rows = Object.entries(manifest.sites)
    .map(([site, info]) => {
      const commandCount = info.commands.filter(
        (command) => command.quarantined !== true,
      ).length;
      return {
        site,
        category: info.category ?? "other",
        commandCount,
      };
    })
    .filter((row) => row.commandCount > 0 && SITE_LOGOS[row.site])
    .sort(
      (a, b) =>
        categoryRank(a.category) - categoryRank(b.category) ||
        a.site.localeCompare(b.site),
    );

  const byCategory = new Map<string, typeof rows>();
  for (const row of rows) {
    const categoryRows = byCategory.get(row.category) ?? [];
    categoryRows.push(row);
    byCategory.set(row.category, categoryRows);
  }

  const sections = Array.from(byCategory.entries()).map(([category, sites]) => {
    const badges = sites
      .map((row) => {
        const title = `${row.site}: ${row.commandCount} command${row.commandCount === 1 ? "" : "s"}`;
        return `<a data-site="${row.site}" href="https://olo-dot-io.github.io/Uni-CLI/reference/sites" title="${title}"><img alt="${row.site}" src="${badgeUrl(row.site, row.commandCount, category)}"></a>`;
      })
      .join("\n  ");
    return `<p><strong>${categoryLabels[category] ?? category}</strong><br>\n  ${badges}\n</p>`;
  });

  return [
    SITE_GRID_START,
    '<div align="center">',
    ...sections,
    "</div>",
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
