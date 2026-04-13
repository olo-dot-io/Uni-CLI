/**
 * Auto-generate the adapter listing section of AGENTS.md from dist/manifest.json.
 *
 * Reads the build manifest, groups adapters by category, and replaces the
 * content between <!-- BEGIN ADAPTERS --> and <!-- END ADAPTERS --> markers
 * in AGENTS.md. Also updates the header counts between <!-- BEGIN COUNTS -->
 * and <!-- END COUNTS -->.
 *
 * Usage: tsx scripts/build-agents.ts
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const MANIFEST_PATH = join(ROOT, "dist", "manifest.json");
const AGENTS_PATH = join(ROOT, "AGENTS.md");

// ── Category display configuration ────────────────────────────────────────

const CHINESE_SITES = new Set([
  "bilibili",
  "weibo",
  "zhihu",
  "douban",
  "xueqiu",
  "linux-do",
  "jike",
  "zsxq",
  "tieba",
  "weread",
  "v2ex",
  "xiaohongshu",
  "douyin",
  "36kr",
  "sspai",
  "smzdm",
  "taobao",
  "pinduoduo",
  "meituan",
  "ctrip",
  "netease-music",
  "eastmoney",
  "cnki",
  "jd",
  "1688",
  "weixin",
  "sinablog",
  "hupu",
  "kuaishou",
  "douyu",
  "sinafinance",
  "futu",
  "dianping",
  "xianyu",
  "ele",
  "dangdang",
  "maoyan",
  "toutiao",
  "baidu",
  "wechat-channels",
  "xiaoe",
  "mubu",
  "jianyu",
  "ke",
  "maimai",
  "quark",
  "jimeng",
  "yuanbao",
  "doubao",
  "doubao-web",
  "minimax",
  "chaoxing",
  "xiaoyuzhou",
]);

// Categories that appear as web sub-sections
const WEB_CATEGORIES = new Set([
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
  "jobs",
  "games",
  "utility",
]);

// ── Types ──────────────────────────────────────────────────────────────────

interface ManifestCommand {
  name: string;
  description: string;
  strategy: string;
  type: string;
}

interface ManifestSite {
  commands: ManifestCommand[];
  category: string;
}

interface Manifest {
  version: string;
  sites: Record<string, ManifestSite>;
}

// ── Main ───────────────────────────────────────────────────────────────────

function main(): void {
  if (!existsSync(MANIFEST_PATH)) {
    console.error(
      "Error: dist/manifest.json not found. Run `npm run build` first.",
    );
    process.exit(1);
  }

  if (!existsSync(AGENTS_PATH)) {
    console.error("Error: AGENTS.md not found.");
    process.exit(1);
  }

  const manifest: Manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
  const agentsMd = readFileSync(AGENTS_PATH, "utf-8");

  // Gather stats
  const siteCount = Object.keys(manifest.sites).length;
  const cmdCount = Object.values(manifest.sites).reduce(
    (sum, s) => sum + s.commands.length,
    0,
  );

  // Group sites by category
  const byCategory: Record<
    string,
    Array<{ site: string; info: ManifestSite }>
  > = {};
  for (const [site, info] of Object.entries(manifest.sites)) {
    const cat = info.category || "other";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push({ site, info });
  }

  // Sort sites within each category alphabetically
  for (const entries of Object.values(byCategory)) {
    entries.sort((a, b) => a.site.localeCompare(b.site));
  }

  // ── Generate adapter listing ──────────────────────────────────────────

  const lines: string[] = [];

  // Count web sites (all WEB_CATEGORIES)
  let webSiteCount = 0;
  for (const cat of WEB_CATEGORIES) {
    webSiteCount += (byCategory[cat] || []).length;
  }

  lines.push(`## What You Can Do`);
  lines.push("");
  lines.push(`### Web (${webSiteCount}+ sites)`);
  lines.push("");

  // Web sub-categories, split Chinese vs International for social/video/etc.
  const webCategoryOrder = [
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
    "jobs",
    "games",
    "utility",
  ];

  // Sites classified as "other" that are actually web services (not desktop/bridge)
  const KNOWN_DESKTOP_OTHER = new Set([
    "audacity",
    "cloudcompare",
    "kdenlive",
    "krita",
    "renderdoc",
    "shotcut",
    "sketch",
    "godot",
    "motion-studio",
    "slay-the-spire-ii",
    "wiremock",
  ]);
  const KNOWN_CLI_OTHER = new Set([
    "gh",
    "jq",
    "yt-dlp",
    "aws",
    "az",
    "doctl",
    "flyctl",
    "gcloud",
    "neonctl",
    "netlify",
    "pscale",
    "railway",
    "supabase",
    "vercel",
    "wrangler",
    "claude-code",
    "codex",
    "codex-cli",
    "opencode",
    "lark",
    "slock",
    "stagehand",
    "autoagent",
    "cua",
    "hermes",
    "openharness",
  ]);

  // Collect Chinese and International sites across all web categories + other
  const chineseSites: Array<{ site: string; count: number }> = [];
  const internationalSites: Array<{ site: string; count: number }> = [];
  const aiSites: Array<{ site: string; count: number }> = [];
  const financeSites: Array<{ site: string; count: number }> = [];
  const devSites: Array<{ site: string; count: number }> = [];
  const newsSites: Array<{ site: string; count: number }> = [];
  const referenceSites: Array<{ site: string; count: number }> = [];

  // Include "other" web services in the web count
  const otherWebSites = (byCategory["other"] || []).filter(
    (e) => !KNOWN_DESKTOP_OTHER.has(e.site) && !KNOWN_CLI_OTHER.has(e.site),
  );
  webSiteCount += otherWebSites.length;

  const allWebCategories = [...webCategoryOrder, "other"];
  for (const cat of allWebCategories) {
    const entries = byCategory[cat] || [];
    for (const { site, info } of entries) {
      // Skip desktop and CLI tools from the "other" category
      if (
        cat === "other" &&
        (KNOWN_DESKTOP_OTHER.has(site) || KNOWN_CLI_OTHER.has(site))
      ) {
        continue;
      }

      const count = info.commands.length;
      const entry = { site, count };

      if (cat === "ai") {
        aiSites.push(entry);
      } else if (cat === "finance") {
        financeSites.push(entry);
      } else if (cat === "dev") {
        devSites.push(entry);
      } else if (cat === "news") {
        newsSites.push(entry);
      } else if (cat === "reference" || cat === "audio" || cat === "utility") {
        referenceSites.push(entry);
      } else if (CHINESE_SITES.has(site)) {
        chineseSites.push(entry);
      } else {
        internationalSites.push(entry);
      }
    }
  }

  function formatSiteList(
    sites: Array<{ site: string; count: number }>,
  ): string {
    return sites
      .map((s) => (s.count > 1 ? `${s.site} (${s.count})` : s.site))
      .join(", ");
  }

  if (chineseSites.length > 0) {
    lines.push(`**Chinese**: ${formatSiteList(chineseSites)}`);
    lines.push("");
  }

  if (internationalSites.length > 0) {
    lines.push(`**International**: ${formatSiteList(internationalSites)}`);
    lines.push("");
  }

  if (aiSites.length > 0) {
    lines.push(`**AI / ML**: ${formatSiteList(aiSites)}`);
    lines.push("");
  }

  if (financeSites.length > 0) {
    lines.push(`**Finance**: ${formatSiteList(financeSites)}`);
    lines.push("");
  }

  if (devSites.length > 0) {
    lines.push(`**Developer**: ${formatSiteList(devSites)}`);
    lines.push("");
  }

  if (newsSites.length > 0) {
    lines.push(`**News**: ${formatSiteList(newsSites)}`);
    lines.push("");
  }

  if (referenceSites.length > 0) {
    lines.push(`**Reference**: ${formatSiteList(referenceSites)}`);
    lines.push("");
  }

  // macOS section
  const macosEntry = byCategory["desktop"]?.find((e) => e.site === "macos");
  if (macosEntry) {
    const cmds = macosEntry.info.commands.map((c) => c.name).join(", ");
    lines.push(`### macOS (${macosEntry.info.commands.length} cmds)`);
    lines.push("");
    lines.push(cmds);
    lines.push("");
  }

  // Desktop section (non-macos, includes desktop tools from "other")
  const desktopEntries = [
    ...(byCategory["desktop"] || []).filter((e) => e.site !== "macos"),
    ...(byCategory["other"] || []).filter((e) =>
      KNOWN_DESKTOP_OTHER.has(e.site),
    ),
  ];
  desktopEntries.sort((a, b) => a.site.localeCompare(b.site));
  if (desktopEntries.length > 0) {
    lines.push(`### Desktop (${desktopEntries.length} apps)`);
    lines.push("");
    const desktopList = desktopEntries
      .map((e) => {
        const count = e.info.commands.length;
        return count > 1 ? `${e.site} (${count} cmds)` : e.site;
      })
      .join(", ");
    lines.push(desktopList);
    lines.push("");
  }

  // Bridge section (known bridge CLIs from any category)
  const bridgeEntries = byCategory["bridge"] || [];
  const knownBridge = ["gh", "yt-dlp", "jq"];
  const allOtherEntries = byCategory["other"] || [];
  const bridgeSites = [
    ...bridgeEntries,
    ...allOtherEntries.filter((e) => knownBridge.includes(e.site)),
  ];
  bridgeSites.sort((a, b) => a.site.localeCompare(b.site));

  if (bridgeSites.length > 0) {
    lines.push(`### Bridge (${bridgeSites.length} CLIs)`);
    lines.push("");
    const bridgeList = bridgeSites
      .map((e) => {
        const count = e.info.commands.length;
        return count > 1 ? `${e.site} (${count} cmds)` : e.site;
      })
      .join(", ");
    lines.push(bridgeList);
  }

  // ── Replace sections in AGENTS.md ─────────────────────────────────────

  let updated = agentsMd;

  // Replace ADAPTERS section
  const adapterRegex = /<!-- BEGIN ADAPTERS -->\n[\s\S]*?<!-- END ADAPTERS -->/;
  if (adapterRegex.test(updated)) {
    const adapterContent = lines.join("\n");
    updated = updated.replace(
      adapterRegex,
      `<!-- BEGIN ADAPTERS -->\n${adapterContent}\n<!-- END ADAPTERS -->`,
    );
  } else {
    console.warn(
      "Warning: <!-- BEGIN ADAPTERS --> / <!-- END ADAPTERS --> markers not found in AGENTS.md",
    );
  }

  // Replace COUNTS section
  const countsRegex = /<!-- BEGIN COUNTS -->\n[\s\S]*?<!-- END COUNTS -->/;
  if (countsRegex.test(updated)) {
    const countsLine = `> ${siteCount} sites, ${cmdCount} commands, 35 pipeline steps, BM25 bilingual search. \`npm install -g @zenalexa/unicli\``;
    updated = updated.replace(
      countsRegex,
      `<!-- BEGIN COUNTS -->\n${countsLine}\n<!-- END COUNTS -->`,
    );
  } else {
    console.warn(
      "Warning: <!-- BEGIN COUNTS --> / <!-- END COUNTS --> markers not found in AGENTS.md",
    );
  }

  writeFileSync(AGENTS_PATH, updated);

  console.log(
    `AGENTS.md updated: ${siteCount} sites, ${cmdCount} commands across ${Object.keys(byCategory).length} categories`,
  );
}

main();
