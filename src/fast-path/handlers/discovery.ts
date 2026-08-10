/**
 * @owner   src/fast-path/handlers/discovery.ts
 * @does    Serve list/search/describe/repair from the generated manifest plus user-repaired adapters without booting Commander.
 * @needs   ../../discovery/search, ../../discovery/core-catalog, ../../discovery/macos-dynamic, ../../core/auth-contract, ../../engine/repair/plan, ../../output/error-map, ../manifest, ../render, js-yaml, node:fs
 * @feeds   src/fast-path.ts
 * @breaks  Sets process.exitCode for invalid args or empty searches; propagates unreadable manifest errors; skips malformed user-adapter YAML.
 * @invariants Fast-path search shares the canonical scorer and owns manifest-to-document and user-adapter-to-document projection; describe preserves explicit required, optional, or absent authentication truth.
 * @side-effects Writes CLI output through Io, reads ~/.unicli/adapters, and may set process.exitCode.
 * @perf    Keeps startup bounded by reading compact manifest data instead of loading adapters.
 * @concurrency No shared mutable state beyond process.exitCode.
 * @test    tests/unit/fast-path.test.ts, tests/unit/search.test.ts
 * @stability Public CLI fast-path discovery behavior.
 * @since   0.223.4
 */

import {
  buildRequiredUsage,
  searchDocuments,
  type CommandSearchDocument,
  type SearchRankingEvidence,
} from "../../discovery/search.js";
import {
  getCoreDiscoveryCommand,
  listCoreDiscoveryCommands,
  listCoreDiscoverySites,
  type CoreDiscoveryArg,
  type CoreDiscoveryCommand,
} from "../../discovery/core-catalog.js";
import {
  buildCoreCommandContract,
  buildManifestCommandContract,
} from "../../core/command-contract.js";
import {
  commandFeasibilityProfile,
  evaluateFeasibilityProfile,
} from "../../discovery/feasibility.js";
import {
  compileIntentPlan,
  type CapabilityRequirements,
} from "../../discovery/intent-plan.js";
import type {
  ExecutionOperator,
  OperationEffect,
  TargetSurface,
} from "../../types.js";
import {
  metadataAuthRequirement,
  metadataAuthSetupCommand,
  metadataHasOptionalAuth,
  metadataRequiresAuth,
} from "../../core/auth-contract.js";
import { classifyPersonalization } from "../../discovery/personalization.js";
import {
  buildMacosDynamicCommands,
  discoverMacosDynamicData,
  dynamicMacosDiscoveryEnabled,
} from "../../discovery/macos-dynamic.js";
import { buildRepairPlan, parseTargetArgs } from "../../engine/repair/plan.js";
import {
  resolveOperationAdapterPath,
  resolveOperationTargetSurface,
} from "../../engine/operation-policy.js";
import { emptySearchResultError } from "../../output/error-map.js";
import { detectFormat, format } from "../../output/formatter.js";
import {
  makeCtx,
  type AgentContext,
  type AgentError,
  type AgentNextAction,
} from "../../output/envelope.js";
import {
  formatDescribeError,
  formatDescribePayload,
  nearestDescribeNames,
  summarizeDescribePayload,
} from "../../output/describe.js";
import {
  manifestCommandUsesBrowser,
  readManifest,
  type Manifest,
} from "../manifest.js";
import type { ParsedArgv } from "../parsed-argv.js";
import { evaluateManifestOperationPolicy } from "../policy.js";
import { compileObjectivePlan } from "../../engine/objective/index.js";
import { buildDeliveryOperatorSpecTemplate } from "../../engine/delivery/spec.js";
import {
  argsToJsonSchema,
  buildChannels,
  buildExample,
  emit,
  emitError,
  type Io,
  summarizeArgs,
} from "../render.js";

const EXECUTION_OPERATORS = new Set<ExecutionOperator>([
  "structured-api",
  "browser-protocol",
  "native-cli",
  "browser-semantic",
  "desktop-accessibility",
  "visual-observation",
  "visual-coordinate",
  "local-runtime",
]);
const TARGET_SURFACES = new Set<TargetSurface>([
  "web",
  "desktop",
  "system",
  "mobile",
]);
const OPERATION_EFFECTS = new Set<OperationEffect>([
  "read",
  "download_file",
  "send_message",
  "publish_content",
  "account_state",
  "remote_transform",
  "remote_resource",
  "service_state",
  "local_app",
  "local_file",
  "destructive",
  "unknown_write",
]);
const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>([
  "darwin",
  "win32",
  "linux",
]);

