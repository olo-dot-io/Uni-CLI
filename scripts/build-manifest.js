/**
 * @owner   scripts/build-manifest.js
 * @does    Build adapter discovery manifests and compact catalog artifacts.
 * @needs   src/adapters YAML files, TypeScript adapter registrations
 * @feeds   dist/manifest.json, dist/manifest-compact.txt
 * @breaks  Stale manifest metadata hides commands from CLI and docs discovery.
 */

import {
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { join, extname, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { dedupeCommands, extractTsRegistrations } from "./manifest-ts-scan.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADAPTERS_DIR = join(__dirname, "..", "src", "adapters");
const DIST_DIR = join(__dirname, "..", "dist");

mkdirSync(DIST_DIR, { recursive: true });
const PKG = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf-8"),
);

const SKIP_FILES = new Set(["client", "wbi", "innertube", "index"]);

// ── Category mapping (mirrors discovery/aliases.ts SITE_CATEGORIES) ─────────

const CATEGORIES = {
  social: [
    "twitter",
    "weibo",
    "zhihu",
    "douban",
    "jike",
    "xiaohongshu",
    "tieba",
    "v2ex",
    "linux-do",
    "reddit",
    "bluesky",
    "mastodon",
    "facebook",
    "instagram",
    "band",
    "lobsters",
    "hupu",
    "slack",
    "discord-app",
    "signal",
    "whatsapp",
    "teams",
    "dingtalk",
    "lark",
    "feishu",
    "wechat-work",
    "weixin",
    "threads",
    "rednote",
    "1point3acres",
    "imessage",
    "zoom-app",
    "zoom",
  ],
  video: [
    "bilibili",
    "youtube",
    "douyin",
    "tiktok",
    "twitch",
    "kuaishou",
    "douyu",
    "yt-dlp",
  ],
  news: [
    "hackernews",
    "bbc",
    "cnn",
    "nytimes",
    "reuters",
    "36kr",
    "techcrunch",
    "theverge",
    "infoq",
    "ithome",
    "bloomberg",
  ],
  finance: [
    "xueqiu",
    "eastmoney",
    "sinafinance",
    "yahoo-finance",
    "barchart",
    "binance",
    "futu",
    "coinbase",
    "coingecko",
    "defillama",
  ],
  shopping: [
    "amazon",
    "jd",
    "taobao",
    "pinduoduo",
    "1688",
    "smzdm",
    "meituan",
    "coupang",
    "xianyu",
    "dianping",
    "dangdang",
    "ele",
    "maoyan",
  ],
  travel: ["ctrip"],
  dev: [
    "github-trending",
    "gitlab",
    "gitee",
    "npm",
    "pypi",
    "crates-io",
    "maven",
    "nuget",
    "rubygems",
    "packagist",
    "pub-dev",
    "cocoapods",
    "docker-hub",
    "npm-trends",
    "homebrew",
    "stackoverflow",
    "devto",
    "producthunt",
    "cursor",
    "codex",
    "codex-cli",
    "claude-code",
    "opencode",
    "vscode",
    "postman",
    "insomnia",
    "github-desktop",
    "gitkraken",
    "docker-desktop",
    "gh",
    "crates",
    "dockerhub",
    "goproxy",
    "wiremock",
    "juejin",
    "osv",
    "openharness",
  ],
  ai: [
    "ollama",
    "openrouter",
    "hf",
    "replicate",
    "deepseek",
    "perplexity",
    "grok",
    "gemini",
    "minimax",
    "doubao",
    "doubao-web",
    "doubao-app",
    "novita",
    "notebooklm",
    "chatgpt",
    "chatwise",
    "antigravity",
    "claude",
    "lm-studio",
    "yuanbao",
    "qwen",
    "chatgpt-app",
    "yollomi",
    "jimeng",
  ],
  scholarly: [
    "arxiv",
    "semantic-scholar",
    "crossref",
    "unpaywall",
    "openalex",
    "openreview",
    "dblp",
    "pubmed",
    "acl-anthology",
    "pmlr",
    "cvf",
    "neurips",
    "cnki",
    "wanfang",
    "google-scholar",
    "baidu-scholar",
    "huggingface-papers",
    "paperreview",
    "zotero",
  ],
  patent: [
    "epo",
    "espacenet",
    "cipo",
    "cnipa",
    "uspto",
    "dpma",
    "fips",
    "freepatentsonline-web",
    "google-patents-bq",
    "google-patents-web",
    "inpi-br",
    "inpi-fr",
    "ipaustralia",
    "jpo",
    "kipris",
    "patsnap",
    "pqai",
  ],
  reference: [
    "google",
    "wikipedia",
    "marxists-cn",
    "moegirl",
    "anilist",
    "jikan",
    "bangumi",
    "kitsu",
    "mangadex",
    "dictionary",
    "chaoxing",
    "imdb",
  ],
  audio: ["spotify", "netease-music", "apple-podcasts", "xiaoyuzhou"],
  content: [
    "medium",
    "substack",
    "lesswrong",
    "sinablog",
    "toutiao",
    "sspai",
    "weread",
    "zsxq",
    "pixiv",
    "danbooru",
    "ehentai",
    "dlsite",
    "vndb",
    "yandere",
    "konachan",
    "safebooru",
  ],
  productivity: [
    "notion",
    "notion-app",
    "obsidian",
    "logseq",
    "typora",
    "evernote-app",
    "mubu",
    "apple-notes",
    "ones",
    "quark",
  ],
  jobs: ["boss", "linkedin", "nowcoder", "51job", "indeed", "maimai"],
  desktop: [
    "macos",
    "ffmpeg",
    "imagemagick",
    "blender",
    "gimp",
    "freecad",
    "inkscape",
    "pandoc",
    "libreoffice",
    "word",
    "excel",
    "powerpoint",
    "mermaid",
    "musescore",
    "drawio",
    "docker",
    "comfyui",
    "figma",
    "audacity",
    "obs",
    "cloudcompare",
    "krita",
    "kdenlive",
    "shotcut",
    "renderdoc",
  ],
  games: ["steam"],
  utility: [
    "exchangerate",
    "ip-info",
    "qweather",
    "web",
    "bitwarden",
    "linear",
    "todoist",
  ],
};

function getCategory(site) {
  for (const [cat, sites] of Object.entries(CATEGORIES)) {
    if (sites.includes(site)) return cat;
  }
  return "other";
}

function serializeArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  return Object.entries(args).map(([name, raw]) => {
    const def = raw && typeof raw === "object" ? raw : {};
    const arg = {
      name,
      type: def.type ?? "str",
      required: def.required === true,
      positional: def.positional === true,
    };
    if (def.default !== undefined) arg.default = def.default;
    if (Array.isArray(def.choices)) arg.choices = def.choices;
    if (def.description) arg.description = def.description;
    if (def.format) arg.format = def.format;
    if (def["x-unicli-kind"]) arg["x-unicli-kind"] = def["x-unicli-kind"];
    if (def["x-unicli-accepts"]) {
      arg["x-unicli-accepts"] = def["x-unicli-accepts"];
    }
    return arg;
  });
}

