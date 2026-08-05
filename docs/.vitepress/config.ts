/**
 * @owner   docs/.vitepress/config.ts
 * @does    Configure VitePress navigation, metadata, search, and JSON-LD.
 * @needs   stats.json, docs/release-info.json, docs/.vitepress/site-map.js
 * @feeds   docs build, docs public site
 * @breaks  Stale catalog or release metadata leaks into generated docs.
 * @invariants Metadata, JSON-LD, navigation, and locale descriptions use generated release and catalog truth.
 * @side-effects Reads generated JSON metadata during VitePress configuration evaluation.
 * @perf O(n) in configured navigation and FAQ entries during build startup.
 * @concurrency Single module evaluation; exported configuration is immutable after construction.
 * @test tests/unit/docs-i18n.test.ts, tests/unit/docs-current-catalog.test.ts
 * @stability stable
 * @since 2026-04-05
 */

import { defineConfig } from "vitepress";
import { readFileSync } from "node:fs";
import { localizedSiteMaps, sidebarGroups, topNav } from "./site-map.js";

function sidebarForNavigation(groups: typeof sidebarGroups) {
  return groups.map(({ text, items }) => ({ text, items }));
}

function normalizeSiteBase(siteBase: string): string {
  const trimmedBase = siteBase.trim();

  if (!trimmedBase) {
    throw new Error("UNICLI_DOCS_BASE must not be empty when set.");
  }

  if (
    /^[a-zA-Z][a-zA-Z\d+-.]*:/.test(trimmedBase) ||
    trimmedBase.startsWith("//")
  ) {
    throw new Error(
      `UNICLI_DOCS_BASE must be a base path like "/" or "/Uni-CLI/", received "${siteBase}".`,
    );
  }

  const normalizedBase = `/${trimmedBase.replace(/^\/+|\/+$/g, "")}/`;
  return normalizedBase === "//" ? "/" : normalizedBase;
}

const configuredSiteBase = process.env.UNICLI_DOCS_BASE;
const siteBase = configuredSiteBase
  ? normalizeSiteBase(configuredSiteBase)
  : process.env.GITHUB_REPOSITORY === "olo-dot-io/Uni-CLI"
    ? "/Uni-CLI/"
    : "/";
const siteOrigin = "https://olo-dot-io.github.io";
const publicSiteUrl = `${siteOrigin}${siteBase}`;
const publicDescription =
  "One command interface for agents to search and operate websites, browsers, desktop apps, local tools, files, and MCP.";
const zhDescription =
  "让 Agent 用统一命令搜索并操作网站、浏览器、桌面应用、本地工具、文件与 MCP。";
const npmPackageUrl = "https://www.npmjs.com/package/@zenalexa/unicli";
const npmIcon = `<svg viewBox="0 0 48 24" aria-hidden="true"><rect x="1" y="5" width="46" height="15" rx="1" fill="#cb3837"/><text x="6" y="17" fill="#fff" font-family="Geist Variable, sans-serif" font-size="13" font-weight="700" letter-spacing="-1">npm</text></svg>`;

const socialLinks = [
  { icon: "github", link: "https://github.com/olo-dot-io/Uni-CLI" },
  { icon: { svg: npmIcon }, link: npmPackageUrl, ariaLabel: "npm" },
] as const;

type SiteStats = {
  site_count: number;
  command_count: number;
  adapter_count_total: number;
  pipeline_step_count: number;
  test_count: number;
};

type ReleaseInfo = {
  version: string;
  codename: string;
};

function readJson<T>(url: URL): T {
  return JSON.parse(readFileSync(url, "utf-8")) as T;
}

const siteStats = readJson<SiteStats>(
  new URL("../../stats.json", import.meta.url),
);
const releaseInfo = readJson<ReleaseInfo>(
  new URL("../release-info.json", import.meta.url),
);
const commandCount = siteStats.command_count.toLocaleString("en-US");

const rootThemeConfig = {
  siteTitle: "Uni-CLI",
  logo: { src: "/favicon.png", alt: "" },
  nav: topNav,
  search: {
    provider: "local",
    options: {
      locales: {
        zh: {
          translations: {
            button: {
              buttonText: "搜索",
              buttonAriaLabel: "搜索文档",
            },
            modal: {
              noResultsText: "没有找到结果",
              resetButtonTitle: "清空搜索",
              footer: {
                selectText: "选择",
                navigateText: "切换",
                closeText: "关闭",
              },
            },
          },
        },
      },
    },
  },
  sidebar: sidebarForNavigation(sidebarGroups),
  editLink: {
    pattern: "https://github.com/olo-dot-io/Uni-CLI/edit/main/docs/:path",
    text: "Edit this page on GitHub",
  },
  docFooter: {
    prev: "Previous",
    next: "Next",
  },
  socialLinks,
  footer: {
    message: "Released under the Apache-2.0 License",
    copyright: "Copyright \u00a9 2026 OLo",
  },
};

