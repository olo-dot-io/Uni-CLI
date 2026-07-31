/**
 * @owner       src::core::intent-frame
 * @does        Parse a task into compositional verb, entity, cardinality, target, substrate, and negation signals before lexical ranking.
 * @needs       shared operation/operator types
 * @feeds       discovery feasibility and entity-aware ranking
 * @breaks      Treating every leading read/open token alike routes plural collections, status URLs, and coordinate actions to the wrong physical capability.
 * @invariants  URL shapes and explicit substrate phrases outrank ambiguous aliases; a bare variable named x is never a provider identity.
 * @side-effects None.
 * @perf        O(intent length) over a bounded set of regular expressions.
 * @concurrency Pure.
 * @test        tests/unit/intent-frame.test.ts, tests/unit/commands/do.test.ts
 * @stability   experimental
 * @since       2026-07-30
 */

import type { ExecutionOperator, OperationFamily } from "../types.js";

export type IntentEntity =
  | "github-issue"
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

  const githubIssue =
    /\bgithub\b.{0,48}\bissues?\b|\bissues?\b.{0,48}\bgithub\b/.exec(
      normalized,
    );
  if (githubIssue) {
    siteHints.add("gh");
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

  const githubRelease =
    /\bgithub\b.{0,48}\breleases?\b|\breleases?\b.{0,48}\bgithub\b/.exec(
      normalized,
    );
  if (githubRelease) {
    siteHints.add("gh");
    // The current gh adapter exposes `gh release list`; singular prose does
    // not supply an exact tag/id and must not fabricate a get operation.
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
    /\b(?:twitter|tweet|tweets|twitter\/x)\b/.test(normalized) &&
    /\b(?:post|status|tweet|thread)\b/.test(normalized)
  ) {
    siteHints.add("twitter");
    const many = /\b(?:posts|statuses|tweets|threads)\b/.test(normalized);
    return {
      normalized,
      entity: "twitter-post",
      cardinality: many ? "many" : "one",
      site_hints: [...siteHints],
      operation_family: many ? "list" : "get",
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
    case "github-issue":
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
    case "github-release":
      return id === "gh/release" ? 80 : site === "gh" ? -12 : 0;
    case "twitter-post":
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
