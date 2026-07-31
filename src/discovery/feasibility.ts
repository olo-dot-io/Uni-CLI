/**
 * @owner       src::discovery::feasibility
 * @does        Intersect semantic command candidates with catalog-declared operator, effect, target, platform, and interaction constraints.
 * @needs       command contracts, live/core registries, operator/effect public types.
 * @feeds       search, do, MCP discovery, and future task planners.
 * @breaks      Presenting catalog compatibility as live provider readiness sends agents to unavailable executables or services.
 * @invariants  Hard requirements only remove contract-incompatible candidates; retrieval score never grants execution authority; runtime readiness is explicitly not evaluated here.
 * @side-effects Caches immutable command-contract projections until the registry version changes.
 * @perf        O(1) contract lookup after one projection; one feasibility check is O(1).
 * @concurrency Process-local cache replacement is synchronous and request independent.
 * @test        tests/unit/discovery-feasibility.test.ts, tests/unit/commands/do.test.ts, tests/unit/commands/search.test.ts
 * @stability   experimental
 * @since       2026-07-30
 */

import {
  buildCommandContract,
  buildCoreCommandContract,
  type CommandContract,
} from "../core/command-contract.js";
import {
  getCoreDiscoveryCommand,
  listCoreDiscoverySites,
} from "./core-catalog.js";
import {
  getAllAdapters,
  getRegistryVersion,
  resolveCommand,
} from "../registry.js";
import { SITE_ALIASES } from "./aliases.js";
import type {
  ExecutionOperator,
  OperationFamily,
  OperationEffect,
  OperatorTargetScope,
  TargetSurface,
} from "../types.js";
import { inferIntentOperationFamily } from "../core/operation-family.js";
import { resolveTaskIntentFrame } from "../core/intent-frame.js";

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

export interface CommandFeasibility {
  contract_compatible: boolean;
  compatibility: "compatible" | "unknown" | "incompatible";
  evidence_scope: "catalog_contract";
  runtime_readiness: "not_evaluated";
  command: string;
  requirements: CapabilityRequirements;
  contract?: CommandFeasibilityProfile;
  rejected_by: string[];
  uncertain_by: string[];
}

export interface CommandFeasibilityProfile {
  operation_family: OperationFamily;
  operation_family_source: CommandContract["operation"]["source"];
  operation_family_confidence: CommandContract["operation"]["confidence"];
  operator: ExecutionOperator;
  operator_source: CommandContract["execution"]["operator_source"];
  operator_confidence: CommandContract["execution"]["operator_confidence"];
  target_surface: TargetSurface;
  target_surface_source: CommandContract["effect"]["target_surface_source"];
  target_surface_confidence: CommandContract["effect"]["target_surface_confidence"];
  target_scope: OperatorTargetScope;
  target_scope_source: CommandContract["execution"]["operator_source"];
  target_scope_confidence: CommandContract["execution"]["operator_confidence"];
  effect: OperationEffect;
  effect_source: "declared" | "heuristic" | "default";
  effect_confidence: "high" | "medium" | "low";
  interaction_impact: InteractionImpact;
  coordinate_actuation: boolean;
  platforms?: NodeJS.Platform[];
}

let cachedRegistryVersion = -1;
let contractCache = new Map<string, CommandContract | null>();

export function evaluateCommandFeasibility(
  site: string,
  command: string,
  requirements: CapabilityRequirements,
): CommandFeasibility {
  const contract = commandContract(site, command);
  if (!contract) {
    return {
      contract_compatible: true,
      compatibility:
        Object.keys(requirements).length === 0 ? "compatible" : "unknown",
      evidence_scope: "catalog_contract",
      runtime_readiness: "not_evaluated",
      command: `${site} ${command}`,
      requirements,
      rejected_by: [],
      uncertain_by:
        Object.keys(requirements).length === 0
          ? []
          : ["command contract is unavailable"],
    };
  }
  return evaluateFeasibilityProfile(
    site,
    command,
    commandFeasibilityProfile(contract),
    requirements,
  );
}

