/**
 * @owner       src::discovery::intent-plan
 * @does        Parse a task into compositional verb, entity, cardinality, target, substrate, and negation signals before lexical ranking.
 * @needs       shared operation/operator types
 * @feeds       discovery feasibility and entity-aware ranking
 * @breaks      Treating every leading read/open token alike routes plural collections, status URLs, and coordinate actions to the wrong physical capability.
 * @invariants  URL shapes and explicit substrate phrases outrank ambiguous aliases; a bare variable named x is never a provider identity.
 * @side-effects None.
 * @perf        O(intent length) over a bounded set of regular expressions.
 * @concurrency Pure.
 * @test        tests/unit/intent-plan.test.ts, tests/unit/commands/do.test.ts
 * @stability   experimental
 * @since       2026-07-30
 */

import { inferIntentOperationFamily } from "../core/operation-family.js";
import { listCoreDiscoverySites } from "./core-catalog.js";
import { SITE_ALIASES } from "./aliases.js";
import { getAllAdapters, getRegistryVersion } from "../registry.js";
import type {
  ExecutionOperator,
  OperationEffect,
  OperationFamily,
  OperatorTargetScope,
  TargetSurface,
} from "../types.js";

export type InteractionImpact = "background" | "target-scoped" | "foreground";

export interface CapabilityRequirements {
  operator?: ExecutionOperator;
  operation_family?: OperationFamily;
  required_sites?: string[];
  forbidden_operators?: ExecutionOperator[];
  allow_browser?: boolean;
  target_surface?: TargetSurface;
  target_scope?: OperatorTargetScope;
  effect?: OperationEffect;
  max_interaction_impact?: InteractionImpact;
  platform?: NodeJS.Platform;
  /** Whether coordinate-based actuation is explicitly authorized. */
  allow_coordinate_actuation?: boolean;
}

export type IntentEntity =
  | "github-issue"
  | "github-trending"
  | "github-pull-request"
  | "github-commit"
  | "github-code"
  | "github-repository"
  | "github-user"
  | "github-topic"
  | "github-release"
  | "twitter-post"
  | "browser-console"
  | "browser-tabs"
  | "browser-url"
  | "browser-network"
  | "desktop-context-capture"
  | "screenshot"
  | "coordinate-action";

export interface TaskIntentFrame {
  readonly normalized: string;
  readonly entity?: IntentEntity;
  readonly cardinality?: "one" | "many";
  readonly site_hints: readonly string[];
  readonly operation_family?: OperationFamily;
  readonly operator?: ExecutionOperator;
  readonly without_browser: boolean;
}

