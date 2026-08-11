export type SiteLeaf = {
  text: string;
  link: string;
  activeMatch?: string;
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
  {
    text: "Docs",
    link: "/guide/getting-started",
    activeMatch:
      "^/(?:zh/)?(?:guide/(?:getting-started|upgrading)|how-it-works)$",
  },
  {
    text: "Operations",
    link: "/reference/sites",
    activeMatch: "^/(?:zh/)?(?:guide/?|reference/sites)$",
  },
  {
    text: "Integrations",
    link: "/guide/integrations",
    activeMatch:
      "^/(?:zh/)?guide/(?:integrations|authentication|browser-desktop)$",
  },
  {
    text: "Build",
    link: "/guide/adapters",
    activeMatch:
      "^/(?:zh/)?(?:guide/adapters|ADAPTER-FORMAT|PLUGIN|reference/pipeline)$",
  },
  {
    text: "Reference",
    link: "/reference/",
    activeMatch:
      "^/(?:zh/)?(?:reference/(?!sites(?:$|/)|pipeline(?:$|/))|glossary)",
  },
];

const rootSidebarGroups: SiteGroup[] = [
  {
    text: "Start",
    link: "/",
    items: [
      { text: "Overview", link: "/" },
      { text: "Quickstart", link: "/guide/getting-started" },
      { text: "Keep Uni-CLI Current", link: "/guide/upgrading" },
      { text: "Connect An Agent", link: "/guide/integrations" },
      { text: "How Uni-CLI Works", link: "/how-it-works" },
    ],
  },
  {
    text: "Use Uni-CLI",
    link: "/guide/",
    items: [
      { text: "Find An Operation", link: "/guide/" },
      { text: "Authentication", link: "/guide/authentication" },
      { text: "Browser And Desktop", link: "/guide/browser-desktop" },
      { text: "Recipes", link: "/RECIPES" },
      { text: "Repair And Evolve", link: "/guide/self-repair" },
      { text: "Trace Scholarly Work", link: "/guide/scholarly-discovery" },
      { text: "Archive OpenReview", link: "/guide/openreview-archive" },
    ],
  },
  {
    text: "Build",
    link: "/guide/adapters",
    items: [
      { text: "Create An Adapter", link: "/guide/adapters" },
      { text: "Adapter Format", link: "/ADAPTER-FORMAT" },
      { text: "Pipeline Steps", link: "/reference/pipeline" },
      { text: "Plugin Authoring", link: "/PLUGIN" },
    ],
  },
  {
    text: "Reference",
    link: "/reference/",
    items: [
      { text: "Reference Overview", link: "/reference/" },
      { text: "CLI Commands", link: "/reference/cli" },
      { text: "Operation Catalog", link: "/reference/sites" },
      { text: "Exit Codes", link: "/reference/exit-codes" },
      { text: "Glossary", link: "/glossary" },
    ],
  },
  {
    text: "Project",
    link: "/ARCHITECTURE",
    items: [
      { text: "Architecture", link: "/ARCHITECTURE" },
      { text: "Releases", link: "/releases" },
      { text: "Benchmarks", link: "/BENCHMARK" },
      { text: "Roadmap", link: "/ROADMAP" },
      { text: "FAQ", link: "/faq" },
    ],
  },
];

const zhTopNav = [
  { ...rootTopNav[0], text: "文档" },
  { ...rootTopNav[1], text: "操作目录" },
  { ...rootTopNav[2], text: "接入" },
  { ...rootTopNav[3], text: "扩展" },
  { ...rootTopNav[4], text: "参考" },
];

const zhSidebarGroups: SiteGroup[] = [
  {
    text: "上手",
    link: "/",
    items: [
      { text: "概览", link: "/" },
      { text: "快速开始", link: "/guide/getting-started" },
      { text: "更新 Uni-CLI", link: "/guide/upgrading" },
      { text: "接入 Agent", link: "/guide/integrations" },
      { text: "工作原理", link: "/how-it-works" },
    ],
  },
  {
    text: "使用 Uni-CLI",
    link: "/guide/",
    items: [
      { text: "查找操作", link: "/guide/" },
      { text: "登录与认证", link: "/guide/authentication" },
      { text: "浏览器与桌面", link: "/guide/browser-desktop" },
      { text: "常用场景", link: "/RECIPES" },
      { text: "修复与进化", link: "/guide/self-repair" },
      { text: "跨站追踪学术资源", link: "/guide/scholarly-discovery" },
      { text: "归档 OpenReview", link: "/guide/openreview-archive" },
    ],
  },
  {
    text: "扩展",
    link: "/guide/adapters",
    items: [
      { text: "创建适配器", link: "/guide/adapters" },
      { text: "适配器格式", link: "/ADAPTER-FORMAT" },
      { text: "管线步骤", link: "/reference/pipeline" },
      { text: "插件开发", link: "/PLUGIN" },
    ],
  },
  {
    text: "参考",
    link: "/reference/",
    items: [
      { text: "参考概览", link: "/reference/" },
      { text: "CLI 命令", link: "/reference/cli" },
      { text: "操作目录", link: "/reference/sites" },
      { text: "退出码", link: "/reference/exit-codes" },
      { text: "术语表", link: "/glossary" },
    ],
  },
  {
    text: "项目",
    link: "/ARCHITECTURE",
    items: [
      { text: "架构", link: "/ARCHITECTURE" },
      { text: "版本记录", link: "/releases" },
      { text: "基准", link: "/BENCHMARK" },
      { text: "路线图", link: "/ROADMAP" },
      { text: "常见问题", link: "/faq" },
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
