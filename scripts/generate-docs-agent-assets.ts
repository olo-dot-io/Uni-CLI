#!/usr/bin/env tsx
/**
 * Generate agent-facing docs assets from the same site map used by VitePress.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  flatDocPages,
  normalizeDocPath,
  supportedLocales,
  type LocaleKey,
} from "../docs/.vitepress/site-map.js";

type PageIndexEntry = {
  title: string;
  locale: LocaleKey;
  routePath: string;
  markdownPath: string;
  sourceLink: string;
  sourcePath: string;
  section: string;
  parent: { text: string; link: string } | null;
  breadcrumbs: { text: string; link: string }[];
};

type Frontmatter = {
  hero?: {
    text?: string;
    tagline?: string;
    actions?: { text?: string; link?: string }[];
  };
  features?: { title?: string; details?: string }[];
};

type SiteIndex = {
  total_sites: number;
  total_commands: number;
  sites: {
    site: string;
    type: string;
    auth?: boolean;
    command_count: number;
    commands: { command: string }[];
  }[];
};

type Stats = {
  adapter_count_total?: number;
  adapter_count_yaml?: number;
  adapter_count_ts?: number;
  pipeline_step_count?: number;
  pipeline_registered_step_count?: number;
  pipeline_transport_step_count?: number;
  test_count?: number;
};

type ReleaseStatus = "local" | "published";

type ReleaseInfo = {
  version: string;
  codename: string;
  date: string;
  status: ReleaseStatus;
  npmPackage: string;
  npmUrl: string;
  releaseUrl: string;
  changelogUrl: string;
  highlights: Record<LocaleKey, string[]>;
};

const docsRoot = resolve("docs");
const markdownRoot = resolve("docs/public/markdown");
const pageIndexPath = resolve("docs/page-index.json");
const llmsTxtPath = resolve("docs/public/llms.txt");
const llmsFullTxtPath = resolve("docs/public/llms-full.txt");
const publicSiteBase = "https://olo-dot-io.github.io/Uni-CLI";

function sourcePathForRoute(routePath: string, locale: LocaleKey): string {
  const localeRoot = locale === "root" ? docsRoot : resolve(docsRoot, locale);

  if (routePath === "/") {
    return resolve(localeRoot, "index.md");
  }

  const relativeRoute = routePath.replace(/^\/+/, "").replace(/\/$/, "");
  const candidates = [
    resolve(localeRoot, `${relativeRoute}.md`),
    resolve(localeRoot, relativeRoute, "index.md"),
  ];
  const sourcePath = candidates.find((candidate) => existsSync(candidate));

  if (!sourcePath) {
    throw new Error(
      `No markdown source found for ${locale} route ${routePath}`,
    );
  }

  return sourcePath;
}

function splitFrontmatter(markdown: string): {
  frontmatter: Frontmatter;
  body: string;
} {
  const match = /^---\n([\s\S]*?)\n---\n+([\s\S]*)$/.exec(markdown);

  if (!match) {
    return { frontmatter: {}, body: markdown };
  }

  return {
    frontmatter: parseYaml(match[1] ?? "") as Frontmatter,
    body: match[2] ?? "",
  };
}

function removeFirstHeading(markdown: string): string {
  return markdown.replace(/^# .*\n+/, "");
}

function routeDirectory(routePath: string): string {
  if (routePath === "/" || routePath.endsWith("/")) {
    return routePath;
  }

  return posix.dirname(routePath);
}

function rewriteRelativeLinks(markdown: string, routePath: string): string {
  const baseDirectory = routeDirectory(routePath);

  return markdown.replace(
    /(\[[^\]]+\]\()(\.{1,2}\/[^)\s]+)(\))/g,
    (_match, prefix: string, target: string, suffix: string) => {
      const [targetPath, hash = ""] = target.split("#");
      const resolvedPath = normalizeDocPath(
        posix.join(baseDirectory, targetPath),
      );
      return `${prefix}${resolvedPath}${hash ? `#${hash}` : ""}${suffix}`;
    },
  );
}

function markdownFromHomeFrontmatter(
  frontmatter: Frontmatter,
  locale: LocaleKey,
): string {
  const lines: string[] = [];

  if (frontmatter.hero?.text) {
    lines.push(`## ${frontmatter.hero.text}`);
  }

  if (frontmatter.hero?.tagline) {
    lines.push("", frontmatter.hero.tagline);
  }

  if (frontmatter.hero?.actions?.length) {
    lines.push("", locale === "zh" ? "## 主要入口" : "## Primary Actions", "");

    for (const action of frontmatter.hero.actions) {
      if (action.text && action.link) {
        lines.push(`- [${action.text}](${action.link})`);
      }
    }
  }

  if (frontmatter.features?.length) {
    lines.push("", locale === "zh" ? "## 核心能力" : "## Capabilities", "");

    for (const feature of frontmatter.features) {
      if (feature.title && feature.details) {
        lines.push(`- **${feature.title}.** ${feature.details}`);
      }
    }
  }

  return lines.join("\n");
}

function readSiteIndex(): SiteIndex {
  return JSON.parse(
    readFileSync(resolve("docs/site-index.json"), "utf-8"),
  ) as SiteIndex;
}

function readStats(): Stats {
  const statsPath = resolve("stats.json");
  if (!existsSync(statsPath)) {
    return {};
  }

  return JSON.parse(readFileSync(statsPath, "utf-8")) as Stats;
}

function readReleaseInfo(): ReleaseInfo {
  const releaseInfo = JSON.parse(
    readFileSync(resolve("docs/release-info.json"), "utf-8"),
  ) as ReleaseInfo;
  if (releaseInfo.status !== "local" && releaseInfo.status !== "published") {
    throw new Error(
      'docs/release-info.json status must be "local" or "published"',
    );
  }
  return releaseInfo;
}

function toProjectPath(filePath: string): string {
  return relative(process.cwd(), filePath).replace(/\\/g, "/");
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function renderSiteStats(siteIndex: SiteIndex): string {
  const surfaceCounts = siteIndex.sites.reduce<Record<string, number>>(
    (counts, site) => {
      counts[site.type] = (counts[site.type] ?? 0) + 1;
      return counts;
    },
    {},
  );

  return [
    "## Catalog Snapshot",
    "",
    `- Sites: ${siteIndex.total_sites}`,
    `- Commands: ${siteIndex.total_commands}`,
    `- Surface families: ${Object.keys(surfaceCounts).length}`,
    `- Agent envelope: v2`,
    "",
    "| Surface | Sites |",
    "| --- | ---: |",
    ...Object.entries(surfaceCounts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([surface, count]) => `| ${surface} | ${count} |`),
  ].join("\n");
}

function renderSiteStatsZh(siteIndex: SiteIndex): string {
  const surfaceCounts = siteIndex.sites.reduce<Record<string, number>>(
    (counts, site) => {
      counts[site.type] = (counts[site.type] ?? 0) + 1;
      return counts;
    },
    {},
  );

  return [
    "## 目录快照",
    "",
    `- 站点：${siteIndex.total_sites}`,
    `- 命令：${siteIndex.total_commands}`,
    `- 接口类型：${Object.keys(surfaceCounts).length}`,
    `- AgentEnvelope：v2`,
    "",
    "| 接口类型 | 站点数 |",
    "| --- | ---: |",
    ...Object.entries(surfaceCounts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([surface, count]) => `| ${surface} | ${count} |`),
  ].join("\n");
}

function renderVersionNotice(
  releaseInfo: ReleaseInfo,
  siteIndex: SiteIndex,
  locale: LocaleKey,
): string {
  const isZh = locale === "zh";
  const isPublished = releaseInfo.status === "published";
  const highlights = releaseInfo.highlights[locale] ?? [];
  const versionSummary = isPublished
    ? isZh
      ? `v${releaseInfo.version}（${releaseInfo.codename}）已于 ${releaseInfo.date} 发布到 npm，${releaseInfo.npmPackage} 的 latest 当前指向这个版本。`
      : `v${releaseInfo.version} (${releaseInfo.codename}) shipped to npm on ${releaseInfo.date}; the ${releaseInfo.npmPackage} latest tag now points to this release.`
    : isZh
      ? `v${releaseInfo.version}（${releaseInfo.codename}）已于 ${releaseInfo.date} 在本机完成构建与验证；该版本未标记为 npm 或 GitHub Release 已发布。`
      : `v${releaseInfo.version} (${releaseInfo.codename}) was built and verified locally on ${releaseInfo.date}; it is not marked as published to npm or GitHub Releases.`;
  const releaseLinks = [
    `- [${releaseInfo.npmPackage} on npm](${releaseInfo.npmUrl})`,
    ...(isPublished
      ? [
          `- [GitHub Release v${releaseInfo.version}](${releaseInfo.releaseUrl})`,
        ]
      : []),
    `- [Changelog](${releaseInfo.changelogUrl})`,
  ];

  return [
    isZh ? "## 当前版本" : "## Current Version",
    "",
    versionSummary,
    "",
    isZh
      ? `当前公开目录：${siteIndex.total_sites} 个站点，${siteIndex.total_commands} 条命令。`
      : `Current public catalog: ${siteIndex.total_sites} sites, ${siteIndex.total_commands} commands.`,
    "",
    isZh ? "### 更新提示" : "### Update Notes",
    "",
    ...highlights.map((highlight) => `- ${highlight}`),
    "",
    isZh ? "### 链接" : "### Links",
    "",
    ...releaseLinks,
  ].join("\n");
}

function renderSiteCatalog(siteIndex: SiteIndex, locale: LocaleKey): string {
  const copy =
    locale === "zh"
      ? {
          title: "## 生成的站点目录",
          intro: `这个目录来自适配器 manifest：${siteIndex.total_sites} 个站点，${siteIndex.total_commands} 条命令。`,
          headers: "| 站点 | 接口类型 | 命令数 | 认证 | 示例命令 |",
          authYes: "是",
          authNo: "否",
        }
      : {
          title: "## Generated Site Catalog",
          intro: `This catalog is generated from the adapter manifest: ${siteIndex.total_sites} sites, ${siteIndex.total_commands} commands.`,
          headers: "| Site | Surface | Commands | Auth | Example commands |",
          authYes: "yes",
          authNo: "no",
        };

  return [
    copy.title,
    "",
    copy.intro,
    "",
    copy.headers,
    "| --- | --- | ---: | --- | --- |",
    ...siteIndex.sites
      .map((site) => {
        const commands = site.commands
          .slice(0, 3)
          .map((command) => command.command)
          .join("<br>");

        return [
          escapeTableCell(site.site),
          escapeTableCell(site.type),
          site.command_count,
          site.auth ? copy.authYes : copy.authNo,
          escapeTableCell(commands),
        ].join(" | ");
      })
      .map((row) => `| ${row} |`),
  ].join("\n");
}

function renderHomePageMarkdown(
  siteIndex: SiteIndex,
  releaseInfo: ReleaseInfo,
  stats: Stats,
  locale: LocaleKey,
): string {
  const pipelineSteps = stats.pipeline_step_count ?? "see docs";
  const registeredSteps = stats.pipeline_registered_step_count ?? "?";
  const transportSteps = stats.pipeline_transport_step_count ?? "?";
  if (locale === "zh") {
    return [
      "## AI Agent 控制 computer 的通用平台",
      "",
      "Uni-CLI 把网站、登录态浏览器、桌面应用、本地工具、文件、MCP 服务、无障碍树、截图和系统能力收进一套可搜索、可治理、可观察、可修复的操作层。Agent 先按意图选择行动 substrate，再按策略执行，拿到证据回执；失败时还能诊断、修复或换路，直到结果交付。",
      "",
      "## 控制面",
      "",
      "- Intent search",
      "- Policy-gated execution",
      "- AgentEnvelope v2",
      "- MCP + ACP",
      "- Desktop AX",
      "- Visual fallback",
      "- Adapter self-repair",
      "",
      "## 第一条命令",
      "",
      "```bash",
      "npm install -g @zenalexa/unicli",
      'unicli do "找 Hacker News 首页"',
      "unicli extract https://example.com --max-chars 1200",
      "unicli compute snapshot --app Calculator --format compact",
      "unicli mcp serve --transport streamable --port 19826",
      "```",
      "",
      "## 定位",
      "",
      "Agent 执行需要的不是更长的常驻工具列表，也不是又一个网页 wrapper。它需要一只可以控制整台 computer 的通用手。operation search 负责发现操作，operation policy 负责权限和风险，control kernel 负责选择 substrate，v2 AgentEnvelope 负责稳定输出，run evidence 负责复盘，delivery/repair loop 负责把失败指向 source path、替代路径和验证命令。",
      "",
      "- **理解意图。** BM25 双语搜索把自然语言意图收敛到具体站点、操作、参数、认证姿态和风险字段。",
      "- **选择 substrate。** HTTP、Cookie、浏览器 CDP、macOS AX、subprocess、service、protocol 和 visual fallback 走同一套 control kernel。",
      "- **返回证据。** Markdown 是 Agent 默认友好的输出，JSON、YAML、CSV 和 compact 负责程序接入。",
      "- **修复或换路。** 结构化错误带上 source path、step 或边界、retryable、suggestion 和 alternatives。",
      "",
      "## 常见任务",
      "",
      "- `unicli search` 和 `unicli do` 先查本地操作目录，操作选定后再读取参数、认证、风险和输出字段。",
      "- 页面、接口、App 或本地边界失效时，错误 envelope 指出 source path、失败 step 或边界。",
      "- Web API、浏览器、macOS、本地桌面应用、外部 CLI、文件、MCP、ACP、HTTP API 和 agent backend routes 共享同一套 operation contract 与回执。",
      "",
      "## 覆盖范围",
      "",
      `- 站点和工具：${siteIndex.total_sites}`,
      `- 操作：${siteIndex.total_commands}`,
      `- Built-in action：${pipelineSteps}（${registeredSteps} registered + ${transportSteps} transport-native）`,
      `- 测试：${stats.test_count}`,
      "",
      "能力规模来自当前仓库生成物：operation、adapter、built-in action、测试和 substrate 都在本地构建流程里计数。",
      "",
      "## 入口",
      "",
      "- [安装运行](/zh/guide/getting-started)：安装、搜索、执行、认证、输出格式和退出码。",
      "- [操作目录](/zh/reference/sites)：按站点、substrate、认证方式和操作样例检索。",
      "- [适配器](/zh/guide/adapters)：YAML 格式、pipeline step、自修复流程和验证方式。",
      "- [接入 Agent](/zh/guide/integrations)：原生 CLI、MCP、ACP 和可消费输出的取舍。",
      "",
      "## 当前版本",
      "",
      releaseInfo.status === "published"
        ? `当前 latest：v${releaseInfo.version} · ${releaseInfo.codename}。`
        : `本地版本：v${releaseInfo.version} · ${releaseInfo.codename}。`,
      "",
      "## Agent 索引",
      "",
      "- [/llms.txt](/llms.txt)",
      "- [/llms-full.txt](/llms-full.txt)",
    ].join("\n");
  }

  return [
    "## Universal computer-control platform for agents",
    "",
    "Uni-CLI turns websites, logged-in browsers, desktop apps, local tools, files, MCP servers, accessibility trees, screenshots, and system capabilities into searchable, governed, observable, repairable operations. Agents use one path to select an action substrate by intent, inspect risk, execute with policy, return evidence, and repair or reroute the failed source path.",
    "",
    "## Control Surface",
    "",
    "- Intent search",
    "- Policy-gated execution",
    "- AgentEnvelope v2",
    "- MCP + ACP",
    "- Desktop AX",
    "- Visual fallback",
    "- Adapter self-repair",
    "",
    "## First Command",
    "",
    "```bash",
    "npm install -g @zenalexa/unicli",
    'unicli do "find the Hacker News frontpage"',
    "unicli extract https://example.com --max-chars 1200",
    "unicli compute snapshot --app Calculator --format compact",
    "unicli mcp serve --transport streamable --port 19826",
    "```",
    "",
    "## Positioning",
    "",
    "Agent execution does not need a longer resident tool list or another website wrapper. It needs a universal hand for controlling the whole computer. Operation search handles discovery. Operation policy exposes permissions and risk. The control kernel chooses the substrate. The v2 AgentEnvelope stabilizes output. Run evidence supports review. The delivery/repair loop points failures to source paths, alternatives, and verification commands.",
    "",
    "- **Intent.** Bilingual BM25 search turns a natural-language task into a site, operation, arguments, auth posture, and risk fields.",
    "- **Substrate.** HTTP, cookies, browser CDP, macOS AX, subprocess, service, protocol, and visual fallback share one control kernel.",
    "- **Evidence.** Markdown is the agent-friendly default; JSON, YAML, CSV, and compact formats serve programs.",
    "- **Repair or reroute.** Structured errors include source path, step or boundary, retryability, suggestion, and alternatives.",
    "",
    "## Common Tasks",
    "",
    "- `unicli search` and `unicli do` read the local operation catalog first, then execution can inspect operation, args, auth, risk, and output fields.",
    "- When a page, API, app, or local boundary changes, the error envelope names the source path and failing step or boundary.",
    "- Web APIs, browser automation, macOS, desktop apps, external CLIs, files, MCP, ACP, HTTP API, and agent backend routes share the same operation contract and receipt.",
    "",
    "## Coverage",
    "",
    `- Sites and tools: ${siteIndex.total_sites}`,
    `- Operations: ${siteIndex.total_commands}`,
    `- Built-in actions: ${pipelineSteps} (${registeredSteps} registered + ${transportSteps} transport-native)`,
    `- Tests: ${stats.test_count}`,
    "",
    "These numbers come from the current generated repo artifacts: operations, adapters, built-in actions, tests, and substrates are counted by the build.",
    "",
    "## Entrypoints",
    "",
    "- [First Run](/guide/getting-started): install, search, execute, authenticate, choose output formats, and read exit codes.",
    "- [Operation Catalog](/reference/sites): browse by site, substrate, auth strategy, and examples.",
    "- [Adapters](/guide/adapters): YAML adapters, pipeline steps, self-repair, and verification.",
    "- [Integrations](/guide/integrations): native CLI, MCP, ACP, and output modes for agent runtimes.",
    "",
    "## Current Version",
    "",
    releaseInfo.status === "published"
      ? `Latest: v${releaseInfo.version} · ${releaseInfo.codename}.`
      : `Local release: v${releaseInfo.version} · ${releaseInfo.codename}.`,
    "",
    "## Agent Index",
    "",
    "- [/llms.txt](/llms.txt)",
    "- [/llms-full.txt](/llms-full.txt)",
  ].join("\n");
}

function renderKnownComponents(
  markdown: string,
  stats: Stats,
  siteIndex: SiteIndex,
  releaseInfo: ReleaseInfo,
  locale: LocaleKey,
): string {
  return markdown
    .replace(
      /^<VersionNotice\s*\/>$/gm,
      renderVersionNotice(releaseInfo, siteIndex, locale),
    )
    .replace(
      /^<SiteStats\s*\/>$/gm,
      locale === "zh"
        ? renderSiteStatsZh(siteIndex)
        : renderSiteStats(siteIndex),
    )
    .replace(/^<SiteCatalog\s*\/>$/gm, renderSiteCatalog(siteIndex, locale))
    .replace(
      /^<HomePage\s*\/>$/gm,
      renderHomePageMarkdown(siteIndex, releaseInfo, stats, locale),
    );
}

function buildMarkdownCopy(
  page: PageIndexEntry,
  sourceMarkdown: string,
  siteIndex: SiteIndex,
  releaseInfo: ReleaseInfo,
  stats: Stats,
): string {
  const { frontmatter, body: sourceBody } = splitFrontmatter(sourceMarkdown);
  const isZh = page.locale === "zh";
  const metadata = [
    `- ${isZh ? "规范页" : "Canonical"}: https://olo-dot-io.github.io/Uni-CLI${page.routePath}`,
    `- Markdown: https://olo-dot-io.github.io/Uni-CLI${page.markdownPath}`,
    `- ${isZh ? "栏目" : "Section"}: ${page.section}`,
  ];
  const bodyParts =
    page.sourceLink === "/"
      ? [
          markdownFromHomeFrontmatter(frontmatter, page.locale),
          removeFirstHeading(sourceBody.trim()),
        ]
      : [removeFirstHeading(sourceBody.trim())];
  const body = bodyParts.filter(Boolean).join("\n\n");

  if (page.parent) {
    metadata.push(
      `- ${isZh ? "上级" : "Parent"}: ${page.parent.text} (${page.parent.link})`,
    );
  }

  const markdown = [
    isZh
      ? `<!-- 由 ${page.sourcePath} 生成。不要直接编辑此副本。 -->`
      : `<!-- Generated from ${page.sourcePath}. Do not edit this copy directly. -->`,
    "",
    `# ${page.title}`,
    "",
    ...metadata,
    "",
    body,
    "",
  ]
    .filter((line, index, lines) => {
      if (line !== "") {
        return true;
      }

      return lines[index - 1] !== "" && lines[index + 1] !== "";
    })
    .join("\n");

  return rewriteRelativeLinks(
    renderKnownComponents(markdown, stats, siteIndex, releaseInfo, page.locale),
    page.routePath,
  );
}

function writeGeneratedMarkdown(page: PageIndexEntry, markdown: string) {
  const outputPath = resolve(
    "docs/public",
    page.markdownPath.replace(/^\//, ""),
  );
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, markdown, "utf-8");
}

function absoluteUrl(path: string): string {
  return `${publicSiteBase}${path}`;
}

function pageDescription(page: PageIndexEntry): string {
  if (page.routePath === "/") {
    return "overview, install path, capability map, and agent entry points";
  }

  return `${page.section.toLowerCase()} page for ${page.title.toLowerCase()}`;
}

function groupedPages(pages: PageIndexEntry[]): Map<string, PageIndexEntry[]> {
  const groups = new Map<string, PageIndexEntry[]>();
  for (const page of pages) {
    const group = groups.get(page.section) ?? [];
    group.push(page);
    groups.set(page.section, group);
  }
  return groups;
}

function renderLlmsTxt(
  pages: PageIndexEntry[],
  siteIndex: SiteIndex,
  stats: Stats,
): string {
  const lines = [
    "# Uni-CLI",
    "",
    "Uni-CLI is the universal computer-control platform for AI agents to discover, run, prove, deliver, repair, and reroute work across websites, logged-in browsers, desktop apps, files, local tools, external CLIs, MCP servers, screenshots, accessibility trees, and agent backends.",
    "",
    "## Operation Snapshot",
    "",
    `- Sites: ${siteIndex.total_sites}`,
    `- Commands: ${siteIndex.total_commands}`,
    `- Adapters: ${stats.adapter_count_total ?? "see docs"} (${stats.adapter_count_yaml ?? "?"} YAML + ${stats.adapter_count_ts ?? "?"} TypeScript)`,
    `- Built-in actions: ${stats.pipeline_step_count ?? "see docs"} (${stats.pipeline_registered_step_count ?? "?"} registered + ${stats.pipeline_transport_step_count ?? "?"} transport-native)`,
    `- Tests: ${stats.test_count ?? "see repo"}`,
    "",
    "## Agent Contract",
    "",
    '- Start with `unicli search "your intent"`, then run `unicli <site> <command> [args]`.',
    "- Prefer `-f json` for scripts and `-f md` for agent-readable prose.",
    "- On failure, read the v2 error envelope, open the source path or `error.adapter_path`, patch the named step or boundary, then run `unicli repair <site> <command>`.",
    "- MCP and ACP are compatibility gateways; the native contract is an operation plus a structured AgentEnvelope.",
    "",
    "## Markdown Companions",
    "",
    "Every public page below has a clean Markdown companion. Fetch Markdown first; fetch rendered HTML only when visual layout matters.",
    "",
  ];

  for (const [section, entries] of groupedPages(
    pages.filter((page) => page.locale === "root"),
  )) {
    lines.push(`## ${section}`, "");
    for (const page of entries) {
      lines.push(
        `- [${page.title}](${absoluteUrl(page.routePath)}) — ${pageDescription(page)}. Markdown: ${absoluteUrl(page.markdownPath)}`,
      );
    }
    lines.push("");
  }

  lines.push(
    "## Full Context",
    "",
    `- [llms-full.txt](${absoluteUrl("/llms-full.txt")}) — concatenated public docs in Markdown for agents that can afford the context.`,
    "",
  );

  return lines.join("\n");
}

function renderLlmsFullTxt(
  renderedPages: { page: PageIndexEntry; markdown: string }[],
  siteIndex: SiteIndex,
  stats: Stats,
): string {
  const lines = [
    "# Uni-CLI Full Documentation",
    "",
    "This file is generated from the same VitePress site map as the public docs.",
    "",
    "## Snapshot",
    "",
    `- Sites: ${siteIndex.total_sites}`,
    `- Commands: ${siteIndex.total_commands}`,
    `- Adapters: ${stats.adapter_count_total ?? "see repo"}`,
    `- Built-in actions: ${stats.pipeline_step_count ?? "see repo"} (${stats.pipeline_registered_step_count ?? "?"} registered + ${stats.pipeline_transport_step_count ?? "?"} transport-native)`,
    "",
  ];

  for (const { page, markdown } of renderedPages.filter(
    (entry) => entry.page.locale === "root",
  )) {
    lines.push(
      "---",
      "",
      `# Page: ${page.title}`,
      "",
      `Canonical: ${absoluteUrl(page.routePath)}`,
      `Markdown: ${absoluteUrl(page.markdownPath)}`,
      "",
      markdown.trim(),
      "",
    );
  }

  return lines.join("\n");
}

function main() {
  const siteIndex = readSiteIndex();
  const stats = readStats();
  const releaseInfo = readReleaseInfo();
  const pages = supportedLocales.flatMap((locale) =>
    flatDocPages(locale).map<PageIndexEntry>((page) => {
      const routePath = normalizeDocPath(page.link);
      const markdownPath = page.markdownPath;
      const sourceLink = page.sourceLink;
      const breadcrumbs = page.parent ? [page.parent] : [];
      const sourcePath = sourcePathForRoute(sourceLink, locale);

      return {
        title: page.text,
        locale,
        routePath,
        markdownPath,
        sourceLink,
        sourcePath: toProjectPath(sourcePath),
        section: page.section,
        parent: page.parent,
        breadcrumbs,
      };
    }),
  );

  rmSync(markdownRoot, { recursive: true, force: true });

  const renderedPages: { page: PageIndexEntry; markdown: string }[] = [];
  for (const page of pages) {
    const markdown = buildMarkdownCopy(
      page,
      readFileSync(page.sourcePath, "utf-8"),
      siteIndex,
      releaseInfo,
      stats,
    );
    writeGeneratedMarkdown(page, markdown);
    renderedPages.push({ page, markdown });
  }

  mkdirSync(dirname(pageIndexPath), { recursive: true });
  writeFileSync(
    pageIndexPath,
    `${JSON.stringify(
      {
        source: "docs/.vitepress/site-map.ts",
        pages,
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );

  process.stdout.write(
    `wrote docs agent assets: ${pages.length} pages -> ${join(
      "docs",
      "public",
      "markdown",
    )}\n`,
  );

  mkdirSync(dirname(llmsTxtPath), { recursive: true });
  writeFileSync(llmsTxtPath, renderLlmsTxt(pages, siteIndex, stats), "utf-8");
  writeFileSync(
    llmsFullTxtPath,
    renderLlmsFullTxt(renderedPages, siteIndex, stats),
    "utf-8",
  );
}

main();