export function resolveTaskIntentFrame(intent: string): TaskIntentFrame {
  const normalized = intent.normalize("NFKC").toLowerCase();
  const siteHints = new Set<string>();
  const wantsSearch =
    /\b(search|find|lookup|query|discover)\b|搜索|检索|查找|模糊|(?:^|[^未])找/.test(
      normalized,
    );
  const githubContext =
    /\b(?:github|gh|repo|repository|repos|repositories)\b|仓库/.test(
      normalized,
    );
  const githubTrending =
    /\bgithub\b.{0,32}\btrending\b|\btrending\b.{0,32}\bgithub\b/.test(
      normalized,
    );
  const withoutBrowser =
    /\b(without|no|not using|do not use|don't use)\s+(?:a\s+)?browser\b/i.test(
      normalized,
    ) || /不(?:要|用|通过)浏览器|无需浏览器|非浏览器/.test(normalized);

  if (
    /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/\s]+\/status\/\d+/i.test(
      normalized,
    )
  ) {
    siteHints.add("twitter");
    return {
      normalized,
      entity: "twitter-post",
      cardinality: "one",
      site_hints: [...siteHints],
      operation_family: "get",
      without_browser: withoutBrowser,
    };
  }

  if (/(?:^|\s)hn(?:\s|$)|\bhacker\s+news\b/.test(normalized)) {
    siteHints.add("hackernews");
  }

  if (githubTrending) {
    siteHints.add("github-trending");
    return {
      normalized,
      entity: "github-trending",
      cardinality: "many",
      site_hints: [...siteHints],
      operation_family: "list",
      without_browser: withoutBrowser,
    };
  }

  const coordinateAction =
    /\b(click|tap|drag|move|press|scroll)\b/.test(normalized) &&
    (/\b(?:absolute\s+)?(?:desktop|screen|pixel)[- ]coordinates?\b/.test(
      normalized,
    ) ||
      /\bpoint[- ]click\b/.test(normalized) ||
      /\b(?:cua|computer[- ]use)\s+driver\b/.test(normalized) ||
      /按(?:桌面|屏幕|像素)坐标(?:点击|拖动|操作)/.test(normalized));
  if (coordinateAction) {
    return {
      normalized,
      entity: "coordinate-action",
      cardinality: "one",
      site_hints: [...siteHints],
      operation_family: "invoke",
      operator: "visual-coordinate",
      without_browser: withoutBrowser,
    };
  }

  const githubIssue = githubContext
    ? /\bissues?\b|议题/.exec(normalized)
    : /\bgithub\b.{0,48}\bissues?\b|\bissues?\b.{0,48}\bgithub\b/.exec(
        normalized,
      );
  if (githubIssue) {
    siteHints.add("gh");
    if (wantsSearch) {
      return {
        normalized,
        entity: "github-issue",
        cardinality: "many",
        site_hints: [...siteHints],
        operation_family: "search",
        without_browser: withoutBrowser,
      };
    }
    const many = /\bissues\b/.test(githubIssue[0]);
    return {
      normalized,
      entity: "github-issue",
      cardinality: many ? "many" : "one",
      site_hints: [...siteHints],
      operation_family: many ? "list" : "get",
      without_browser: withoutBrowser,
    };
  }

  if (
    githubContext &&
    /\bprs?\b|\bpull[ -]requests?\b|拉取请求/.test(normalized)
  ) {
    siteHints.add("gh");
    return {
      normalized,
      entity: "github-pull-request",
      cardinality: "many",
      site_hints: [...siteHints],
      operation_family: wantsSearch ? "search" : "list",
      without_browser: withoutBrowser,
    };
  }

  if (githubContext && /\bcommits?\b|提交/.test(normalized)) {
    siteHints.add("gh");
    return {
      normalized,
      entity: "github-commit",
      cardinality: "many",
      site_hints: [...siteHints],
      operation_family: "search",
      without_browser: withoutBrowser,
    };
  }

  if (githubContext && /\breleases?\b|版本发布/.test(normalized)) {
    siteHints.add("gh");
    return {
      normalized,
      entity: "github-release",
      cardinality: "many",
      site_hints: [...siteHints],
      operation_family: "list",
      without_browser: withoutBrowser,
    };
  }

  if (
    (githubContext &&
      (/\b(?:source|implementation)\b|源码|代码实现/.test(normalized) ||
        (/\bcode\b/.test(normalized) &&
          !/\b(?:repos?|repositories|repository)\b|仓库/.test(normalized)))) ||
    /搜索源码|查找源码|源码实现/.test(normalized)
  ) {
    siteHints.add("gh");
    return {
      normalized,
      entity: "github-code",
      cardinality: "many",
      site_hints: [...siteHints],
      operation_family: "search",
      without_browser: withoutBrowser,
    };
  }

  if (
    githubContext &&
    /\b(?:repos?|repositories|repository)\b|仓库/.test(normalized)
  ) {
    siteHints.add("gh");
    const wantsRepositoryGet =
      /^(?:gh|github)\s+(?:repo|repository)$/.test(normalized.trim()) ||
      /\b(?:read|get|view|inspect|details?)\b|查看|读取|详情/.test(normalized);
    const repositorySearch = wantsSearch || !wantsRepositoryGet;
    return {
      normalized,
      entity: "github-repository",
      cardinality: repositorySearch ? "many" : "one",
      site_hints: [...siteHints],
      operation_family: repositorySearch ? "search" : "get",
      without_browser: withoutBrowser,
    };
  }

  if (
    githubContext &&
    /\b(?:authors?|maintainers?|users?|owners?)\b|作者|维护者/.test(normalized)
  ) {
    siteHints.add("gh");
    return {
      normalized,
      entity: "github-user",
      cardinality: "many",
      site_hints: [...siteHints],
      operation_family: "search",
      without_browser: withoutBrowser,
    };
  }

  if (githubContext && /\btopics?\b|主题|技术栈/.test(normalized)) {
    siteHints.add("gh");
    return {
      normalized,
      entity: "github-topic",
      cardinality: "many",
      site_hints: [...siteHints],
      operation_family: "search",
      without_browser: withoutBrowser,
    };
  }

  if (
    (/\b(?:twitter|tweet|tweets|twitter\/x)\b/.test(normalized) &&
      /\b(?:post|status|tweet|thread)\b/.test(normalized)) ||
    /发(?:一条)?推(?:文|特)|发布(?:一条)?推文|推特帖子/.test(normalized)
  ) {
    siteHints.add("twitter");
    const createsPost =
      /\b(?:post|publish|send|write|create)\b.{0,32}\b(?:tweet|twitter post)\b|发(?:一条)?推(?:文|特)|发布(?:一条)?推文/.test(
        normalized,
      );
    const many = /\b(?:posts|statuses|tweets|threads)\b/.test(normalized);
    return {
      normalized,
      entity: "twitter-post",
      cardinality: many ? "many" : "one",
      site_hints: [...siteHints],
      operation_family: createsPost ? "create" : many ? "list" : "get",
      without_browser: withoutBrowser,
    };
  }

  const browserEntity = resolveBrowserEntity(normalized);
  if (browserEntity) {
    return {
      normalized,
      entity: browserEntity.entity,
      cardinality: browserEntity.cardinality,
      site_hints: ["browser", ...siteHints],
      operation_family: browserEntity.operation,
      operator: browserEntity.operator,
      without_browser: withoutBrowser,
    };
  }

  const desktopContextCapture =
    /\b(?:capture|app[- ]?shots?|handoff|reference)\b/.test(normalized) &&
    /\b(?:computer[- ]?use|desktop|local|apps?|windows?)\b/.test(normalized) &&
    /\b(?:accessibility|snapshot|refs?|screenshot|pixels?|app[- ]?shots?)\b/.test(
      normalized,
    );
  if (desktopContextCapture) {
    return {
      normalized,
      entity: "desktop-context-capture",
      cardinality: "one",
      site_hints: ["compute", ...siteHints],
      operation_family: "capture",
      operator: "local-runtime",
      without_browser: withoutBrowser,
    };
  }

  if (
    /\b(?:capture|take|make)?\s*(?:a\s+)?screenshot\b|截图/.test(normalized)
  ) {
    return {
      normalized,
      entity: "screenshot",
      cardinality: "one",
      site_hints: [...siteHints],
      operation_family: "capture",
      operator: /\b(?:visual|pixel|screen)\b/.test(normalized)
        ? "visual-observation"
        : undefined,
      without_browser: withoutBrowser,
    };
  }

  return {
    normalized,
    site_hints: [...siteHints],
    without_browser: withoutBrowser,
  };
}