export function handleList(parsed: ParsedArgv, io: Io): boolean {
  const startedAt = Date.now();
  let siteFilter: string | undefined;
  let typeFilter: string | undefined;
  let categoryFilter: string | undefined;
  let personalizedOnly = false;

  for (let i = 0; i < parsed.rest.length; i += 1) {
    const arg = parsed.rest[i];
    if (arg === "--site") {
      siteFilter = parsed.rest[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--site=")) {
      siteFilter = arg.slice("--site=".length);
      continue;
    }
    if (arg === "--type") {
      typeFilter = parsed.rest[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--type=")) {
      typeFilter = arg.slice("--type=".length);
      continue;
    }
    if (arg === "--category") {
      categoryFilter = parsed.rest[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--category=")) {
      categoryFilter = arg.slice("--category=".length);
      continue;
    }
    if (arg === "--personalized") {
      personalizedOnly = true;
      continue;
    }
    return false;
  }

  const manifest = readManifest();
  const rows = Object.entries(manifest.sites)
    .flatMap(([site, info]) =>
      info.commands.map((command) => {
        const category = info.category ?? "other";
        const strategy = command.strategy ?? "public";
        const tags: string[] = [];
        if (
          metadataRequiresAuth(
            strategy,
            command.capabilities,
            command.auth_requirement,
          )
        ) {
          tags.push("[auth]");
        } else if (metadataHasOptionalAuth(command.auth_requirement)) {
          tags.push("[auth optional]");
        }
        if (command.quarantined === true) tags.push("[quarantined]");
        const authRequirement = metadataAuthRequirement(
          strategy,
          command.capabilities,
          command.auth_requirement,
        );
        const personalization = classifyPersonalization({
          command: command.name,
          description: command.description,
          category,
          auth: authRequirement,
        });
        return {
          site,
          command: command.name,
          description: command.description ?? "",
          category,
          type: command.type ?? "web-api",
          auth: tags.join(" "),
          personalization: personalization ?? "",
        };
      }),
    )
    .concat(coreListRows())
    .concat(dynamicListRows())
    .filter((row) => !siteFilter || row.site.includes(siteFilter))
    .filter((row) => !categoryFilter || row.category === categoryFilter)
    .filter((row) => !typeFilter || row.type === typeFilter)
    .filter((row) => !personalizedOnly || Boolean(row.personalization))
    .sort(
      (a, b) =>
        a.site.localeCompare(b.site) || a.command.localeCompare(b.command),
    );

  emit(
    io,
    rows,
    [
      "site",
      "command",
      "description",
      "personalization",
      "category",
      "type",
      "auth",
    ],
    parsed.format,
    "core.list",
    startedAt,
  );
  return true;
}

function dynamicListRows(): Array<{
  site: string;
  command: string;
  description: string;
  category: string;
  type: string;
  auth: string;
  personalization: string;
}> {
  if (!dynamicMacosDiscoveryEnabled()) return [];

  return Object.values(
    buildMacosDynamicCommands(discoverMacosDynamicData()),
  ).map((command) => ({
    site: "macos",
    command: command.name,
    description: command.description ?? "",
    category: "desktop",
    type: "desktop",
    auth: "",
    personalization: "",
  }));
}

function coreListRows(): Array<{
  site: string;
  command: string;
  description: string;
  category: string;
  type: string;
  auth: string;
  personalization: string;
}> {
  return listCoreDiscoveryCommands().map((command) => ({
    site: command.site,
    command: command.command,
    description: command.description,
    category: command.category,
    type: command.type,
    auth: "",
    personalization: "",
  }));
}

export function handleSearch(parsed: ParsedArgv, io: Io): boolean {
  const startedAt = Date.now();
  let limit = 8;
  let category: string | undefined;
  let operator: ExecutionOperator | undefined;
  let surface: TargetSurface | undefined;
  let effect: OperationEffect | undefined;
  let platform: NodeJS.Platform | undefined = process.platform;
  let personalizedOnly = false;
  const queryParts: string[] = [];

  for (let i = 0; i < parsed.rest.length; i += 1) {
    const arg = parsed.rest[i];
    if (arg === "-h" || arg === "--help") return false;
    if (arg === "-n" || arg === "--limit") {
      const value = parsed.rest[i + 1];
      if (!value || !/^[1-9]\d*$/.test(value)) return false;
      limit = Number(value);
      i += 1;
      continue;
    }
    if (arg.startsWith("--limit=")) {
      const value = arg.slice("--limit=".length);
      if (!/^[1-9]\d*$/.test(value)) return false;
      limit = Number(value);
      continue;
    }
    if (arg === "--category") {
      category = parsed.rest[i + 1];
      if (!category) return false;
      i += 1;
      continue;
    }
    if (arg.startsWith("--category=")) {
      category = arg.slice("--category=".length);
      continue;
    }
    if (arg === "--operator") {
      const value = parsed.rest[i + 1] as ExecutionOperator | undefined;
      if (!value || !EXECUTION_OPERATORS.has(value)) return false;
      operator = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--operator=")) {
      const value = arg.slice("--operator=".length) as ExecutionOperator;
      if (!EXECUTION_OPERATORS.has(value)) return false;
      operator = value;
      continue;
    }
    if (arg === "--surface") {
      const value = parsed.rest[i + 1] as TargetSurface | undefined;
      if (!value || !TARGET_SURFACES.has(value)) return false;
      surface = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--surface=")) {
      const value = arg.slice("--surface=".length) as TargetSurface;
      if (!TARGET_SURFACES.has(value)) return false;
      surface = value;
      continue;
    }
    if (arg === "--effect") {
      const value = parsed.rest[i + 1] as OperationEffect | undefined;
      if (!value || !OPERATION_EFFECTS.has(value)) return false;
      effect = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--effect=")) {
      const value = arg.slice("--effect=".length) as OperationEffect;
      if (!OPERATION_EFFECTS.has(value)) return false;
      effect = value;
      continue;
    }
    if (arg === "--platform") {
      const value = parsed.rest[i + 1] as NodeJS.Platform | undefined;
      if (!value || !SUPPORTED_PLATFORMS.has(value)) return false;
      platform = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--platform=")) {
      const value = arg.slice("--platform=".length) as NodeJS.Platform;
      if (!SUPPORTED_PLATFORMS.has(value)) return false;
      platform = value;
      continue;
    }
    if (arg === "--personalized") {
      personalizedOnly = true;
      continue;
    }
    if (arg.startsWith("-")) return false;
    queryParts.push(arg);
  }

  const query = queryParts.join(" ");
  if (!query && !category) {
    io.stderr(
      "Usage: unicli search <query>  or  unicli search --category <cat>",
    );
    process.exitCode = 2;
    return true;
  }

  const effectiveQuery = [category, query].filter(Boolean).join(" ");
  const requirements: CapabilityRequirements = {
    ...(operator ? { operator } : {}),
    ...(surface ? { target_surface: surface } : {}),
    ...(effect ? { effect } : {}),
    ...(platform ? { platform } : {}),
    ...(operator
      ? { allow_coordinate_actuation: operator === "visual-coordinate" }
      : {}),
  };
  const results = searchDocuments(
    manifestSearchDocuments(readManifest()),
    query,
    limit,
    { category, personalized: personalizedOnly, requirements },
  );
  if (results.length === 0) {
    emitError(
      io,
      emptySearchResultError(effectiveQuery, query.replace(/"/g, "").trim()),
      parsed.format,
      "core.search",
      startedAt,
      66, // EX_EMPTY
    );
    return true;
  }

  const rows = results.map((result) => ({
    command: `${result.site} ${result.command}`,
    description: result.description || `${result.command} for ${result.site}`,
    score: result.score,
    category: result.category,
    ...(result.feasibility
      ? {
          operator: result.feasibility.operator,
          operation_family: result.feasibility.operation_family,
          effect: result.feasibility.effect,
          target_surface: result.feasibility.target_surface,
          target_scope: result.feasibility.target_scope,
          evidence_scope: "catalog_contract",
          runtime_readiness: "not_evaluated",
        }
      : {}),
    ranking: result.ranking,
    usage: result.usage,
    inspect: `unicli describe ${result.site} ${result.command}`,
    auth: result.auth,
    ...(result.auth_setup ? { auth_setup: result.auth_setup } : {}),
    ...(result.personalization
      ? { personalization: result.personalization }
      : {}),
  }));

  emit(
    io,
    rows,
    [
      "command",
      "description",
      "personalization",
      "auth",
      "score",
      "usage",
      "inspect",
    ],
    parsed.format,
    "core.search",
    startedAt,
  );
  return true;
}

export function manifestSearchDocuments(
  manifest: Manifest,
): CommandSearchDocument[] {
  const documents: CommandSearchDocument[] = [];
  const seen = new Set<string>();

  for (const [site, info] of Object.entries(manifest.sites)) {
    for (const command of info.commands) {
      const id = `${site}/${command.name}`;
      seen.add(id);
      const auth = metadataAuthRequirement(
        command.strategy,
        command.capabilities,
        command.auth_requirement,
      );
      const authSetup = metadataAuthSetupCommand(
        site,
        command.strategy,
        command.capabilities,
        command.auth_requirement,
      );
      const personalization = classifyPersonalization({
        command: command.name,
        description: command.description,
        category: info.category,
        auth,
      });
      documents.push({
        site,
        command: command.name,
        description: command.description ?? "",
        category: info.category,
        auth,
        ...(authSetup ? { auth_setup: authSetup } : {}),
        ...(personalization ? { personalization } : {}),
        usage: buildRequiredUsage(site, command.name, command.args),
        feasibility: commandFeasibilityProfile(
          buildManifestCommandContract({
            site,
            commandName: command.name,
            category: info.category,
            adapterType: command.type ?? "web-api",
            command,
          }),
        ),
      });
    }
  }

  for (const command of listCoreDiscoveryCommands()) {
    const id = `${command.site}/${command.command}`;
    if (seen.has(id)) continue;
    seen.add(id);
    documents.push({
      site: command.site,
      command: command.command,
      description: command.description,
      category: command.category,
      auth: "none",
      ...(command.channels?.shell ? { usage: command.channels.shell } : {}),
      feasibility: commandFeasibilityProfile(
        buildCoreCommandContract({ command }),
      ),
    });
  }

  return documents;
}

interface FastDoMatch {
  site: string;
  command: string;
  score: number;
  description: string;
  category: string;
  ranking: SearchRankingEvidence;
  invocation: string;
  operator: ReturnType<typeof buildManifestCommandContract>["execution"];
  args_schema?: Record<string, unknown>;
  example_stdin?: Record<string, unknown>;
  feasibility: ReturnType<typeof evaluateFeasibilityProfile>;
  adapter_path?: string;
  adapter_type: string;
  target_surface?: TargetSurface;
  uses_browser: boolean;
}

/** Manifest-only one-shot intent plan; complex objectives fall through. */
export function handleDo(parsed: ParsedArgv, io: Io): boolean {
  const startedAt = Date.now();
  let top = 3;
  let includeSchema = true;
  const intentParts: string[] = [];
  for (let index = 0; index < parsed.rest.length; index += 1) {
    const argument = parsed.rest[index];
    if (argument === "-h" || argument === "--help") return false;
    if (argument === "-n" || argument === "--top") {
      const value = parsed.rest[index + 1];
      if (!value || !/^[1-9]\d*$/.test(value) || Number(value) > 25) {
        return false;
      }
      top = Number(value);
      index += 1;
      continue;
    }
    if (argument.startsWith("--top=")) {
      const value = argument.slice("--top=".length);
      if (!/^[1-9]\d*$/.test(value) || Number(value) > 25) return false;
      top = Number(value);
      continue;
    }
    if (argument === "--no-schema") {
      includeSchema = false;
      continue;
    }
    // Explicit substrate constraints and blocked-candidate diagnostics remain
    // at the full planner boundary.
    if (argument.startsWith("-")) return false;
    intentParts.push(argument);
  }

  const intent = intentParts.join(" ").trim();
  if (!intent || compileObjectivePlan(intent)) return false;
  const intentPlan = compileIntentPlan(intent);
  const requirements: CapabilityRequirements = {
    ...intentPlan.requirements,
    platform: process.platform,
    allow_coordinate_actuation:
      intentPlan.requirements.allow_coordinate_actuation ?? false,
  };
  const manifest = readManifest();
  const results = searchDocuments(
    manifestSearchDocuments(manifest),
    intentPlan.task_text,
    top,
    { requirements },
  ).filter((result) => result.score > 0);
  if (results.length === 0) return false;

  const matches = results
    .map((result) =>
      buildFastDoMatch(manifest, result, requirements, includeSchema),
    )
    .filter((match): match is FastDoMatch => match !== undefined);
  const best = matches[0];
  if (!best) return false;

  const deliverySpecTemplate = buildDeliveryOperatorSpecTemplate({
    intent,
    site: best.site,
    command: best.command,
    description: best.description,
    args: best.example_stdin,
    adapter_path: best.adapter_path,
    adapter_type: best.adapter_type,
    target_surface: best.target_surface,
    uses_browser: best.uses_browser,
  });
  const data = {
    intent,
    match: {
      site: best.site,
      command: best.command,
      score: best.score,
      category: best.category,
      description: best.description,
      invocation: best.invocation,
      operator: best.operator,
      ranking: best.ranking,
    },
    candidates: matches.map(stripFastDoInternalFields),
    blocked_candidates: [],
    routing_policy: {
      selection:
        "BM25/intent ranking intersected with operation, operator, target, effect, platform, and interaction constraints before top-k selection",
      requirements,
      provider_recovery:
        "provider failures require repair or explicit replanning; execution does not cross operators",
    },
    delivery_spec_template: deliverySpecTemplate,
  };
  const ctx: AgentContext = {
    command: "core.do",
    duration_ms: Date.now() - startedAt,
    surface: "web",
    next_actions: fastDoNextActions(intent, best, matches),
  };
  const fmt = detectFormat(parsed.format);
  const output =
    fmt === "md"
      ? {
          intent,
          selected_command: `${best.site} ${best.command}`,
          invocation: best.invocation,
          description: best.description,
          score: best.score,
          ranking_signals: best.ranking.signals,
          operator: best.operator.operator,
          operation_family: best.feasibility.contract?.operation_family,
          provider: best.operator.provider,
          target_scope: best.operator.target_scope,
          interaction_impact: best.operator.interaction_impact,
          contract_compatibility: best.feasibility.compatibility,
          runtime_readiness: "not_evaluated",
          requirements,
          repair_command: `unicli describe ${best.site} ${best.command}`,
          alternatives: matches
            .slice(1)
            .map(
              (match) =>
                `${match.site} ${match.command} (${match.score}, ${match.operator.operator})`,
            ),
        }
      : data;
  io.stdout(format(output, undefined, fmt, ctx));
  return true;
}

function buildFastDoMatch(
  manifest: Manifest,
  result: ReturnType<typeof searchDocuments>[number],
  requirements: CapabilityRequirements,
  includeSchema: boolean,
): FastDoMatch | undefined {
  const info = manifest.sites[result.site];
  const manifestCommand = info?.commands.find(
    (candidate) => candidate.name === result.command,
  );
  if (manifestCommand) {
    const adapterType =
      manifestCommand.type ?? info?.commands[0]?.type ?? "web-api";
    const contract = buildManifestCommandContract({
      site: result.site,
      commandName: result.command,
      category: info?.category,
      adapterType,
      command: manifestCommand,
    });
    const args = manifestCommand.args ?? [];
    const profile = commandFeasibilityProfile(contract);
    return {
      site: result.site,
      command: result.command,
      score: Math.round(result.score * 10_000) / 10_000,
      description: result.description,
      category: result.category,
      ranking: result.ranking,
      invocation: buildChannels(result.site, result.command, args).shell,
      operator: contract.execution,
      ...(includeSchema
        ? {
            args_schema: argsToJsonSchema(args),
            example_stdin: buildExample(args),
          }
        : {}),
      feasibility: evaluateFeasibilityProfile(
        result.site,
        result.command,
        profile,
        requirements,
      ),
      adapter_path: manifestCommand.adapter_path,
      adapter_type: adapterType,
      target_surface: manifestCommand.target_surface,
      uses_browser: manifestCommandUsesBrowser(manifestCommand, adapterType),
    };
  }

  const coreCommand = getCoreDiscoveryCommand(result.site, result.command);
  if (!coreCommand) return undefined;
  const contract = buildCoreCommandContract({ command: coreCommand });
  const args = [...(coreCommand.args ?? [])];
  return {
    site: result.site,
    command: result.command,
    score: Math.round(result.score * 10_000) / 10_000,
    description: result.description,
    category: result.category,
    ranking: result.ranking,
    invocation:
      coreCommand.channels?.shell ??
      buildChannels(result.site, result.command, args).shell,
    operator: contract.execution,
    ...(includeSchema
      ? {
          args_schema: argsToJsonSchema(args),
          example_stdin: buildExample(args),
        }
      : {}),
    feasibility: evaluateFeasibilityProfile(
      result.site,
      result.command,
      commandFeasibilityProfile(contract),
      requirements,
    ),
    adapter_type: coreCommand.type,
    target_surface: contract.effect.target_surface,
    uses_browser:
      contract.execution.operator === "browser-protocol" ||
      contract.execution.operator === "browser-semantic",
  };
}

function stripFastDoInternalFields(
  match: FastDoMatch,
): Record<string, unknown> {
  const {
    adapter_path: _adapterPath,
    adapter_type: _adapterType,
    target_surface: _targetSurface,
    uses_browser: _usesBrowser,
    ...publicMatch
  } = match;
  return publicMatch;
}

function fastDoNextActions(
  intent: string,
  best: FastDoMatch,
  matches: FastDoMatch[],
): AgentNextAction[] {
  const actions: AgentNextAction[] = [
    {
      command: "unicli delivery run <delivery-spec.json>",
      description:
        "Execute the included delivery_spec_template before claiming success",
    },
    {
      command: best.invocation,
      description: `Invoke the top-scored match (${best.score})`,
    },
    {
      command: `unicli describe ${best.site} ${best.command}`,
      description: "Read the command schema, channels, and example payload",
    },
  ];
  const runner = matches[1];
  if (runner && runner.score >= best.score * 0.7) {
    actions.push({
      command: runner.invocation,
      description: `Runner-up (score ${runner.score}) — consider if top match misreads intent`,
    });
  }
  actions.push({
    command: `unicli search "${intent}"`,
    description: "List all matching candidates with scores",
  });
  return actions;
}

export function handleDescribe(parsed: ParsedArgv, io: Io): boolean {
  const startedAt = Date.now();
  const manifest = readManifest();
  let full = false;
  const positionals: string[] = [];
  for (const argument of parsed.rest) {
    if (argument === "--full") {
      full = true;
      continue;
    }
    if (argument === "-h" || argument === "--help") return false;
    if (argument.startsWith("-")) return false;
    positionals.push(argument);
  }
  if (positionals.length > 2) return false;
  const [site, cmdName] = positionals;

  if (!site) {
    const adapterSites = Object.entries(manifest.sites).map(([name, info]) => {
      const personalizedCommands = info.commands.filter((command) => {
        const auth = metadataAuthRequirement(
          command.strategy,
          command.capabilities,
          command.auth_requirement,
        );
        return Boolean(
          classifyPersonalization({
            command: command.name,
            description: command.description,
            category: info.category,
            auth,
          }),
        );
      }).length;
      return {
        name,
        display_name: name,
        type: info.commands[0]?.type ?? "web-api",
        strategy: info.commands[0]?.strategy ?? "public",
        commands_count: info.commands.length,
        personalized_commands_count: personalizedCommands,
        description: "",
      };
    });
    const sites = adapterSites
      .concat(
        listCoreDiscoverySites().map((coreSite) => ({
          name: coreSite.site,
          display_name: coreSite.site,
          type: coreSite.type,
          strategy: "public",
          commands_count: coreSite.commands.length,
          personalized_commands_count: 0,
          description: "Core Uni-CLI command group",
        })),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    emitDescribePayload(
      io,
      { sites, total: sites.length },
      parsed,
      startedAt,
      full,
    );
    return true;
  }

  const info = manifest.sites[site];
  if (!info) {
    const coreSite = listCoreDiscoverySites().find(
      (candidate) => candidate.site === site,
    );
    if (coreSite && !cmdName) {
      emitDescribePayload(
        io,
        {
          site,
          display_name: site,
          type: coreSite.type,
          strategy: "public",
          commands: coreSite.commands.map((command) => ({
            name: command.command,
            description: command.description,
            quarantined: false,
            strategy: "public",
            auth: false,
            browser: command.type === "browser",
            args: summarizeArgs([...(command.args ?? [])]),
          })),
        },
        parsed,
        startedAt,
        full,
      );
      return true;
    }
    if (cmdName) {
      const coreCommand = getCoreDiscoveryCommand(site, cmdName);
      if (coreCommand) {
        emitDescribePayload(
          io,
          describeCoreCommand(coreCommand),
          parsed,
          startedAt,
          full,
        );
        return true;
      }
    }
    const alternatives = nearestDescribeNames(site, [
      ...Object.keys(manifest.sites),
      ...listCoreDiscoverySites().map((candidate) => candidate.site),
    ]).map((candidate) => {
      const candidateCommands = [
        ...(manifest.sites[candidate]?.commands.map(
          (command) => command.name,
        ) ?? []),
        ...(listCoreDiscoverySites()
          .find((core) => core.site === candidate)
          ?.commands.map((command) => command.command) ?? []),
      ];
      return `unicli describe ${candidate}${cmdName && candidateCommands.includes(cmdName) ? ` ${cmdName}` : ""}`;
    });
    emitDescribeFailure(
      io,
      {
        code: "not_found",
        message: `unknown site: ${site}`,
        suggestion:
          alternatives.length > 0
            ? "Use the closest registered site below."
            : "Run `unicli search <intent>` to resolve a registered command.",
        retryable: false,
        alternatives:
          alternatives.length > 0 ? alternatives : ["unicli search <intent>"],
      },
      parsed,
      startedAt,
      64,
    );
    return true;
  }

  if (!cmdName) {
    const commands = info.commands.map((command) => {
      const strategy = command.strategy ?? "public";
      const auth = metadataAuthRequirement(
        strategy,
        command.capabilities,
        command.auth_requirement,
      );
      const authSetup = metadataAuthSetupCommand(
        site,
        strategy,
        command.capabilities,
        command.auth_requirement,
      );
      const authOptional = metadataHasOptionalAuth(command.auth_requirement);
      const personalization = classifyPersonalization({
        command: command.name,
        description: command.description,
        category: info.category,
        auth,
      });
      return {
        name: command.name,
        command: `unicli ${site} ${command.name}`,
        inspect: `unicli describe ${site} ${command.name}`,
        description: command.description ?? "",
        quarantined: command.quarantined === true,
        strategy,
        auth: auth === "required",
        ...(authOptional ? { auth_optional: true } : {}),
        ...(authSetup ? { auth_setup: authSetup } : {}),
        ...(personalization ? { personalization } : {}),
        browser: manifestCommandUsesBrowser(
          command,
          command.type ?? info.commands[0]?.type ?? "web-api",
        ),
        args: summarizeArgs(command.args),
      };
    });
    emitDescribePayload(
      io,
      {
        site,
        display_name: site,
        type: info.commands[0]?.type ?? "web-api",
        strategy: info.commands[0]?.strategy ?? "public",
        personalized_commands_count: commands.filter(
          (command) => command.personalization,
        ).length,
        personalization_families: [
          ...new Set(
            commands.map((command) => command.personalization).filter(Boolean),
          ),
        ],
        commands,
      },
      parsed,
      startedAt,
      full,
    );
    return true;
  }

  const command = info.commands.find((candidate) => candidate.name === cmdName);
  if (!command) {
    const alternatives = nearestDescribeNames(
      cmdName,
      info.commands.map((candidate) => candidate.name),
    ).map((candidate) => `unicli describe ${site} ${candidate}`);
    emitDescribeFailure(
      io,
      {
        code: "not_found",
        message: `unknown command: ${site} ${cmdName}`,
        suggestion:
          alternatives.length > 0
            ? "Use the closest command below."
            : `Run \`unicli describe ${site}\` to inspect this site's commands.`,
        retryable: false,
        alternatives:
          alternatives.length > 0 ? alternatives : [`unicli describe ${site}`],
      },
      parsed,
      startedAt,
      64,
    );
    return true;
  }
  const adapterType = command.type ?? info.commands[0]?.type ?? "web-api";
  const targetSurface = resolveOperationTargetSurface({
    adapterType,
    targetSurface: command.target_surface,
  });
  const adapterPath = resolveOperationAdapterPath(
    site,
    cmdName,
    command.adapter_path,
  );
  const operationPolicy = evaluateManifestOperationPolicy({
    parsed,
    io,
    site,
    commandName: cmdName,
    command,
    adapterType,
    targetSurface,
    adapterPath,
    startedAt,
  });
  if (!operationPolicy) return true;

  const strategy = command.strategy ?? "public";
  const authSetup = metadataAuthSetupCommand(
    site,
    strategy,
    command.capabilities,
    command.auth_requirement,
  );
  const authOptional = metadataHasOptionalAuth(command.auth_requirement);
  const auth = metadataAuthRequirement(
    strategy,
    command.capabilities,
    command.auth_requirement,
  );
  const personalization = classifyPersonalization({
    command: cmdName,
    description: command.description,
    category: info.category,
    auth,
  });
  const contract = buildManifestCommandContract({
    site,
    commandName: cmdName,
    category: info.category,
    adapterType,
    command,
  });

  emitDescribePayload(
    io,
    {
      command: `unicli ${site} ${cmdName}`,
      description: command.description ?? "",
      quarantined: command.quarantined === true,
      strategy,
      auth: metadataRequiresAuth(
        strategy,
        command.capabilities,
        command.auth_requirement,
      ),
      ...(authOptional ? { auth_optional: true } : {}),
      ...(authSetup ? { auth_setup: authSetup } : {}),
      ...(personalization ? { personalization } : {}),
      browser: manifestCommandUsesBrowser(command, adapterType),
      target_surface: targetSurface,
      adapter_path: adapterPath,
      operation_policy: operationPolicy,
      args_schema: argsToJsonSchema(command.args ?? []),
      example_stdin: buildExample(command.args ?? []),
      channels: buildChannels(site, cmdName, command.args ?? []),
      contract,
      next_actions: [
        {
          command: `unicli ${site} ${cmdName} --dry-run`,
          description: "Preview the resolved argument bag and pipeline plan",
        },
        {
          command: `unicli ${site} ${cmdName}`,
          description: "Run the command (shell channel)",
          params: {
            note: {
              description:
                "For payloads with quotes/emoji/JSON, pipe stdin-JSON instead.",
            },
          },
        },
        {
          command: `unicli repair ${site} ${cmdName}`,
          description: "If the command fails due to upstream drift",
        },
      ],
    },
    parsed,
    startedAt,
    full,
  );
  return true;
}

function emitDescribePayload(
  io: Io,
  payload: Record<string, unknown>,
  parsed: ParsedArgv,
  startedAt: number,
  full: boolean,
): void {
  const ctx = makeCtx("core.describe", startedAt);
  ctx.duration_ms = Date.now() - startedAt;
  const fmt = detectFormat(parsed.format);
  io.stdout(
    formatDescribePayload(
      full ? payload : summarizeDescribePayload(payload),
      fmt,
      ctx,
    ),
  );
}

function emitDescribeFailure(
  io: Io,
  error: AgentError,
  parsed: ParsedArgv,
  startedAt: number,
  exitCode: number,
): void {
  process.exitCode = exitCode;
  const ctx = makeCtx("core.describe", startedAt);
  ctx.duration_ms = Date.now() - startedAt;
  io.stderr(formatDescribeError(error, detectFormat(parsed.format), ctx));
}

function describeCoreCommand(
  command: CoreDiscoveryCommand,
): Record<string, unknown> {
  const args = [...(command.args ?? [])] as CoreDiscoveryArg[];
  const contract = buildCoreCommandContract({ command });
  return {
    command: `unicli ${command.site} ${command.command}`,
    description: command.description,
    quarantined: false,
    strategy: "public",
    auth: false,
    browser: command.type === "browser",
    target_surface: contract.effect.target_surface,
    ...(contract.identity.source_path
      ? { source_path: contract.identity.source_path }
      : {}),
    args_schema: argsToJsonSchema(args),
    example_stdin: buildExample(args),
    channels:
      command.channels ?? buildChannels(command.site, command.command, args),
    next_actions: [
      {
        command: `unicli ${command.site} ${command.command} --help`,
        description: "Inspect the Commander help for exact shell flags",
      },
      {
        command: `unicli ${command.site} ${command.command}`,
        description: "Run the core command",
      },
    ],
    contract,
  };
}

export function handleRepair(parsed: ParsedArgv, io: Io): boolean {
  const startedAt = Date.now();
  let dryRun = parsed.dryRun;
  let timeout = 90;
  let targetArgsRaw: string | undefined;
  const positionals: string[] = [];

  for (let i = 0; i < parsed.rest.length; i += 1) {
    const arg = parsed.rest[i];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--timeout") {
      timeout = parseInt(parsed.rest[i + 1] ?? "", 10) || 90;
      i += 1;
      continue;
    }
    if (arg.startsWith("--timeout=")) {
      timeout = parseInt(arg.slice("--timeout=".length), 10) || 90;
      continue;
    }
    if (arg === "--target-args") {
      targetArgsRaw = parsed.rest[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--target-args=")) {
      targetArgsRaw = arg.slice("--target-args=".length);
      continue;
    }
    if (arg.startsWith("-")) return false;
    positionals.push(arg);
  }

  if (!dryRun) return false;

  const [site, command] = positionals;
  if (!site || !command) return false;
  const manifest = readManifest();
  const manifestCommand = manifest.sites[site]?.commands.find(
    (candidate) => candidate.name === command,
  );
  if (!manifestCommand) return false;
  const adapterPath = resolveOperationAdapterPath(
    site,
    command,
    manifestCommand.adapter_path,
  );

  let plan;
  try {
    plan = buildRepairPlan({
      site,
      command,
      adapterPath,
      targetArgs: parseTargetArgs(targetArgsRaw),
      timeoutMs: timeout * 1_000,
    });
  } catch {
    return false;
  }

  emit(io, { ...plan }, undefined, parsed.format, "repair.plan", startedAt);
  return true;
}
