import { defineConfig } from "vitepress";
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
const zhDescription = "AI 智能体与真实软件之间的通用接口";

const socialLinks = [
  { icon: "github", link: "https://github.com/olo-dot-io/Uni-CLI" },
] as const;

const rootThemeConfig = {
  siteTitle: "Uni-CLI",
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

export default defineConfig({
  title: "Uni-CLI",
  lang: localizedSiteMaps.root.lang,
  description:
    "The universal interface between AI agents and the world's software",
  base: siteBase,
  srcExclude: ["public/markdown/**/*.md", "demo/README.md"],
  cleanUrls: true,
  lastUpdated: true,
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
          "A shell-native command layer for agents to discover, execute, verify, and repair real workflows across websites, desktop apps, local tools, and external CLIs.",
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
        href: "https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500;600;700&family=Geist:wght@400;500&display=swap",
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
