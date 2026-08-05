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
  description: string;
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
  description?: string;
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
      "## Agent 操作真实软件的一条命令入口",
      "",
      "Uni-CLI 让 Agent 用同一套命令搜索并操作网站、浏览器会话、桌面应用、本地工具、文件和协议服务。",
      "",
      "## 第一次运行",
      "",
      "```bash",
      "npm install -g @zenalexa/unicli",
      'unicli search "查看 Hacker News 热门文章"',
      "unicli describe hackernews top",
      "unicli hackernews top --limit 5 -f json",
      "```",
      "",
      "## 使用方式",
      "",
      "1. 用 `unicli search` 描述想完成的任务。",
      "2. 用 `unicli describe` 查看参数、认证方式和输出。",
      "3. 运行选中的命令，Agent 场景优先使用 `-f json`。",
      "4. 命令失败时读取 stderr 中的结构化错误，再运行 `unicli repair` 检查修复路径。",
      "",
      "## 可操作的界面",
      "",
      "- 网站与公开 API",
      "- 已登录浏览器会话",
      "- 桌面应用与 macOS 能力",
      "- 本地 CLI、文件与协议服务",
      "- MCP 与 ACP 客户端",
      "",
      "## 覆盖范围",
      "",
      `- 静态 adapter 站点：${siteIndex.total_sites}`,
      `- 已注册 adapter 操作：${siteIndex.total_commands}`,
      `- Built-in action：${pipelineSteps}（${registeredSteps} registered + ${transportSteps} transport-native）`,
      `- 测试：${stats.test_count}`,
      "",
      "这些数字来自当前静态适配器目录。核心命令和主机动态发现的工具会在运行时加入。",
      "",
      "## 入口",
      "",
      "- [快速开始](/zh/guide/getting-started)：安装并完成第一条命令。",
      "- [接入 Agent](/zh/guide/integrations)：选择 CLI、MCP 或 ACP。",
      "- [操作目录](/zh/reference/sites)：查找当前站点与命令。",
      "- [创建适配器](/zh/guide/adapters)：把新的软件界面接入 Uni-CLI。",
      "- [CLI 参考](/zh/reference/cli)：查看完整命令入口。",
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
    "## One command interface for agents",
    "",
    "Uni-CLI gives agents one command model for searching and operating websites, browser sessions, desktop apps, local tools, files, and protocol services.",
    "",
    "## First Run",
    "",
    "```bash",
    "npm install -g @zenalexa/unicli",
    'unicli search "list the top Hacker News stories"',
    "unicli describe hackernews top",
    "unicli hackernews top --limit 5 -f json",
    "```",
    "",
    "## How It Works",
    "",
    "1. Describe the result with `unicli search`.",
    "2. Inspect arguments, authentication, and output with `unicli describe`.",
    "3. Run the selected command. Use `-f json` for agents and scripts.",
    "4. If a command fails, read the structured error on stderr and use `unicli repair` to inspect the repair path.",
    "",
    "## Interfaces",
    "",
    "- Websites and public APIs",
    "- Logged-in browser sessions",
    "- Desktop apps and macOS capabilities",
    "- Local CLIs, files, and protocol services",
    "- MCP and ACP clients",
    "",
    "## Coverage",
    "",
    `- Static adapter sites: ${siteIndex.total_sites}`,
    `- Registered adapter operations: ${siteIndex.total_commands}`,
    `- Built-in actions: ${pipelineSteps} (${registeredSteps} registered + ${transportSteps} transport-native)`,
    `- Tests: ${stats.test_count}`,
    "",
    "These totals come from the current static adapter catalog. Core commands and host-discovered tools join at runtime.",
    "",
    "## Entrypoints",
    "",
    "- [Quickstart](/guide/getting-started): install Uni-CLI and run the first command.",
    "- [Connect an Agent](/guide/integrations): choose CLI, MCP, or ACP.",
    "- [Operation Catalog](/reference/sites): browse the current sites and commands.",
    "- [Create an Adapter](/guide/adapters): add a new software interface.",
    "- [CLI Reference](/reference/cli): see the complete command entry points.",
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
  return page.description;
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
    "Uni-CLI gives AI agents one command model for searching and operating websites, browser sessions, desktop apps, files, local tools, external CLIs, MCP servers, accessibility, and visual control.",
    "",
    "## Operation Snapshot",
    "",
    `- Static adapter sites: ${siteIndex.total_sites}`,
    `- Registered adapter commands: ${siteIndex.total_commands}`,
    "- Runtime scope: fixed core and host-discovered commands are additional",
    `- Adapters: ${stats.adapter_count_total ?? "see docs"} (${stats.adapter_count_yaml ?? "?"} YAML + ${stats.adapter_count_ts ?? "?"} TypeScript)`,
    `- Built-in actions: ${stats.pipeline_step_count ?? "see docs"} (${stats.pipeline_registered_step_count ?? "?"} registered + ${stats.pipeline_transport_step_count ?? "?"} transport-native)`,
    `- Tests: ${stats.test_count ?? "see repo"}`,
    "",
    "## Agent Contract",
    "",
    '- Start with `unicli search "your intent"`, then run `unicli <site> <command> [args]`.',
    "- Prefer `-f json` for scripts and `-f md` for agent-readable prose.",
    "- On failure, read the v2 error envelope, update the source named by `error.adapter_path`, then run `unicli repair <site> <command>`.",
    "- Native CLI exposes the complete process surface. MCP provides compact, deferred, and expanded profiles from the same operation catalog.",
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
        `- [${page.title}](${absoluteUrl(page.routePath)}) — ${pageDescription(page)} Markdown: ${absoluteUrl(page.markdownPath)}`,
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
    `- Static adapter sites: ${siteIndex.total_sites}`,
    `- Registered adapter commands: ${siteIndex.total_commands}`,
    "- Runtime scope: fixed core and host-discovered commands are additional",
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
      const { frontmatter } = splitFrontmatter(
        readFileSync(sourcePath, "utf-8"),
      );

      return {
        title: page.text,
        description:
          frontmatter.description ??
          `${page.section} documentation for ${page.text}.`,
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
