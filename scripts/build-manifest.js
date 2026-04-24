/**
 * Build manifest — generates multiple index files for adapter discovery.
 *
 * Outputs:
 *   1. dist/manifest.json       — Full metadata (existing, enhanced)
 *   2. dist/manifest-search.json — BM25 inverted index + IDF values
 *   3. dist/manifest-compact.txt — Compressed catalog for AGENTS.md embedding
 *
 * Scans both YAML files (parsed directly) and TS files (regex extraction
 * of cli() metadata) to produce a complete manifest.
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADAPTERS_DIR = join(__dirname, "..", "src", "adapters");
const DIST_DIR = join(__dirname, "..", "dist");

mkdirSync(DIST_DIR, { recursive: true });
const PKG = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf-8"),
);

// ── Helpers ─────────────────────────────────────────────────────────────────

function extractProp(source, prop) {
  const re = new RegExp(`${prop}:\\s*["'\`]([^"'\`]+)["'\`]`);
  const m = source.match(re);
  return m ? m[1] : "";
}

function extractStrategy(source) {
  const m = source.match(/strategy:\s*Strategy\.(\w+)/);
  if (m) return m[1].toLowerCase();
  const m2 = source.match(/strategy:\s*["'](\w+)["']/);
  return m2 ? m2[1] : "public";
}

const ELECTRON_DESKTOP_BASE_COMMANDS = [
  [
    "open-app",
    "Open desktop Electron app with CDP enabled. 打开桌面版 Electron app 并启用 CDP 控制",
  ],
  [
    "status-app",
    "Inspect desktop Electron app title, URL, visible controls, and text. 查看桌面版状态和内容",
  ],
  [
    "dump",
    "Dump visible DOM text from desktop Electron app. 读取桌面版可见文本内容",
  ],
  [
    "snapshot-app",
    "List visible clickable text, buttons, inputs, and regions in desktop Electron app. 枚举桌面版可交互控件",
  ],
  [
    "click-text",
    "Click visible text, aria-label, title, or button content in desktop Electron app. 按文本点击桌面版控件",
  ],
  [
    "type-text",
    "Type text into the focused field or a text-matched target in desktop Electron app. 向桌面版输入文本",
  ],
  [
    "press",
    "Press a key in desktop Electron app, with optional modifiers. 向桌面版发送按键",
  ],
];

const ELECTRON_DESKTOP_MEDIA_COMMANDS = [
  [
    "play-liked",
    "Open liked songs and play the liked playlist in desktop Electron music app. 打开我喜欢的音乐并播放",
  ],
  ["play", "Start playback in desktop Electron music app. 播放音乐"],
  ["pause", "Pause playback in desktop Electron music app. 暂停音乐"],
  ["toggle", "Toggle playback in desktop Electron music app. 切换播放暂停"],
  ["next", "Skip to next track in desktop Electron music app. 下一首"],
  ["prev", "Skip to previous track in desktop Electron music app. 上一首"],
];

function extractElectronDesktopRegistrations(source) {
  const out = [];
  const re =
    /registerElectronDesktopCommands\(\s*["'`]([^"'`]+)["'`]\s*(?:,\s*(\{[\s\S]*?\})\s*)?\)/g;
  for (const match of source.matchAll(re)) {
    const site = match[1];
    const options = match[2] ?? "";
    const displayName =
      options.match(/displayName:\s*["'`]([^"'`]+)["'`]/)?.[1] ?? site;
    const hasMedia = /\bmedia\s*:/.test(options);
    const commands = ELECTRON_DESKTOP_BASE_COMMANDS.map(([name, desc]) => ({
      name,
      description: `${desc} ${displayName}`,
      strategy: "public",
      type: "web-api",
    }));
    if (hasMedia) {
      commands.push(
        ...ELECTRON_DESKTOP_MEDIA_COMMANDS.map(([name, desc]) => ({
          name,
          description: `${desc} ${displayName}`,
          strategy: "public",
          type: "web-api",
        })),
      );
    }
    out.push({ site, commands });
  }
  return out;
}

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
    "wechat-work",
    "zoom-app",
  ],
  video: [
    "bilibili",
    "youtube",
    "douyin",
    "tiktok",
    "twitch",
    "kuaishou",
    "douyu",
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
  dev: [
    "github-trending",
    "gitlab",
    "gitee",
    "npm",
    "pypi",
    "crates-io",
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
  ],
  ai: [
    "ollama",
    "openrouter",
    "hf",
    "huggingface-papers",
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
  ],
  reference: [
    "google",
    "wikipedia",
    "arxiv",
    "dictionary",
    "cnki",
    "chaoxing",
    "imdb",
    "paperreview",
  ],
  audio: ["spotify", "netease-music", "apple-podcasts", "xiaoyuzhou"],
  content: ["medium", "substack", "sspai", "weread", "zsxq", "pixiv"],
  productivity: [
    "notion",
    "notion-app",
    "obsidian",
    "logseq",
    "typora",
    "evernote-app",
    "mubu",
    "apple-notes",
  ],
  jobs: ["boss", "linkedin"],
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
    "mermaid",
    "musescore",
    "drawio",
    "docker",
    "comfyui",
    "figma",
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

// ── Scan Adapters ───────────────────────────────────────────────────────────

const manifest = { version: PKG.version, sites: {} };
const extraCommandsBySite = new Map();

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
          });
        } catch {
          // Skip malformed YAML
        }
      } else if (ext === ".ts" && !SKIP_FILES.has(cmdName)) {
        try {
          const source = readFileSync(join(siteDir, file), "utf-8");
          for (const reg of extractElectronDesktopRegistrations(source)) {
            const existing = extraCommandsBySite.get(reg.site) ?? [];
            existing.push(...reg.commands);
            extraCommandsBySite.set(reg.site, existing);
          }
          if (!source.includes("cli(")) continue;

          const name = extractProp(source, "name") || cmdName;
          const description = extractProp(source, "description");
          const strategy = extractStrategy(source);

          commands.push({ name, description, strategy, type: "web-api" });
        } catch {
          // Skip unreadable TS files
        }
      }
    }

    if (commands.length > 0) {
      commands.sort((a, b) => a.name.localeCompare(b.name));
      manifest.sites[site] = {
        commands,
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
  for (const cmd of extraCommands) {
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

// ── Output 2: BM25 Search Index ─────────────────────────────────────────────
// Mirrors the buildIndex() function from src/discovery/search.ts
// but runs at build time in plain JS (no TypeScript import).

// Minimal English stopwords — same set used in src/discovery tokenizers
const DOC_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "for",
  "and",
  "or",
  "in",
  "to",
  "on",
  "by",
  "is",
  "it",
  "be",
  "as",
  "at",
  "so",
  "we",
  "he",
  "do",
  "no",
  "if",
  "up",
  "my",
]);

// Keep alphanumeric, CJK (all planes incl. supplementary), and whitespace
const DOC_CLEAN_REGEX =
  /[^a-z0-9\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u{20000}-\u{2a6df}\u{2a700}-\u{2b73f}\u{2b740}-\u{2b81f}\u{2b820}-\u{2ceaf}\u{2ceb0}-\u{2ebef}\u{30000}-\u{3134f}\u{31350}-\u{323af}\s]/gu;

function tokenizeDoc(site, command, description) {
  const terms = [];
  const siteParts = site.toLowerCase().split(/[-_]/);
  terms.push(site.toLowerCase(), ...siteParts);

  const cmdParts = command.toLowerCase().split(/[-_]/);
  terms.push(command.toLowerCase(), ...cmdParts);

  // NFKC normalize description (full-width → half-width, etc.)
  const normalizedDesc = description.normalize("NFKC");

  const descWords = normalizedDesc
    .toLowerCase()
    .replace(DOC_CLEAN_REGEX, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !DOC_STOPWORDS.has(w));
  terms.push(...descWords);

  const category = getCategory(site);
  if (category !== "other") terms.push(category);

  return terms;
}

const documents = [];
for (const [site, info] of Object.entries(manifest.sites)) {
  for (const cmd of info.commands) {
    const terms = tokenizeDoc(site, cmd.name, cmd.description);
    documents.push({
      id: `${site}/${cmd.name}`,
      site,
      command: cmd.name,
      description: cmd.description,
      terms,
    });
  }
}

const N = documents.length;
const avgDl =
  N > 0 ? documents.reduce((sum, d) => sum + d.terms.length, 0) / N : 0;

// Inverted index
const postings = {};
for (let i = 0; i < documents.length; i++) {
  const seen = new Set();
  for (const term of documents[i].terms) {
    if (seen.has(term)) continue;
    seen.add(term);
    if (!postings[term]) postings[term] = [];
    postings[term].push(i);
  }
}

// IDF values
const idf = {};
for (const [term, docs] of Object.entries(postings)) {
  const df = docs.length;
  idf[term] = Math.log((N - df + 0.5) / (df + 0.5) + 1);
}

const searchIndex = { postings, idf, documents, avgDl, N };
writeFileSync(
  join(DIST_DIR, "manifest-search.json"),
  JSON.stringify(searchIndex),
);

// ── Output 3: Compact catalog ───────────────────────────────────────────────
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
const indexTerms = Object.keys(postings).length;

console.log(
  `Manifest: ${siteCount} sites, ${cmdCount} commands → dist/manifest.json`,
);
console.log(
  `Search index: ${indexTerms} terms, ${N} documents → dist/manifest-search.json`,
);
console.log(
  `Compact catalog: ${compactLines.length} categories → dist/manifest-compact.txt`,
);