function resolveBrowserEntity(normalized: string):
  | {
      entity: IntentEntity;
      cardinality: "one" | "many";
      operation: OperationFamily;
      operator: ExecutionOperator;
    }
  | undefined {
  if (!/\bbrowser\b/.test(normalized)) return undefined;
  if (/\bconsole\b/.test(normalized)) {
    return {
      entity: "browser-console",
      cardinality: "many",
      operation: "list",
      operator: "browser-protocol",
    };
  }
  if (/\btabs?\b/.test(normalized)) {
    return {
      entity: "browser-tabs",
      cardinality: "many",
      operation: "list",
      operator: "browser-protocol",
    };
  }
  if (/\b(?:current\s+)?url\b/.test(normalized)) {
    return {
      entity: "browser-url",
      cardinality: "one",
      operation: "get",
      operator: "browser-protocol",
    };
  }
  if (/\bnetwork\b/.test(normalized)) {
    return {
      entity: "browser-network",
      cardinality: "many",
      operation: "list",
      operator: "browser-protocol",
    };
  }
  if (/\bscreenshot\b/.test(normalized)) {
    return {
      entity: "screenshot",
      cardinality: "one",
      operation: "capture",
      operator: "visual-observation",
    };
  }
  return undefined;
}

export function intentEntityCommandBoost(
  frame: TaskIntentFrame,
  site: string,
  command: string,
  effectiveSiteHints: readonly string[] = frame.site_hints,
): number {
  const id = `${site}/${command}`;
  switch (frame.entity) {
    case "github-trending":
      if (site !== "github-trending") return 0;
      if (/\bdevelopers?\b|开发者/.test(frame.normalized)) {
        return command === "developers" ? 96 : -16;
      }
      if (/\bweekly\b|本周|周榜/.test(frame.normalized)) {
        return command === "weekly" ? 96 : -16;
      }
      return command === "daily" ? 96 : command === "weekly" ? 20 : -12;
    case "github-issue":
      if (frame.operation_family === "search") {
        return id === "gh/search-issues"
          ? 96
          : id === "gh/issue" || id === "gh/issue-thread"
            ? -28
            : site === "gh"
              ? -8
              : 0;
      }
      return frame.cardinality === "many"
        ? id === "gh/issue"
          ? 80
          : id === "gh/issue-thread"
            ? -28
            : 0
        : id === "gh/issue-thread"
          ? 80
          : id === "gh/issue"
            ? -20
            : 0;
    case "github-pull-request":
      return frame.operation_family === "search"
        ? id === "gh/search-prs"
          ? 96
          : id === "gh/pr" || id === "gh/pr-thread"
            ? -24
            : site === "gh"
              ? -8
              : 0
        : id === "gh/pr"
          ? 80
          : site === "gh"
            ? -12
            : 0;
    case "github-commit":
      return id === "gh/search-commits" ? 96 : site === "gh" ? -10 : 0;
    case "github-code":
      return id === "gh/search-code" ? 96 : site === "gh" ? -10 : 0;
    case "github-repository":
      return frame.operation_family === "search"
        ? id === "gh/search-repos"
          ? 96
          : id === "gh/search-topics"
            ? 18
            : site === "gh"
              ? -10
              : 0
        : id === "gh/repo"
          ? 80
          : site === "gh"
            ? -12
            : 0;
    case "github-user":
      return id === "gh/search-users" ? 96 : site === "gh" ? -10 : 0;
    case "github-topic":
      return id === "gh/search-topics"
        ? 96
        : id === "gh/search-repos"
          ? 16
          : site === "gh"
            ? -10
            : 0;
    case "github-release":
      return id === "gh/release" ? 80 : site === "gh" ? -12 : 0;
    case "twitter-post":
      if (frame.operation_family === "create") {
        return id === "twitter/post"
          ? 96
          : id === "twitter/native-post" || id === "twitter/native-tweet"
            ? 24
            : id === "twitter/thread"
              ? -48
              : site === "twitter"
                ? -12
                : 0;
      }
      return id === "twitter/thread"
        ? 96
        : site === "twitter" &&
            ["post", "user-timeline", "tweets", "user-tweets"].includes(command)
          ? -32
          : 0;
    case "browser-console":
      return id === "browser/console" ? 96 : site === "browser" ? -12 : 0;
    case "browser-tabs":
      return id === "browser/tabs" ? 96 : site === "browser" ? -12 : 0;
    case "browser-url":
      return id === "browser/get url" ? 96 : site === "browser" ? -12 : 0;
    case "browser-network":
      return id === "browser/network" ? 96 : site === "browser" ? -12 : 0;
    case "desktop-context-capture":
      return id === "compute/capture"
        ? 96
        : id === "compute/snapshot"
          ? 24
          : id === "compute/screenshot"
            ? 12
            : site === "compute"
              ? -8
              : 0;
    case "screenshot":
      return effectiveSiteHints.length > 0
        ? command === "screenshot" && effectiveSiteHints.includes(site)
          ? 96
          : 0
        : id === "compute/screenshot"
          ? 64
          : 0;
    case "coordinate-action":
      return id === "compute/point-click"
        ? 96
        : id === "compute/click"
          ? -48
          : 0;
    default:
      return 0;
  }
}

