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
  locale: LocaleKey;
  markdownPath: string;
  sourceLink: string;
  parent: SiteLeaf | null;
};

export type LocaleKey = "root" | "zh";

type LocaleSiteMap = {
  label: string;
  lang: string;
  link: string;
  topNav: SiteLeaf[];
  sidebarGroups: SiteGroup[];
};

const rootTopNav = [
  { text: "Start", link: "/guide/getting-started" },
  { text: "Sites", link: "/reference/sites" },
  { text: "Guides", link: "/guide/" },
  { text: "Reference", link: "/reference/" },
  { text: "Architecture", link: "/ARCHITECTURE" },
  { text: "npm", link: "https://www.npmjs.com/package/@zenalexa/unicli" },
];

const rootSidebarGroups: SiteGroup[] = [
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
      { text: "Roadmap", link: "/ROADMAP" },
    ],
  },
];

const zhTopNav = [
  { text: "开始", link: "/guide/getting-started" },
  { text: "站点", link: "/reference/sites" },
  { text: "指南", link: "/guide/" },
  { text: "参考", link: "/reference/" },
  { text: "架构", link: "/ARCHITECTURE" },
  { text: "npm", link: "https://www.npmjs.com/package/@zenalexa/unicli" },
];

const zhSidebarGroups: SiteGroup[] = [
  {
    text: "开始",
    link: "/",
    items: [
      { text: "概览", link: "/" },
      { text: "快速开始", link: "/guide/getting-started" },
      { text: "集成方式", link: "/guide/integrations" },
      { text: "常用配方", link: "/RECIPES" },
    ],
  },
  {
    text: "指南",
    link: "/guide/",
    items: [
      { text: "指南索引", link: "/guide/" },
      { text: "适配器", link: "/guide/adapters" },
      { text: "自修复", link: "/guide/self-repair" },
    ],
  },
  {
    text: "参考",
    link: "/reference/",
    items: [
      { text: "参考索引", link: "/reference/" },
      { text: "站点目录", link: "/reference/sites" },
      { text: "适配器格式", link: "/ADAPTER-FORMAT" },
      { text: "管线步骤", link: "/reference/pipeline" },
      { text: "退出码", link: "/reference/exit-codes" },
      { text: "维护工具", link: "/reference/maintenance" },
      { text: "插件开发", link: "/PLUGIN" },
      { text: "发布", link: "/reference/release" },
    ],
  },
  {
    text: "解释",
    link: "/ARCHITECTURE",
    items: [
      { text: "架构", link: "/ARCHITECTURE" },
      { text: "基准", link: "/BENCHMARK" },
      { text: "理论", link: "/THEORY" },
      { text: "路线图", link: "/ROADMAP" },
    ],
  },
];

function localePath(link: string, locale: LocaleKey): string {
  if (/^[a-zA-Z][a-zA-Z\d+-.]*:/.test(link) || link.startsWith("//")) {
    return link;
  }

  if (locale === "root") {
    return link;
  }

  if (link === "/") {
    return "/zh/";
  }

  return `/zh${link}`;
}

function localizeLeaf(leaf: SiteLeaf, locale: LocaleKey): SiteLeaf {
  return { ...leaf, link: localePath(leaf.link, locale) };
}

function localizeGroups(groups: SiteGroup[], locale: LocaleKey): SiteGroup[] {
  return groups.map((group) => ({
    ...localizeLeaf(group, locale),
    items: group.items.map((item) => localizeLeaf(item, locale)),
  }));
}

function markdownPathForLink(link: string, locale: LocaleKey): string {
  const sourceLink = sourceLinkForLocalePath(link);
  if (sourceLink === "/") {
    return locale === "root" ? "/markdown/index.md" : "/markdown/zh/index.md";
  }

  const relativeLink = sourceLink.replace(/^\/+/, "").replace(/\/$/, "");
  return locale === "root"
    ? `/markdown/${relativeLink}.md`
    : `/markdown/zh/${relativeLink}.md`;
}

function sourceLinkForLocalePath(link: string): string {
  const withoutLocale = link.replace(/^\/zh(?=\/|$)/, "") || "/";
  return normalizeDocPath(withoutLocale);
}

export const supportedLocales = ["root", "zh"] as const;

export const localizedSiteMaps: Record<LocaleKey, LocaleSiteMap> = {
  root: {
    label: "English",
    lang: "en-US",
    link: "/",
    topNav: rootTopNav,
    sidebarGroups: rootSidebarGroups,
  },
  zh: {
    label: "简体中文",
    lang: "zh-CN",
    link: "/zh/",
    topNav: zhTopNav.map((item) => localizeLeaf(item, "zh")),
    sidebarGroups: localizeGroups(zhSidebarGroups, "zh"),
  },
};

export const topNav = localizedSiteMaps.root.topNav;
export const sidebarGroups = localizedSiteMaps.root.sidebarGroups;

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

export function flatDocPages(locale: LocaleKey = "root"): SitePage[] {
  const groups = localizedSiteMaps[locale].sidebarGroups;

  return groups.flatMap((group) =>
    group.items.map((item) => ({
      ...item,
      locale,
      markdownPath: markdownPathForLink(item.link, locale),
      sourceLink: sourceLinkForLocalePath(item.link),
      section: group.text,
      parent:
        normalizeDocPath(item.link) === normalizeDocPath(group.link)
          ? null
          : { text: group.text, link: group.link },
    })),
  );
}
