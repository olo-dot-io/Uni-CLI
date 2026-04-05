import { defineConfig } from "vitepress";

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
  description: "The last CLI an AI agent will ever need",
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
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Reference", link: "/reference/pipeline" },
      { text: "GitHub", link: "https://github.com/olo-dot-io/Uni-CLI" },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "Guide",
          items: [
            { text: "Getting Started", link: "/guide/getting-started" },
            { text: "Adapters", link: "/guide/adapters" },
            { text: "Self-Repair", link: "/guide/self-repair" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "Reference",
          items: [
            { text: "Pipeline Steps", link: "/reference/pipeline" },
            { text: "Exit Codes", link: "/reference/exit-codes" },
          ],
        },
      ],
    },
    socialLinks: [
      { icon: "github", link: "https://github.com/olo-dot-io/Uni-CLI" },
    ],
    footer: {
      message: "Released under the AGPL-3.0 License",
      copyright: "Copyright \u00a9 2024-2026 OLo",
    },
  },
});