/**
 * Infer only explicit substrate language. Ordinary mentions of a website,
 * application, click, or screenshot do not authorize a broader operator.
 */
export function inferCapabilityRequirements(
  intent: string,
): CapabilityRequirements {
  const normalized = intent.normalize("NFKC").toLowerCase();
  const frame = resolveTaskIntentFrame(normalized);
  return capabilityRequirementsForFrame(normalized, frame);
}

function capabilityRequirementsForFrame(
  normalized: string,
  frame: TaskIntentFrame,
): CapabilityRequirements {
  const operator = frame.operator ?? explicitOperator(normalized);
  const operationFamily =
    frame.operation_family ?? inferIntentOperationFamily(normalized);
  const requiredSites = [
    ...new Set([...inferExplicitSites(normalized), ...frame.site_hints]),
  ].sort();
  return {
    ...(operator ? { operator } : {}),
    ...(operationFamily ? { operation_family: operationFamily } : {}),
    ...(requiredSites.length > 0 ? { required_sites: requiredSites } : {}),
    ...(operator === "visual-coordinate"
      ? { allow_coordinate_actuation: true }
      : {}),
  };
}

const NON_PROVIDER_SITE_IDS = new Set([
  "browser",
  "compute",
  "operate",
  "auth",
  "repair",
  "core",
]);

