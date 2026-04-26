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
import { flatDocPages, normalizeDocPath } from "../docs/.vitepress/site-map.js";

type PageIndexEntry = {
  title: string;
  routePath: string;
  markdownPath: string;
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

const docsRoot = resolve("docs");
const markdownRoot = resolve("docs/public/markdown");
const pageIndexPath = resolve("docs/page-index.json");

function sourcePathForRoute(routePath: string): string {
  if (routePath === "/") {
    return resolve(docsRoot, "index.md");
  }

  const relativeRoute = routePath.replace(/^\/+/, "").replace(/\/$/, "");
  const candidates = [
    resolve(docsRoot, `${relativeRoute}.md`),
    resolve(docsRoot, relativeRoute, "index.md"),
  ];
  const sourcePath = candidates.find((candidate) => existsSync(candidate));

  if (!sourcePath) {
    throw new Error(`No markdown source found for route ${routePath}`);
  }

  return sourcePath;
}

function markdownPathForRoute(routePath: string): string {
  if (routePath === "/") {
    return "/markdown/index.md";
  }

  const relativeRoute = routePath.replace(/^\/+/, "").replace(/\/$/, "");
  return `/markdown/${relativeRoute}.md`;
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

function markdownFromHomeFrontmatter(frontmatter: Frontmatter): string {
  const lines: string[] = [];

  if (frontmatter.hero?.text) {
    lines.push(`## ${frontmatter.hero.text}`);
  }

  if (frontmatter.hero?.tagline) {
    lines.push("", frontmatter.hero.tagline);
  }

  if (frontmatter.hero?.actions?.length) {
    lines.push("", "## Primary Actions", "");

    for (const action of frontmatter.hero.actions) {
      if (action.text && action.link) {
        lines.push(`- [${action.text}](${action.link})`);
      }
    }
  }

  if (frontmatter.features?.length) {
    lines.push("", "## Capabilities", "");

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

function renderSiteCatalog(siteIndex: SiteIndex): string {
  return [
    "## Generated Site Catalog",
    "",
    `This catalog is generated from the adapter manifest: ${siteIndex.total_sites} sites, ${siteIndex.total_commands} commands.`,
    "",
    "| Site | Surface | Commands | Auth | Example commands |",
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
          site.auth ? "yes" : "no",
          escapeTableCell(commands),
        ].join(" | ");
      })
      .map((row) => `| ${row} |`),
  ].join("\n");
}

function renderKnownComponents(markdown: string, siteIndex: SiteIndex): string {
  return markdown
    .replace(/^<SiteStats\s*\/>$/gm, renderSiteStats(siteIndex))
    .replace(/^<SiteCatalog\s*\/>$/gm, renderSiteCatalog(siteIndex));
}

function buildMarkdownCopy(
  page: PageIndexEntry,
  sourceMarkdown: string,
  siteIndex: SiteIndex,
): string {
  const { frontmatter, body: sourceBody } = splitFrontmatter(sourceMarkdown);
  const metadata = [
    `- Canonical: https://olo-dot-io.github.io/Uni-CLI${page.routePath}`,
    `- Markdown: https://olo-dot-io.github.io/Uni-CLI${page.markdownPath}`,
    `- Section: ${page.section}`,
  ];
  const bodyParts =
    page.routePath === "/"
      ? [
          markdownFromHomeFrontmatter(frontmatter),
          removeFirstHeading(sourceBody.trim()),
        ]
      : [removeFirstHeading(sourceBody.trim())];
  const body = bodyParts.filter(Boolean).join("\n\n");

  if (page.parent) {
    metadata.push(`- Parent: ${page.parent.text} (${page.parent.link})`);
  }

  const markdown = [
    `<!-- Generated from ${page.sourcePath}. Do not edit this copy directly. -->`,
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
    renderKnownComponents(markdown, siteIndex),
    page.routePath,
  );
}

function writeGeneratedMarkdown(
  page: PageIndexEntry,
  sourceMarkdown: string,
  siteIndex: SiteIndex,
) {
  const outputPath = resolve(
    "docs/public",
    page.markdownPath.replace(/^\//, ""),
  );
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(
    outputPath,
    buildMarkdownCopy(page, sourceMarkdown, siteIndex),
    "utf-8",
  );
}

function main() {
  const siteIndex = readSiteIndex();
  const pages = flatDocPages().map<PageIndexEntry>((page) => {
    const routePath = normalizeDocPath(page.link);
    const markdownPath = markdownPathForRoute(routePath);
    const breadcrumbs = page.parent ? [page.parent] : [];
    const sourcePath = sourcePathForRoute(routePath);

    return {
      title: page.text,
      routePath,
      markdownPath,
      sourcePath: toProjectPath(sourcePath),
      section: page.section,
      parent: page.parent,
      breadcrumbs,
    };
  });

  rmSync(markdownRoot, { recursive: true, force: true });

  for (const page of pages) {
    writeGeneratedMarkdown(
      page,
      readFileSync(page.sourcePath, "utf-8"),
      siteIndex,
    );
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
}

main();
