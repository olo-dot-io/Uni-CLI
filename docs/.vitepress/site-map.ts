export type SiteLeaf = {
  text: string;
  link: string;
};

export type SiteGroup = {
  text: string;
  link: string;
  items: SiteLeaf[];
};

export type SitePage = SiteLeaf & {
  section: string;
  parent: SiteLeaf | null;
};

export const topNav = [
  { text: "Start", link: "/guide/getting-started" },
  { text: "Sites", link: "/reference/sites" },
  { text: "Guides", link: "/guide/" },
  { text: "Reference", link: "/reference/" },
  { text: "Architecture", link: "/ARCHITECTURE" },
];

export const sidebarGroups: SiteGroup[] = [
  {
    text: "Start",
    link: "/",
    items: [
      { text: "Overview", link: "/" },
      { text: "Getting Started", link: "/guide/getting-started" },
      { text: "Integrations", link: "/guide/integrations" },
      { text: "Recipes", link: "/RECIPES" },
    ],
  },
  {
    text: "Guides",
    link: "/guide/",
    items: [
      { text: "Guide Index", link: "/guide/" },
      { text: "Adapters", link: "/guide/adapters" },
      { text: "Self-Repair", link: "/guide/self-repair" },
    ],
  },
  {
    text: "Reference",
    link: "/reference/",
    items: [
      { text: "Reference Index", link: "/reference/" },
      { text: "Sites Catalog", link: "/reference/sites" },
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
    link: "/ARCHITECTURE",
    items: [
      { text: "Architecture", link: "/ARCHITECTURE" },
      { text: "Benchmarks", link: "/BENCHMARK" },
      { text: "Theory", link: "/THEORY" },
      { text: "Taste Guide", link: "/TASTE" },
      { text: "Roadmap", link: "/ROADMAP" },
    ],
  },
];

export function normalizeDocPath(path: string): string {
  const cleanPath = path.split("#")[0]?.split("?")[0] ?? "/";
  const withoutHtml = cleanPath.replace(/\.html$/, "");
  const withLeadingSlash = withoutHtml.startsWith("/")
    ? withoutHtml
    : `/${withoutHtml}`;

  if (withLeadingSlash === "/index") {
    return "/";
  }

  if (withLeadingSlash !== "/" && withLeadingSlash.endsWith("/index")) {
    return withLeadingSlash.slice(0, -"/index".length) || "/";
  }

  if (withLeadingSlash !== "/" && withLeadingSlash.endsWith("/")) {
    return withLeadingSlash;
  }

  return withLeadingSlash;
}

export function flatDocPages(): SitePage[] {
  return sidebarGroups.flatMap((group) =>
    group.items.map((item) => ({
      ...item,
      section: group.text,
      parent:
        normalizeDocPath(item.link) === normalizeDocPath(group.link)
          ? null
          : { text: group.text, link: group.link },
    })),
  );
}
