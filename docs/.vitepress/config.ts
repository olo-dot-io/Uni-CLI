/**
 * @owner   docs/.vitepress/config.ts
 * @does    Configure VitePress navigation, metadata, search, and JSON-LD.
 * @needs   stats.json, docs/release-info.json, docs/.vitepress/site-map.js
 * @feeds   docs build, docs public site
 * @breaks  Stale catalog or release metadata leaks into generated docs.
 */

import { defineConfig } from "vitepress";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { localizedSiteMaps, sidebarGroups, topNav } from "./site-map.js";

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
const zhDescription = "给 Agent 的命令级软件入口。";
const npmPackageUrl = "https://www.npmjs.com/package/@zenalexa/unicli";
const npmIcon = `<svg viewBox="0 0 48 24" aria-hidden="true"><rect x="1" y="5" width="46" height="15" rx="1" fill="#cb3837"/><text x="6" y="17" fill="#fff" font-family="Arial, Helvetica, sans-serif" font-size="13" font-weight="700" letter-spacing="-1">npm</text></svg>`;

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
const adapterCount = siteStats.adapter_count_total.toLocaleString("en-US");
const testCount = siteStats.test_count.toLocaleString("en-US");
const releaseLabel = `v${releaseInfo.version}`;

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
  sidebar: sidebarGroups,
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
  sidebar: localizedSiteMaps.zh.sidebarGroups,
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
    a: `Uni-CLI is a command-line execution layer that turns websites, desktop apps, MCP servers, and external CLIs into a single searchable command catalog for AI agents. One command path discovers, runs, and self-repairs operations across ${siteStats.site_count} sites and tools.`,
  },
  {
    q: "How is Uni-CLI different from a browser automation library?",
    a: "Uni-CLI uses YAML adapters that compile sites into deterministic CLI commands, not Turing-complete scripts. Each command returns the same v2 AgentEnvelope, so agents can pipe results, retry on structured errors, and patch the YAML when an upstream API changes.",
  },
  {
    q: "Why a CLI instead of an MCP server?",
    a: "Measured Uni-CLI list-style calls land at 364-423 tokens total (median 412) per docs/BENCHMARK.md. An MCP server keeps its tool list resident — usually 1,500-3,000 tokens per server — even when idle. Uni-CLI publishes both surfaces; the CLI is the cheap, deterministic primary, and MCP wraps it for runtimes that only speak MCP.",
  },
  {
    q: "How does self-repair work in Uni-CLI?",
    a: "When a command fails, Uni-CLI emits a structured error JSON with adapter_path, failing pipeline step, action, and a suggestion. An agent reads the YAML at that path, edits the selector or auth header, then runs unicli repair <site> <command> to verify the fix. Patches persist in ~/.unicli/adapters/.",
  },
  {
    q: "Which AI agent platforms work with Uni-CLI?",
    a: "Claude Code, Codex CLI, OpenCode, Cursor, OpenClaw, and any runtime that can spawn a subprocess. Uni-CLI also exposes an MCP server, an ACP gateway, and an AGENTS.md discovery surface so agents pick it up without manual configuration.",
  },
  {
    q: "How many sites and commands does Uni-CLI ship?",
    a: `${releaseLabel} covers ${siteStats.site_count} sites with ${commandCount} commands across ${adapterCount} adapters, ${siteStats.pipeline_step_count} pipeline steps, and ${testCount} tests. Coverage spans social platforms, developer tools, Chinese platforms, scholarly databases, government policy, podcasts, and macOS apps.`,
  },
  {
    q: "Can I add a new site to Uni-CLI without writing TypeScript?",
    a: "Yes. The preferred contribution format is a 20-line YAML adapter that names the site, command, strategy, and pipeline. Run unicli init <site> <command> to scaffold one, then unicli dev <path> to hot-reload while iterating.",
  },
  {
    q: "Does Uni-CLI handle authenticated sites?",
    a: "Yes. Strategies cascade across public, cookie, header (cookie+CSRF), intercept (browser XHR capture), and ui (interactive). Cookies live in ~/.unicli/cookies/ and Uni-CLI auto-probes the cheapest strategy that returns valid data.",
  },
  {
    q: "How does Uni-CLI compare to MCP for token cost?",
    a: "docs/BENCHMARK.md measures real Uni-CLI call budgets at 364-423 tokens (median 412) for --limit 5 list-style adapters. An MCP server keeps its tool list resident — usually 1,500-3,000 tokens per server — even when idle. Uni-CLI emits structured error envelopes so agents avoid retry loops that further inflate context.",
  },
  {
    q: "Is Uni-CLI free and open source?",
    a: "Yes. Uni-CLI is Apache-2.0 on GitHub at olo-dot-io/Uni-CLI and on npm as @zenalexa/unicli. There are no paid features, no gated commands, and no telemetry. YAML adapters and pipeline steps are agent-readable and agent-editable.",
  },
];

const softwareApplicationLdJson = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Uni-CLI",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "macOS, Linux, Windows",
  description: `Command-grade software access for AI agents. Turns ${siteStats.site_count} websites, desktop apps, MCP servers, and external CLIs into a single searchable, self-repairing command catalog.`,
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
  name: "Install Uni-CLI and run your first command",
  description: `Install Uni-CLI globally via npm, search the command catalog with natural-language intent, then execute a command across one of ${siteStats.site_count} supported sites or tools.`,
  totalTime: "PT5M",
  inLanguage: "en-US",
  step: [
    {
      "@type": "HowToStep",
      position: 1,
      name: "Install via npm",
      text: "Run `npm install -g @zenalexa/unicli` to install the global binary. Requires Node.js 20 or later.",
    },
    {
      "@type": "HowToStep",
      position: 2,
      name: "Search the catalog",
      text: "Run `unicli search 'find AI agent discussions on reddit'` to discover the matching site, command, and arguments.",
    },
    {
      "@type": "HowToStep",
      position: 3,
      name: "Execute the command",
      text: "Run the suggested command, e.g. `unicli reddit search 'AI agents' -n 20 -f json` to fetch results in agent-readable JSON.",
    },
    {
      "@type": "HowToStep",
      position: 4,
      name: "Recover from failures",
      text: "If a site changes shape, the v2 AgentEnvelope returns adapter_path, failing step, and a suggestion. Edit the YAML, then run `unicli repair <site> <command>` to verify.",
    },
  ],
};

export default defineConfig({
  title: "Uni-CLI",
  lang: localizedSiteMaps.root.lang,
  description: "Command-grade software access for agents.",
  base: siteBase,
  srcExclude: ["public/markdown/**/*.md", "demo/README.md"],
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
  vite: {
    plugins: [react()],
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
    ["meta", { name: "theme-color", content: "#11100f" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "Uni-CLI" }],
    [
      "meta",
      {
        property: "og:description",
        content:
          "A searchable execution layer for sites, apps, local tools, MCP, and external CLIs.",
      },
    ],
    ["meta", { property: "og:url", content: publicSiteUrl }],
    ["meta", { property: "og:image", content: `${publicSiteUrl}icon-512.png` }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["link", { rel: "preconnect", href: "https://fonts.googleapis.com" }],
    [
      "link",
      {
        rel: "preconnect",
        href: "https://fonts.gstatic.com",
        crossorigin: "",
      },
    ],
    [
      "link",
      {
        href: "https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500;600&family=Inter:wght@400;500;600;700;800&display=swap",
        rel: "stylesheet",
      },
    ],
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