const HIGH_CONFIDENCE_BARE_SITES = new Set([
  "reddit",
  "twitter",
  "gh",
  "gitlab",
  "hackernews",
  "linux-do",
  "youtube",
  "bilibili",
  "zhihu",
  "xiaohongshu",
  "douyin",
  "notion",
  "slack",
  "spotify",
  "figma",
  "discord",
  "instagram",
  "facebook",
  "tiktok",
  "linkedin",
  "stackoverflow",
]);

const CANONICAL_SITE_PHRASES: ReadonlyArray<readonly [string, string]> = [
  ["hacker news", "hackernews"],
  ["linux do", "linux-do"],
  ["little red book", "xiaohongshu"],
];

interface IntentSiteIndex {
  readonly version: number;
  readonly sites: ReadonlySet<string>;
  readonly bare: ReadonlyArray<{
    site: string;
    phrase: string;
    url: RegExp;
  }>;
  readonly aliases: ReadonlyArray<{
    site: string;
    normalized: string;
    distinctive: boolean;
    explicitContext: RegExp;
  }>;
}

let intentSiteIndex: IntentSiteIndex | undefined;

function loadIntentSiteIndex(): IntentSiteIndex {
  const version = getRegistryVersion();
  if (intentSiteIndex?.version === version) return intentSiteIndex;
  const sites = new Set([
    ...getAllAdapters().map((adapter) => adapter.name),
    ...listCoreDiscoverySites().map((site) => site.site),
  ]);
  const bare = [...sites]
    .filter(
      (site) =>
        !NON_PROVIDER_SITE_IDS.has(site) &&
        HIGH_CONFIDENCE_BARE_SITES.has(site),
    )
    .map((site) => ({
      site,
      phrase: normalizeSiteText(site),
      url: new RegExp(
        `https?://[^\\s/]*${escapeRegex(site.replaceAll("-", ""))}`,
        "iu",
      ),
    }));
  const aliases = [...SITE_ALIASES]
    .filter(([, site]) => sites.has(site))
    .map(([alias, site]) => {
      const normalized = normalizeSiteText(alias);
      const escaped = escapeRegex(alias.normalize("NFKC").toLowerCase());
      return {
        site,
        normalized,
        distinctive: /[\u3400-\u9fff]/u.test(normalized)
          ? normalized.length >= 2
          : normalized.length >= 4,
        explicitContext: new RegExp(
          `(?:\\b(?:on|from|via|through|using)\\s+${escaped}\\b|(?:在|从|通过|使用)\\s*${escaped})`,
          "iu",
        ),
      };
    });
  intentSiteIndex = { version, sites, bare, aliases };
  return intentSiteIndex;
}

function inferExplicitSites(intent: string): string[] {
  const normalized = normalizeSiteText(intent);
  const index = loadIntentSiteIndex();
  const required = new Set<string>();
  const compactIntent = intent.replaceAll("-", "");
  for (const entry of index.bare) {
    const explicitHandle = intent.includes(`@${entry.site}`);
    const explicitUrl = entry.url.test(compactIntent);
    if (
      explicitHandle ||
      explicitUrl ||
      (entry.phrase && hasBoundedPhrase(normalized, entry.phrase))
    ) {
      required.add(entry.site);
    }
  }
  for (const [phrase, site] of CANONICAL_SITE_PHRASES) {
    if (index.sites.has(site) && hasBoundedPhrase(normalized, phrase)) {
      required.add(site);
    }
  }
  for (const alias of index.aliases) {
    if (
      HIGH_CONFIDENCE_BARE_SITES.has(alias.site) &&
      alias.distinctive &&
      hasBoundedPhrase(normalized, alias.normalized)
    ) {
      required.add(alias.site);
    }
    if (alias.explicitContext.test(intent)) required.add(alias.site);
  }
  return [...required].sort();
}