export function evaluateFeasibilityProfile(
  site: string,
  command: string,
  profile: CommandFeasibilityProfile,
  requirements: CapabilityRequirements,
): CommandFeasibility {
  const rejectedBy: string[] = [];
  const uncertainBy: string[] = [];
  if (
    requirements.required_sites &&
    requirements.required_sites.length > 0 &&
    !requirements.required_sites.includes(site)
  ) {
    rejectedBy.push(
      `site requires one of ${requirements.required_sites.join(", ")}, candidate uses ${site}`,
    );
  }
  if (
    requirements.operation_family &&
    profile.operation_family !== requirements.operation_family
  ) {
    const reason = `operation requires ${requirements.operation_family}, candidate projects ${profile.operation_family} from ${profile.operation_family_source}`;
    rejectedBy.push(reason);
  }
  if (requirements.operator && profile.operator !== requirements.operator) {
    const reason = `operator requires ${requirements.operator}, candidate projects ${profile.operator} from ${profile.operator_source}`;
    rejectedBy.push(reason);
  }
  if (requirements.forbidden_operators?.includes(profile.operator)) {
    rejectedBy.push(`operator ${profile.operator} is explicitly forbidden`);
  }
  if (
    requirements.allow_browser === false &&
    (profile.operator === "browser-protocol" ||
      profile.operator === "browser-semantic")
  ) {
    rejectedBy.push(
      `browser lifecycle is forbidden but candidate uses ${profile.operator}`,
    );
  }
  if (
    requirements.target_surface &&
    profile.target_surface !== requirements.target_surface
  ) {
    const reason = `target surface requires ${requirements.target_surface}, candidate projects ${profile.target_surface} from ${profile.target_surface_source}`;
    rejectedBy.push(reason);
  }
  if (
    requirements.target_scope &&
    profile.target_scope !== requirements.target_scope
  ) {
    const reason = `target scope requires ${requirements.target_scope}, candidate projects ${profile.target_scope} from ${profile.target_scope_source}`;
    rejectedBy.push(reason);
  }
  if (requirements.effect && profile.effect !== requirements.effect) {
    const reason = `effect requires ${requirements.effect}, candidate projects ${profile.effect} from ${profile.effect_source}`;
    rejectedBy.push(reason);
  }
  if (
    requirements.max_interaction_impact &&
    interactionRank(profile.interaction_impact) >
      interactionRank(requirements.max_interaction_impact)
  ) {
    rejectedBy.push(
      `interaction impact ${profile.interaction_impact} exceeds ${requirements.max_interaction_impact}`,
    );
  }
  const allowCoordinateActuation = requirements.allow_coordinate_actuation;
  if (
    allowCoordinateActuation === false &&
    profile.coordinate_actuation === true
  ) {
    rejectedBy.push("visual-coordinate execution was not authorized");
  }
  if (
    requirements.platform &&
    profile.platforms &&
    !profile.platforms.includes(requirements.platform)
  ) {
    rejectedBy.push(
      `platform requires ${requirements.platform}, candidate supports ${profile.platforms.join(", ")}`,
    );
  }

  return {
    contract_compatible: rejectedBy.length === 0,
    compatibility:
      rejectedBy.length > 0
        ? "incompatible"
        : uncertainBy.length > 0
          ? "unknown"
          : "compatible",
    evidence_scope: "catalog_contract",
    runtime_readiness: "not_evaluated",
    command: `${site} ${command}`,
    requirements,
    contract: profile,
    rejected_by: rejectedBy,
    uncertain_by: uncertainBy,
  };
}

