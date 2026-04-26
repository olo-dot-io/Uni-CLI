/**
 * Build manifest — generates multiple index files for adapter discovery.
 *
 * Outputs:
 *   1. dist/manifest.json       — Full metadata (existing, enhanced)
 *   2. dist/manifest-search.json — BM25 inverted index + IDF values
 *   3. dist/manifest-compact.txt — Compressed catalog for AGENTS.md embedding
 *
 * Scans YAML files directly and TS adapters through the TypeScript AST to
 * produce a complete manifest.
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
    "word",
    "excel",
    "powerpoint",
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
