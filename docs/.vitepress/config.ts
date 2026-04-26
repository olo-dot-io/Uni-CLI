import { defineConfig } from "vitepress";
import { sidebarGroups, topNav } from "./site-map.js";

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
  description: "Agent-native CLI infrastructure for operating real software",
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
          "Agent-native CLI infrastructure for discovering, running, and repairing software operations across web, desktop apps, local tools, and external CLIs.",
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
  themeConfig: {
    siteTitle: "Uni-CLI",
    nav: topNav,
    search: {
      provider: "local",
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
    socialLinks: [
      { icon: "github", link: "https://github.com/olo-dot-io/Uni-CLI" },
    ],
    footer: {
      message: "Released under the Apache-2.0 License",
      copyright: "Copyright \u00a9 2026 OLo",
    },
  },
});