function normalizeSiteText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function hasBoundedPhrase(value: string, phrase: string): boolean {
  return ` ${value} `.includes(` ${phrase} `);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface IntentCapabilityPlan {
  readonly task_text: string;
  readonly frame: TaskIntentFrame;
  readonly requirements: CapabilityRequirements;
}

/** Compile task semantics and substrate constraints once before ranking. */
export function compileIntentPlan(intent: string): IntentCapabilityPlan {
  const normalized = intent.normalize("NFKC");
  const frame = resolveTaskIntentFrame(normalized);
  const requirements = capabilityRequirementsForFrame(
    normalized.toLowerCase(),
    frame,
  );
  if (frame.without_browser) {
    requirements.allow_browser = false;
    requirements.forbidden_operators = ["browser-protocol", "browser-semantic"];
  }
  const taskText = normalized
    .replace(
      /\b(?:using|use|via|through|with)\s+(?:a\s+)?(?:native cli|command[- ]line interface|structured api|service api|direct http|http api|browser protocol|browser context api|browser semantic|desktop accessibility|accessibility tree|visual observation|visual screenshot|pixel screenshot|pixel capture|screen capture|visual[- ]coordinate|(?:absolute\s+)?(?:desktop|screen|pixel)[- ]coordinates?|cua driver|computer[- ]use driver|local runtime)\b/gi,
      " ",
    )
    .replace(
      /\b(?:without|no|not using|do not use|don't use)\s+(?:a\s+)?browser\b/gi,
      " ",
    )
    .replace(
      /(?:使用|通过|采用)?(?:原生命令行|结构化接口|服务接口|直接\s*HTTP|HTTP\s*接口|浏览器协议接口|浏览器语义|桌面无障碍|辅助功能树|视觉观察|视觉截图|像素截图|像素捕获|视觉坐标|本地运行时)|不(?:要|用|通过)浏览器|无需浏览器|非浏览器/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  return {
    task_text: taskText || normalized.trim(),
    frame,
    requirements,
  };
}

/** @deprecated Use compileIntentPlan. */
export function parseIntentCapabilityPlan(
  intent: string,
): IntentCapabilityPlan {
  return compileIntentPlan(intent);
}

export function mergeCapabilityRequirements(
  inferred: CapabilityRequirements,
  explicit: CapabilityRequirements,
): CapabilityRequirements {
  return {
    ...inferred,
    ...Object.fromEntries(
      Object.entries(explicit).filter(([, value]) => value !== undefined),
    ),
  };
}

function explicitOperator(intent: string): ExecutionOperator | undefined {
  if (
    /\b(visual|pixel|screen)\b.{0,30}\b(screenshot|screen capture|pixel capture)\b/.test(
      intent,
    ) ||
    /\b(screenshot|screen capture|pixel capture|capture)\b.{0,40}\b(visually|by pixels?|pixels?|visual observation)\b/.test(
      intent,
    ) ||
    /\bvisual observation\b/.test(intent) ||
    /视觉观察|视觉截图|像素截图|截图像素|屏幕像素捕获|像素捕获/.test(intent)
  ) {
    return "visual-observation";
  }
  if (
    /\b(visual[- ]coordinate|pixel[- ]only|coordinate action|point[- ]click|cua driver|computer[- ]use driver)\b/.test(
      intent,
    ) ||
    /\b(click|tap|drag|move|press|scroll)\b.{0,40}\b((?:absolute )?(?:desktop|screen|pixel) coordinates?|visually|by pixels?)\b/.test(
      intent,
    ) ||
    /\b((?:absolute )?(?:desktop|screen|pixel) coordinates?|visually|by pixels?)\b.{0,40}\b(click|tap|drag|move|press|scroll)\b/.test(
      intent,
    ) ||
    /视觉坐标|纯像素|按屏幕坐标(?:点击|拖动|操作)/.test(intent)
  ) {
    return "visual-coordinate";
  }
  if (
    /\b(desktop accessibility|accessibility tree|using accessibility|via accessibility|uia|at-spi|desktop-ax)\b/.test(
      intent,
    ) ||
    /桌面无障碍|辅助功能树/.test(intent)
  ) {
    return "desktop-accessibility";
  }
  if (
    /\b(browser protocol|browser context api|renderer api)\b/.test(intent) ||
    /浏览器协议接口|浏览器上下文接口/.test(intent)
  ) {
    return "browser-protocol";
  }
  if (
    /\b(browser semantic|dom ref|css selector|cdp renderer)\b/.test(intent) ||
    /浏览器语义|dom 引用|选择器/.test(intent)
  ) {
    return "browser-semantic";
  }
  if (
    /\b(native cli|command[- ]line interface|via gh cli)\b/.test(intent) ||
    /原生命令行/.test(intent)
  ) {
    return "native-cli";
  }
  if (
    /\b(structured api|service api|direct http|http api|protocol call)\b/.test(
      intent,
    ) ||
    /结构化接口|服务接口|直接\s*HTTP|HTTP\s*接口/i.test(intent)
  ) {
    return "structured-api";
  }
  if (
    /\b(local runtime|pure local transform)\b/.test(intent) ||
    /本地运行时/.test(intent)
  ) {
    return "local-runtime";
  }
  return undefined;
}