const zhThemeConfig = {
  ...rootThemeConfig,
  nav: localizedSiteMaps.zh.topNav,
  sidebar: sidebarForNavigation(localizedSiteMaps.zh.sidebarGroups),
  editLink: {
    pattern: "https://github.com/olo-dot-io/Uni-CLI/edit/main/docs/:path",
    text: "在 GitHub 上编辑本页",
  },
  docFooter: {
    prev: "上一页",
    next: "下一页",
  },
  outline: {
    label: "本页目录",
  },
  langMenuLabel: "切换语言",
  returnToTopLabel: "回到顶部",
  sidebarMenuLabel: "菜单",
  darkModeSwitchLabel: "外观",
  lightModeSwitchTitle: "切换到浅色模式",
  darkModeSwitchTitle: "切换到深色模式",
  footer: {
    message: "基于 Apache-2.0 许可证发布",
    copyright: "Copyright \u00a9 2026 OLo",
  },
};

/**
 * markdown-it plugin: escape {{ }} in fenced code block output.
 *
 * Uni-CLI uses ${{ expr }} as its YAML template syntax. Vue's SFC
 * compiler interprets {{ }} as interpolation even inside code fences
 * (before v-pre is processed), causing build failures. This plugin
 * replaces {{ and }} with HTML entities in the rendered fence HTML
 * so the Vue template compiler never sees them as interpolation.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function escapeMustacheInFence(md: any) {
  // Escape {{ }} in fenced code blocks
  const originalFence = md.renderer.rules.fence;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  md.renderer.rules.fence = (...args: any[]) => {
    const html = originalFence
      ? originalFence(...args)
      : md.renderer.renderToken(...args);
    return html
      .replace(/\{\{/g, "&#123;&#123;")
      .replace(/\}\}/g, "&#125;&#125;");
  };

  // Escape {{ }} in inline code spans
  const originalCodeInline = md.renderer.rules.code_inline;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  md.renderer.rules.code_inline = (...args: any[]) => {
    const html = originalCodeInline
      ? originalCodeInline(...args)
      : md.renderer.renderToken(...args);
    return html
      .replace(/\{\{/g, "&#123;&#123;")
      .replace(/\}\}/g, "&#125;&#125;");
  };

  // Escape {{ }} in text tokens (plain prose)
  const originalText = md.renderer.rules.text;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  md.renderer.rules.text = (...args: any[]) => {
    const html = originalText
      ? originalText(...args)
      : md.renderer.renderToken(...args);
    return html
      .replace(/\{\{/g, "&#123;&#123;")
      .replace(/\}\}/g, "&#125;&#125;");
  };
}

const homeFaqs: { q: string; a: string }[] = [
  {
    q: "What is Uni-CLI?",
    a: "Uni-CLI is an open-source command runtime for AI agents. It gives agents one way to search and operate websites, browser sessions, desktop applications, local tools, files, and protocol servers.",
  },
  {
    q: "What should I run first?",
    a: "Install @zenalexa/unicli, run unicli search with the result you want, inspect the match with unicli describe, then run the selected command with -f json.",
  },
  {
    q: "Which agents can use Uni-CLI?",
    a: "Any agent that can start a process can use the CLI. Uni-CLI also provides MCP and ACP servers for clients that prefer protocol connections.",
  },
  {
    q: "How many operations are included?",
    a: `v${releaseInfo.version} ships ${siteStats.site_count} sites and ${commandCount} registered commands in the static adapter catalog. Core commands and host-discovered tools join the catalog at runtime.`,
  },
  {
    q: "How does authentication work?",
    a: "Each operation declares its connection strategy. Uni-CLI can use public endpoints, saved site credentials, or a managed or existing browser session. The auth and browser doctor commands report the setup for the current machine.",
  },
  {
    q: "What output does Uni-CLI return?",
    a: "Successful data goes to stdout. Structured errors go to stderr with a meaningful process exit code. Markdown is the terminal default; JSON, YAML, CSV, and compact formats are available.",
  },
  {
    q: "What happens when a site changes?",
    a: "Adapter failures can name the source file and failed step. After the adapter is updated, unicli repair reruns the original operation to verify the change.",
  },
  {
    q: "Can I add a site?",
    a: "Yes. unicli init creates a YAML adapter, and unicli dev reloads it during development. Plugins can add pipeline steps, transports, and adapters from a third-party package.",
  },
  {
    q: "Should I use the CLI or MCP?",
    a: "Use the CLI for process-based agents, pipes, files, and complete command coverage. Use MCP when the client manages tools through an MCP server. Both read from the same operation catalog.",
  },
  {
    q: "Is Uni-CLI free and open source?",
    a: "Yes. Uni-CLI uses the Apache-2.0 license and is published on npm as @zenalexa/unicli.",
  },
];

const softwareApplicationLdJson = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Uni-CLI",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "macOS, Linux, Windows",
  description: publicDescription,
  url: publicSiteUrl,
  downloadUrl: npmPackageUrl,
  softwareVersion: releaseInfo.version,
  license: "https://www.apache.org/licenses/LICENSE-2.0",
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  author: {
    "@type": "Organization",
    name: "OLo",
    url: "https://github.com/olo-dot-io",
  },
};

const organizationLdJson = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "OLo",
  url: "https://github.com/olo-dot-io",
  sameAs: [
    "https://github.com/olo-dot-io/Uni-CLI",
    "https://www.npmjs.com/package/@zenalexa/unicli",
  ],
};

const faqPageLdJson = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: homeFaqs.map(({ q, a }) => ({
    "@type": "Question",
    name: q,
    acceptedAnswer: { "@type": "Answer", text: a },
  })),
};

function pageUrl(relativePath: string): string {
  const cleaned = relativePath
    .replace(/\.md$/, "")
    .replace(/(^|\/)index$/, "$1");
  return cleaned ? `${publicSiteUrl}${cleaned}` : publicSiteUrl;
}

function pageLanguage(relativePath: string): string {
  return relativePath.startsWith("zh/") ? "zh-CN" : "en-US";
}

type Crumb = { name: string; item: string };

function breadcrumbsFor(relativePath: string): Crumb[] {
  const isZh = relativePath.startsWith("zh/");
  const home = isZh ? "Uni-CLI 中文" : "Uni-CLI";
  const homeUrl = isZh ? `${publicSiteUrl}zh/` : publicSiteUrl;
  const crumbs: Crumb[] = [{ name: home, item: homeUrl }];

  const trimmed = relativePath
    .replace(/^zh\//, "")
    .replace(/\.md$/, "")
    .replace(/\/index$/, "");
  if (!trimmed || trimmed === "index") return crumbs;

  const segments = trimmed.split("/");
  let acc = isZh ? `${publicSiteUrl}zh/` : publicSiteUrl;
  for (const seg of segments) {
    acc = `${acc}${seg}/`;
    const pretty = seg
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    crumbs.push({ name: pretty, item: acc.replace(/\/$/, "") });
  }
  return crumbs;
}

function buildBreadcrumbLdJson(relativePath: string) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: breadcrumbsFor(relativePath).map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      item: c.item,
    })),
  };
}

function buildArticleLdJson(pageData: {
  title: string;
  description?: string;
  relativePath: string;
  lastUpdated?: number;
  frontmatter?: { description?: string };
}): Record<string, unknown> {
  const url = pageUrl(pageData.relativePath);
  const lang = pageLanguage(pageData.relativePath);
  const description =
    pageData.description ||
    pageData.frontmatter?.description ||
    "Uni-CLI documentation";
  const dateModified = pageData.lastUpdated
    ? new Date(pageData.lastUpdated).toISOString()
    : undefined;
  return {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: pageData.title || "Uni-CLI",
    description,
    inLanguage: lang,
    url,
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    author: organizationLdJson,
    publisher: organizationLdJson,
    ...(dateModified ? { dateModified } : {}),
  };
}

const howToLdJson = {
  "@context": "https://schema.org",
  "@type": "HowTo",
  name: "Install Uni-CLI and run your first governed operation",
  description: `Install Uni-CLI globally via npm, search the operation catalog with natural-language intent, then execute a governed operation across one of ${siteStats.site_count} supported sites or tools.`,
  totalTime: "PT5M",
  inLanguage: "en-US",
  step: [
    {
      "@type": "HowToStep",
      position: 1,
      name: "Install via npm",
      text: "Run `npm install -g @zenalexa/unicli` to install the global binary. Requires Node.js 22.19 or later.",
    },
    {
      "@type": "HowToStep",
      position: 2,
      name: "Search operations",
      text: "Run `unicli search 'find AI agent discussions on reddit'` to discover the matching site, operation, and arguments.",
    },
    {
      "@type": "HowToStep",
      position: 3,
      name: "Execute the operation",
      text: "Run the suggested operation, e.g. `unicli reddit search 'AI agents' -n 20 -f json` to fetch results in agent-readable JSON.",
    },
    {
      "@type": "HowToStep",
      position: 4,
      name: "Recover from failures",
      text: "If a site or software boundary changes shape, the v2 AgentEnvelope returns source path, failing step or boundary, and a suggestion. Edit the YAML or code, then run `unicli repair <site> <command>` to verify.",
    },
  ],
};

export default defineConfig({
  title: "Uni-CLI",
  lang: localizedSiteMaps.root.lang,
  description: publicDescription,
  base: siteBase,
  srcExclude: [
    "public/markdown/**/*.md",
    "demo/README.md",
    "mcp/clients/**/*.md",
    "operate/**/*.md",
    "skills/**/*.md",
    "reference/maintenance.md",
    "reference/release.md",
    "zh/reference/maintenance.md",
    "zh/reference/release.md",
  ],
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: [/\.rs$/, /\.ts$/],
  sitemap: {
    hostname: publicSiteUrl,
  },
  transformHead({ pageData }) {
    const head: [string, Record<string, string>, string?][] = [];
    const canonical = pageUrl(pageData.relativePath);
    head.push(["link", { rel: "canonical", href: canonical }]);

    const isHome =
      pageData.relativePath === "index.md" ||
      pageData.relativePath === "zh/index.md";
    if (isHome) {
      head.push([
        "script",
        { type: "application/ld+json" },
        JSON.stringify(softwareApplicationLdJson),
      ]);
      head.push([
        "script",
        { type: "application/ld+json" },
        JSON.stringify(organizationLdJson),
      ]);
    }

    const isFaq =
      pageData.relativePath === "faq.md" ||
      pageData.relativePath === "zh/faq.md";
    if (isFaq) {
      head.push([
        "script",
        { type: "application/ld+json" },
        JSON.stringify(faqPageLdJson),
      ]);
    }

    const isHowTo =
      pageData.relativePath === "guide/getting-started.md" ||
      pageData.relativePath === "zh/guide/getting-started.md";
    if (isHowTo) {
      head.push([
        "script",
        { type: "application/ld+json" },
        JSON.stringify(howToLdJson),
      ]);
    }

    head.push([
      "script",
      { type: "application/ld+json" },
      JSON.stringify(buildBreadcrumbLdJson(pageData.relativePath)),
    ]);

    if (!isHome && !isFaq) {
      head.push([
        "script",
        { type: "application/ld+json" },
        JSON.stringify(buildArticleLdJson(pageData)),
      ]);
    }

    head.push([
      "meta",
      { name: "twitter:title", content: pageData.title || "Uni-CLI" },
    ]);
    if (pageData.frontmatter?.description || pageData.description) {
      head.push([
        "meta",
        {
          name: "twitter:description",
          content:
            pageData.frontmatter?.description || pageData.description || "",
        },
      ]);
    }

    return head;
  },
  markdown: {
    math: true,
    config: (md) => {
      escapeMustacheInFence(md);
    },
  },
  head: [
    [
      "link",
      { rel: "icon", type: "image/png", href: `${siteBase}favicon.png` },
    ],
    ["link", { rel: "manifest", href: `${siteBase}site.webmanifest` }],
    [
      "meta",
      {
        name: "theme-color",
        content: "#073f2b",
        media: "(prefers-color-scheme: light)",
      },
    ],
    [
      "meta",
      {
        name: "theme-color",
        content: "#073f2b",
        media: "(prefers-color-scheme: dark)",
      },
    ],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "Uni-CLI" }],
    [
      "meta",
      {
        property: "og:description",
        content: publicDescription,
      },
    ],
    ["meta", { property: "og:url", content: publicSiteUrl }],
    [
      "meta",
      {
        property: "og:image",
        content: `${publicSiteUrl}site-preview-og.jpg`,
      },
    ],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
  ],
  themeConfig: rootThemeConfig,
  locales: {
    root: {
      label: localizedSiteMaps.root.label,
      lang: localizedSiteMaps.root.lang,
      link: localizedSiteMaps.root.link,
      themeConfig: rootThemeConfig,
    },
    zh: {
      label: localizedSiteMaps.zh.label,
      lang: localizedSiteMaps.zh.lang,
      link: localizedSiteMaps.zh.link,
      title: "Uni-CLI",
      description: zhDescription,
      head: [
        ["meta", { property: "og:locale", content: "zh_CN" }],
        ["meta", { property: "og:description", content: zhDescription }],
      ],
      themeConfig: zhThemeConfig,
    },
  },
});