function serializeColumns(columns) {
  return Array.isArray(columns)
    ? columns.filter((column) => typeof column === "string")
    : [];
}

// ── Scan Adapters ───────────────────────────────────────────────────────────

const manifest = { version: PKG.version, sites: {} };
const extraCommandsBySite = new Map();

function addExtraCommands(site, commands) {
  const existing = extraCommandsBySite.get(site) ?? [];
  existing.push(...commands);
  extraCommandsBySite.set(site, existing);
}

if (existsSync(ADAPTERS_DIR)) {
  for (const site of readdirSync(ADAPTERS_DIR)) {
    if (site.startsWith("_") || site.startsWith(".")) continue;
    const siteDir = join(ADAPTERS_DIR, site);
    if (!statSync(siteDir).isDirectory()) continue;

    const commands = [];

    for (const file of readdirSync(siteDir)) {
      const ext = extname(file);
      const cmdName = basename(file, ext);

      if (ext === ".yaml" || ext === ".yml") {
        try {
          const raw = readFileSync(join(siteDir, file), "utf-8");
          const parsed = yaml.load(raw);
          commands.push({
            name: cmdName,
            description: parsed.description || "",
            strategy: parsed.strategy || "public",
            type: parsed.type || "web-api",
            domain: parsed.domain,
            base: parsed.base,
            browser: parsed.browser === true,
            quarantined: parsed.quarantine === true,
            args: serializeArgs(parsed.args),
            columns: serializeColumns(parsed.columns),
            defaultFormat: parsed.defaultFormat,
            pipeline_steps: Array.isArray(parsed.pipeline)
              ? parsed.pipeline.length
              : 0,
            adapter_path: `src/adapters/${site}/${file}`,
          });
        } catch {
          // Skip malformed YAML
        }
      } else if (ext === ".ts" && !SKIP_FILES.has(cmdName)) {
        try {
          const source = readFileSync(join(siteDir, file), "utf-8");
          for (const reg of extractTsRegistrations(source, site, cmdName)) {
            if (reg.site === site) {
              commands.push(...reg.commands);
            } else {
              addExtraCommands(reg.site, reg.commands);
            }
          }
        } catch {
          // Skip unreadable TS files
        }
      }
    }

    if (commands.length > 0) {
      manifest.sites[site] = {
        commands: dedupeCommands(commands),
        category: getCategory(site),
      };
    }
  }
}

for (const [site, extraCommands] of extraCommandsBySite) {
  const current = manifest.sites[site] ?? {
    commands: [],
    category: getCategory(site),
  };
  const seen = new Set(current.commands.map((cmd) => cmd.name));
  for (const cmd of dedupeCommands(extraCommands)) {
    if (!seen.has(cmd.name)) {
      current.commands.push(cmd);
      seen.add(cmd.name);
    }
  }
  current.commands.sort((a, b) => a.name.localeCompare(b.name));
  manifest.sites[site] = current;
}

// ── Output 1: Full manifest ─────────────────────────────────────────────────

writeFileSync(
  join(DIST_DIR, "manifest.json"),
  JSON.stringify(manifest, null, 2),
);

// ── Output 2: Compact catalog ───────────────────────────────────────────────
// Format: "category: site(cmd1, cmd2, ...), site2(cmd1, cmd2, ...)"
// Target: ~2-3K tokens for AGENTS.md embedding

const byCategory = {};
for (const [site, info] of Object.entries(manifest.sites)) {
  const cat = info.category || "other";
  if (!byCategory[cat]) byCategory[cat] = [];
  const cmds = info.commands.map((c) => c.name).join(", ");
  byCategory[cat].push(`${site}(${cmds})`);
}

const compactLines = [];
for (const [cat, entries] of Object.entries(byCategory)) {
  compactLines.push(`${cat}: ${entries.join(", ")}`);
}

writeFileSync(join(DIST_DIR, "manifest-compact.txt"), compactLines.join("\n"));

// ── Summary ─────────────────────────────────────────────────────────────────

const siteCount = Object.keys(manifest.sites).length;
const cmdCount = Object.values(manifest.sites).reduce(
  (sum, s) => sum + s.commands.length,
  0,
);
console.log(
  `Manifest: ${siteCount} sites, ${cmdCount} commands → dist/manifest.json`,
);
console.log(
  `Compact catalog: ${compactLines.length} categories → dist/manifest-compact.txt`,
);
