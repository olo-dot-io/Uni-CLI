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
      "## 面向真实软件的开源 Agent-Computer Interface 运行时",
      "",
      "Uni-CLI 在 Agent 与网站、登录态浏览器、桌面应用、本地工具、文件、MCP 服务、accessibility、visual control 和系统能力之间提供一个可搜索边界。它按意图排序已编目 operation，通过选中 operation 已声明的 substrate 按支持的策略运行，返回稳定的成功/错误 envelope，并让支持的失败路径可修复。",
      "",
      "## 运行时合同",
      "",
      "- Intent discovery",
      "- Declared substrates",
      "- Policy-aware execution",
      "- Structured envelopes",
      "- MCP + ACP",
      "- Browser + Desktop",
      "- Repairable paths",
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
      "Uni-CLI 是 Agent-Computer Interface runtime，不是 Agent model、planner、浏览器 Agent 或 MCP 平台。CLI 是原生完整进程入口；MCP 投影 adapter operation；API、文件、CLI、browser、desktop、protocol 和 visual 是 operation 可声明的 substrate。精简闭环是发现、选择、治理、行动、观察、修复。",
      "",
      "- **发现。** BM25 双语搜索只取当前任务相关的操作、参数、认证姿态和风险字段。",
      "- **选择与治理。** Agent 选择已声明 strategy/substrate 的 operation；执行前可检查当前覆盖的 capability scope、effect、risk 和 approval。",
      "- **行动与观察。** Adapter kernel 调用选中的 operation；AgentEnvelope 区分成功与错误，支持的 operation 可附加 artifact、recording 或 post-state evidence。",
      "- **修复。** 结构化错误始终带 code/message，并在适用时提供 source path、失败边界、retryability、suggestion 或 alternatives。",
      "",
      "## 常见任务",
      "",
      "- `unicli search` 和 `unicli do` 先查本地操作目录，操作选定后再读取参数、认证、风险和输出字段。",
      "- 页面、接口、App 或本地边界失效时，owned failure 可在 error envelope 中指出 source path、失败 step 或边界。",
      "- Native CLI 是完整 command surface；MCP default/deferred/expanded profile 投影 adapter operation，固定 core 与其他 integration parity 仍在路线图中。",
      "",
      "## 覆盖范围",
      "",
      `- 静态 adapter 站点：${siteIndex.total_sites}`,
      `- 已注册 adapter 操作：${siteIndex.total_commands}`,
      `- Built-in action：${pipelineSteps}（${registeredSteps} registered + ${transportSteps} transport-native）`,
      `- 测试：${stats.test_count}`,
      "",
      "站点与操作数字来自静态 adapter catalog；固定 core 与主机动态发现命令在运行时单独加入。operation、adapter、built-in action、测试和 substrate 都由本地构建流程计数。",
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
    "## The open Agent-Computer Interface runtime for real software",
    "",
    "Uni-CLI provides one searchable boundary between agents and websites, logged-in browsers, desktop apps, local tools, files, MCP servers, accessibility, visual control, and system capabilities. It ranks cataloged operations by intent, runs the selected operation through its declared substrate under supported policy, returns a stable success/error envelope, and keeps supported failure paths repairable.",
    "",
    "## Runtime Contract",
    "",
    "- Intent discovery",
    "- Declared substrates",
    "- Policy-aware execution",
    "- Structured envelopes",
    "- MCP + ACP",
    "- Browser + Desktop",
    "- Repairable paths",
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
    "Uni-CLI is an Agent-Computer Interface runtime, not an agent model, planner, browser agent, or MCP platform. CLI is the native full process entry point; MCP projects adapter operations; APIs, files, CLIs, browsers, desktops, protocols, and visual control are declared substrates. The compact loop is discover, select, govern, act, observe, and repair.",
    "",
    "- **Discover.** Bilingual BM25 search retrieves only the operations, arguments, auth posture, and risk fields relevant to the task.",
    "- **Select and govern.** The agent selects an operation with a declared strategy/substrate; currently covered capability scope, effect, risk, and approval remain inspectable before execution.",
    "- **Act and observe.** The adapter kernel invokes the selected operation; AgentEnvelope distinguishes success from error, and supporting operations can add artifacts, recordings, or post-state evidence.",
    "- **Repair.** Structured errors always include code/message and add source path, failed boundary, retryability, suggestion, or alternatives when applicable.",
    "",
    "## Common Tasks",
    "",
    "- `unicli search` and `unicli do` read the local operation catalog first, then execution can inspect operation, args, auth, risk, and output fields.",
    "- When a page, API, app, or local boundary changes, an owned failure can name the source path and failing step or boundary in its error envelope.",
    "- Native CLI is the complete command surface; MCP default/deferred/expanded profiles project adapter operations, while fixed-core and other integration parity remain roadmap work.",
    "",
    "## Coverage",
    "",
    `- Static adapter sites: ${siteIndex.total_sites}`,
    `- Registered adapter operations: ${siteIndex.total_commands}`,
    `- Built-in actions: ${pipelineSteps} (${registeredSteps} registered + ${transportSteps} transport-native)`,
    `- Tests: ${stats.test_count}`,
    "",
    "Site and operation totals describe the static adapter catalog; fixed core and host-discovered commands join at runtime. Operations, adapters, built-in actions, tests, and substrates are counted by the build.",
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
    "Uni-CLI is the open Agent-Computer Interface runtime for AI agents to discover, select, govern, act through, observe, and repair operations across websites, logged-in browsers, desktop apps, files, local tools, external CLIs, MCP servers, accessibility, visual control, and agent backends.",
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
    "- On failure, read the v2 error envelope, open the source path or `error.adapter_path`, patch the named step or boundary, then run `unicli repair <site> <command>`.",
    "- Native CLI is the complete process surface. MCP default/deferred/expanded profiles project adapter operations; fixed-core and other integration parity remain roadmap work.",
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
