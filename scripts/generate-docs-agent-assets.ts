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
  test_count?: number;
};

type ReleaseInfo = {
  version: string;
  codename: string;
  date: string;
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
  return JSON.parse(
    readFileSync(resolve("docs/release-info.json"), "utf-8"),
  ) as ReleaseInfo;
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
  const highlights = releaseInfo.highlights[locale] ?? [];

  return [
    isZh ? "## 当前版本" : "## Current Version",
    "",
    isZh
      ? `v${releaseInfo.version}（${releaseInfo.codename}）已于 ${releaseInfo.date} 发布到 npm，${releaseInfo.npmPackage} 的 latest 当前指向这个版本。`
      : `v${releaseInfo.version} (${releaseInfo.codename}) shipped to npm on ${releaseInfo.date}; the ${releaseInfo.npmPackage} latest tag now points to this release.`,
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
    `- [${releaseInfo.npmPackage} on npm](${releaseInfo.npmUrl})`,
    `- [GitHub Release v${releaseInfo.version}](${releaseInfo.releaseUrl})`,
    `- [Changelog](${releaseInfo.changelogUrl})`,
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
  if (locale === "zh") {
    return [
      "## 面向 Agent 的软件执行层",
      "",
      "Agent 正从聊天助手走向任务执行系统：它需要调用 CLI、API、浏览器和桌面应用，也需要审计记录、权限边界和失败后的恢复路径。Uni-CLI 把这些软件入口整理成同一套可搜索、可执行、可追踪、可修复的命令接口。",
      "",
      "## 第一条命令",
      "",
      "```bash",
      "npm install -g @zenalexa/unicli",
      'unicli search "twitter trending"',
      "unicli twitter trending --limit 10 -f json",
      "```",
      "",
      "## 定位",
      "",
      "不是再造一个协议层，而是补齐 Agent 执行的工程面。MCP 解决互操作，browser / computer-use 补 API 空白；真正进入生产环境时，还需要命令目录、权限策略、可审计输出、退出码和修复循环。",
      "",
      "- **统一入口。** 同一个目录覆盖公开 API、Cookie 会话、浏览器、桌面应用、外部 CLI 和本机能力。",
      "- **可审计执行。** 参数、认证、权限 profile、输出结构和退出码在运行前后都能检查，不靠 prompt 约定。",
      "- **可恢复失败。** 外部页面或 API 变了，错误要指向 adapter 文件、pipeline step 和复现命令。",
      "",
      "## 覆盖范围",
      "",
      `- 站点和工具：${siteIndex.total_sites}`,
      `- 命令：${siteIndex.total_commands}`,
      `- Pipeline step：${pipelineSteps}`,
      "- 输出协议：v2 AgentEnvelope",
      "",
      "同一套调用路径覆盖公开 API、Cookie 会话、浏览器、桌面应用、外部 CLI 和本机能力。Agent 只需要学一条调用路径。",
      "",
      "## 入口",
      "",
      "- [安装运行](/zh/guide/getting-started)：安装、搜索、运行、认证和常见退出码。",
      "- [命令目录](/zh/reference/sites)：按站点、接口类型、认证方式和命令样例检索。",
      "- [适配器](/zh/guide/adapters)：YAML 格式、pipeline step、自修复流程和验证方式。",
      "",
      "## 当前版本",
      "",
      `当前 latest：v${releaseInfo.version} · ${releaseInfo.codename}。`,
      "",
      "## Agent 索引",
      "",
      "- [/llms.txt](/llms.txt)",
      "- [/llms-full.txt](/llms-full.txt)",
    ].join("\n");
  }

  return [
    "## Software execution for agents",
    "",
    "Agents are moving from chat assistance to task-running systems. They need to call CLIs, APIs, browsers, and desktop apps, while keeping audit trails, permission boundaries, and recovery paths. Uni-CLI turns those software surfaces into one searchable, executable, traceable, and repairable command interface.",
    "",
    "## First Command",
    "",
    "```bash",
    "npm install -g @zenalexa/unicli",
    'unicli search "twitter trending"',
    "unicli twitter trending --limit 10 -f json",
    "```",
    "",
    "## Positioning",
    "",
    "The gap is not another protocol. It is the engineering surface around agent execution. MCP improves interoperability. Browser and computer-use automation close API gaps. Production agent workflows still need a command catalog, policy, inspectable output, exit codes, and repair loops.",
    "",
    "- **Unified entry.** One catalog covers public APIs, cookie sessions, browsers, desktop apps, external CLIs, and local capabilities.",
    "- **Auditable execution.** Arguments, auth, policy profiles, output shape, and exit codes stay inspectable before and after a run.",
    "- **Recoverable failure.** When a surface changes, the error names the adapter file, pipeline step, and verification command.",
    "",
    "## Coverage",
    "",
    `- Sites and tools: ${siteIndex.total_sites}`,
    `- Commands: ${siteIndex.total_commands}`,
    `- Pipeline steps: ${pipelineSteps}`,
    "- Output contract: v2 AgentEnvelope",
    "",
    "One call path spans public APIs, cookie sessions, browsers, desktop apps, external CLIs, and local system capabilities. Agents learn one call path.",
    "",
    "## Entrypoints",
    "",
    "- [First Run](/guide/getting-started): install, search, execute, authenticate, and read exit codes.",
    "- [Command Catalog](/reference/sites): browse by site, surface type, auth strategy, and examples.",
    "- [Adapters](/guide/adapters): YAML adapters, pipeline steps, self-repair, and verification.",
    "",
    "## Current Version",
    "",
    `Latest: v${releaseInfo.version} · ${releaseInfo.codename}.`,
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
    "Uni-CLI is the CLI-native command surface for AI agents to discover, run, and repair operations across websites, desktop apps, local tools, external CLIs, and agent backends.",
    "",
    "## Catalog Snapshot",
    "",
    `- Sites: ${siteIndex.total_sites}`,
    `- Commands: ${siteIndex.total_commands}`,
    `- Adapters: ${stats.adapter_count_total ?? "see docs"} (${stats.adapter_count_yaml ?? "?"} YAML + ${stats.adapter_count_ts ?? "?"} TypeScript)`,
    `- Pipeline steps: ${stats.pipeline_step_count ?? "see docs"}`,
    `- Tests: ${stats.test_count ?? "see repo"}`,
    "",
    "## Agent Contract",
    "",
    '- Start with `unicli search "your intent"`, then run `unicli <site> <command> [args]`.',
    "- Prefer `-f json` for scripts and `-f md` for agent-readable prose.",
    "- On failure, read the v2 error envelope, open `error.adapter_path`, patch the YAML, then run `unicli repair <site> <command>`.",
    "- MCP and ACP are compatibility gateways; the native contract is a shell command plus a structured AgentEnvelope.",
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
    `- Pipeline steps: ${stats.pipeline_step_count ?? "see repo"}`,
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