export function commandFeasibilityProfile(
  contract: CommandContract,
): CommandFeasibilityProfile {
  const platforms = declaredPlatforms(contract);
  return {
    operation_family: contract.operation.family,
    operation_family_source: contract.operation.source,
    operation_family_confidence: contract.operation.confidence,
    operator: contract.execution.operator,
    operator_source: contract.execution.operator_source,
    operator_confidence: contract.execution.operator_confidence,
    target_surface: contract.effect.target_surface,
    target_surface_source: contract.effect.target_surface_source,
    target_surface_confidence: contract.effect.target_surface_confidence,
    target_scope: contract.execution.target_scope,
    target_scope_source: contract.execution.operator_source,
    target_scope_confidence: contract.execution.operator_confidence,
    effect: contract.effect.operation_effect,
    effect_source: contract.effect.effect_source,
    effect_confidence: contract.effect.effect_confidence,
    interaction_impact: contract.execution.interaction_impact,
    coordinate_actuation: contract.execution.coordinate_actuation,
    ...(platforms ? { platforms } : {}),
  };
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

function inferExplicitSites(intent: string): string[] {
  const normalized = normalizeSiteText(intent);
  const nonProviderSiteIds = new Set([
    "browser",
    "compute",
    "operate",
    "auth",
    "repair",
    "core",
  ]);
  const sites = new Set([
    ...getAllAdapters().map((adapter) => adapter.name),
    ...listCoreDiscoverySites().map((site) => site.site),
  ]);
  const highConfidenceBareSites = new Set([
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
  const required = new Set<string>();
  for (const site of sites) {
    if (nonProviderSiteIds.has(site) || !highConfidenceBareSites.has(site)) {
      continue;
    }
    const phrase = normalizeSiteText(site);
    const explicitHandle = intent.includes(`@${site}`);
    const explicitUrl = new RegExp(
      `https?://[^\\s/]*${escapeRegex(site.replaceAll("-", ""))}`,
      "iu",
    ).test(intent.replaceAll("-", ""));
    if (
      explicitHandle ||
      explicitUrl ||
      (phrase && hasBoundedPhrase(normalized, phrase))
    ) {
      required.add(site);
    }
  }
  const canonicalPhrases: ReadonlyArray<readonly [string, string]> = [
    ["hacker news", "hackernews"],
    ["linux do", "linux-do"],
    ["little red book", "xiaohongshu"],
  ];
  for (const [phrase, site] of canonicalPhrases) {
    if (sites.has(site) && hasBoundedPhrase(normalized, phrase)) {
      required.add(site);
    }
  }
  for (const [alias, site] of SITE_ALIASES) {
    if (!sites.has(site)) continue;
    const escaped = escapeRegex(alias.normalize("NFKC").toLowerCase());
    const normalizedAlias = normalizeSiteText(alias);
    const distinctiveAlias = /[\u3400-\u9fff]/u.test(normalizedAlias)
      ? normalizedAlias.length >= 2
      : normalizedAlias.length >= 4;
    if (
      highConfidenceBareSites.has(site) &&
      distinctiveAlias &&
      hasBoundedPhrase(normalized, normalizedAlias)
    ) {
      required.add(site);
    }
    const explicitContext = new RegExp(
      `(?:\\b(?:on|from|via|through|using)\\s+${escaped}\\b|(?:在|从|通过|使用)\\s*${escaped})`,
      "iu",
    );
    if (explicitContext.test(intent)) required.add(site);
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
  task_text: string;
  requirements: CapabilityRequirements;
}

/** Separate task semantics from substrate constraints before lexical ranking. */
export function parseIntentCapabilityPlan(
  intent: string,
): IntentCapabilityPlan {
  const normalized = intent.normalize("NFKC");
  const requirements = inferCapabilityRequirements(normalized);
  const withoutBrowser = resolveTaskIntentFrame(normalized).without_browser;
  if (withoutBrowser) {
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
    requirements,
  };
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

function commandContract(
  site: string,
  command: string,
): CommandContract | undefined {
  const version = getRegistryVersion();
  if (cachedRegistryVersion !== version) {
    cachedRegistryVersion = version;
    contractCache = new Map();
  }
  const id = `${site}/${command}`;
  const cached = contractCache.get(id);
  if (cached !== undefined) return cached ?? undefined;

  const resolved = resolveCommand(site, command);
  const contract = resolved
    ? buildCommandContract({
        adapter: resolved.adapter,
        commandName: command,
        command: resolved.command,
      })
    : (() => {
        const core = getCoreDiscoveryCommand(site, command);
        return core ? buildCoreCommandContract({ command: core }) : undefined;
      })();
  contractCache.set(id, contract ?? null);
  return contract;
}

function declaredPlatforms(
  contract: CommandContract,
): NodeJS.Platform[] | undefined {
  const capability = contract.repair.minimum_capability ?? "";
  if (
    contract.identity.site === "macos" ||
    capability.startsWith("desktop-ax.")
  ) {
    return ["darwin"];
  }
  if (capability.startsWith("desktop-uia.")) return ["win32"];
  if (capability.startsWith("desktop-atspi.")) return ["linux"];
  return undefined;
}

function interactionRank(impact: InteractionImpact): number {
  switch (impact) {
    case "background":
      return 0;
    case "target-scoped":
      return 1;
    case "foreground":
      return 2;
  }
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
