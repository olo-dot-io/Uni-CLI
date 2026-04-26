import { defineConfig } from "vitepress";

const siteBase =
  process.env.UNICLI_DOCS_BASE ??
  (process.env.GITHUB_REPOSITORY === "olo-dot-io/Uni-CLI" ? "/Uni-CLI/" : "/");

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
  description: "One CLI surface for agents to operate software",
  base: siteBase,
  cleanUrls: true,
  lastUpdated: true,
  markdown: {
    config: (md) => {
      escapeMustacheInFence(md);
    },
  },
  head: [
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
    nav: [
      { text: "Start", link: "/guide/getting-started" },
      { text: "Guides", link: "/guide/" },
      { text: "Reference", link: "/reference/" },
      { text: "Architecture", link: "/ARCHITECTURE" },
      { text: "GitHub", link: "https://github.com/olo-dot-io/Uni-CLI" },
    ],
    search: {
      provider: "local",
    },
    sidebar: {
      "/": [
        {
          text: "Start",
          items: [
            { text: "Overview", link: "/" },
            { text: "Getting Started", link: "/guide/getting-started" },
            { text: "Integrations", link: "/guide/integrations" },
            { text: "Recipes", link: "/RECIPES" },
          ],
        },
        {
          text: "Guides",
          items: [
            { text: "Adapters", link: "/guide/adapters" },
            { text: "Self-Repair", link: "/guide/self-repair" },
          ],
        },
        {
          text: "Reference",
          items: [
            { text: "Adapter Format", link: "/ADAPTER-FORMAT" },
            { text: "Pipeline Steps", link: "/reference/pipeline" },
            { text: "Exit Codes", link: "/reference/exit-codes" },
            { text: "Maintenance Tools", link: "/reference/maintenance" },
            { text: "Plugin Authoring", link: "/PLUGIN" },
            { text: "Release", link: "/reference/release" },
          ],
        },
        {
          text: "Explanation",
          items: [
            { text: "Architecture", link: "/ARCHITECTURE" },
            { text: "Benchmarks", link: "/BENCHMARK" },
            { text: "Theory", link: "/THEORY" },
            { text: "Taste Guide", link: "/TASTE" },
            { text: "Roadmap", link: "/ROADMAP" },
          ],
        },
      ],
      "/guide/": [
        {
          text: "Start",
          items: [
            { text: "Guide Index", link: "/guide/" },
            { text: "Getting Started", link: "/guide/getting-started" },
            { text: "Integrations", link: "/guide/integrations" },
            { text: "Recipes", link: "/RECIPES" },
          ],
        },
        {
          text: "Build",
          items: [
            { text: "Adapters", link: "/guide/adapters" },
            { text: "Self-Repair", link: "/guide/self-repair" },
            { text: "Adapter Format", link: "/ADAPTER-FORMAT" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "Reference",
          items: [
            { text: "Reference Index", link: "/reference/" },
            { text: "Adapter Format", link: "/ADAPTER-FORMAT" },
            { text: "Pipeline Steps", link: "/reference/pipeline" },
            { text: "Exit Codes", link: "/reference/exit-codes" },
            { text: "Maintenance Tools", link: "/reference/maintenance" },
            { text: "Plugin Authoring", link: "/PLUGIN" },
            { text: "Release", link: "/reference/release" },
          ],
        },
      ],
    },
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
      copyright: "Copyright \u00a9 2024-2026 OLo",
    },
  },
});
