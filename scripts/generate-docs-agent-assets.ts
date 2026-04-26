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

function renderKnownComponents(
  markdown: string,
  siteIndex: SiteIndex,
  locale: LocaleKey,
): string {
  return markdown
    .replace(
      /^<SiteStats\s*\/>$/gm,
      locale === "zh"
        ? renderSiteStatsZh(siteIndex)
        : renderSiteStats(siteIndex),
    )
    .replace(/^<SiteCatalog\s*\/>$/gm, renderSiteCatalog(siteIndex, locale));
}

function buildMarkdownCopy(
  page: PageIndexEntry,
  sourceMarkdown: string,
  siteIndex: SiteIndex,
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
    renderKnownComponents(markdown, siteIndex, page.locale),
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
    "This file is generated from the same VitePress site map as the public docs. It intentionally excludes internal repo-only guides.",
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
