/**
 * @owner       src::core::command-contract
 * @does        Projects adapter and core registry commands into one agent-native command contract.
 * @needs       AdapterManifest, AdapterCommand, CoreDiscoveryCommand, operation policy, authentication, and retrieval metadata
 * @feeds       describe, MCP, agent packs, benchmark generation, and repair tooling
 * @breaks      Missing source paths, schemas, safety metadata, authentication truth, retrieval metadata, or repair metadata misleads every discovery surface.
 * @invariants  In-process and generated-manifest projections preserve the same strategy, authentication requirement, retrieval contract, policy, and repair path.
 * @side-effects None.
 * @perf        O(arguments + capabilities) per command.
 * @concurrency Pure projection functions are safe for concurrent callers.
 * @test        tests/unit/command-contract.test.ts, tests/unit/fast-path.test.ts
 * @stability   stable
 * @since       2026-06-18
 */

import {
  commandRequiresAuth,
  commandAuthSetupCommand,
  commandHasOptionalAuth,
  commandStrategy,
  commandUsesBrowser,
} from "../registry.js";
import {
  evaluateOperationPolicy,
  resolveOperationTargetSurface,
  type OperationEffect,
  type OperationRisk,
} from "../engine/operation-policy.js";
import { inferArtifactValidators } from "../engine/artifact-validation.js";
import {
  resolveCommandOperator,
  type CommandOperatorProfile,
} from "./operator-model.js";
import {
  resolveOperationFamily,
  type OperationFamilyProfile,
} from "./operation-family.js";
import type {
  AdapterArg,
  AdapterCommand,
  AdapterManifest,
  CommandAvailability,
  OutputSchema,
  RetrievalMetadata,
  Strategy,
  TargetSurface,
} from "../types.js";
import type {
  CoreDiscoveryArg,
  CoreDiscoveryCommand,
} from "../discovery/core-catalog.js";

export type CommandSafetyClass = "read" | "auth_read" | "write" | "destructive";

export interface CommandContractIdentity {
  site: string;
  command: string;
  display_name: string;
  category?: string;
  tags: string[];
  source_path?: string;
  source_tier?: "packaged" | "user" | "runtime";
  shadowed_source_path?: string;
}

export interface CommandContractInputProperty {
  type:
    | "string"
    | "array"
    | "integer"
    | "number"
    | "boolean"
    | ["number", "null"]
    | ["string", "integer"];
  items?: { type: "string" };
  description?: string;
  default?: unknown;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: AdapterArg["format"];
  "x-unicli-kind"?: AdapterArg["x-unicli-kind"];
  "x-unicli-accepts"?: AdapterArg["x-unicli-accepts"];
  "x-unicli-uri-origins"?: AdapterArg["x-unicli-uri-origins"];
  "x-unicli-uri-path-pattern"?: AdapterArg["x-unicli-uri-path-pattern"];
}

export interface CommandContractInputSchema {
  $schema: "https://json-schema.org/draft/2020-12/schema";
  type: "object";
  properties: Record<string, CommandContractInputProperty>;
  required: string[];
  additionalProperties: false;
}

export interface CommandContractSchemas {
  input: CommandContractInputSchema;
  output?: Record<string, unknown> | string;
}

export interface CommandContractEffect {
  operation_effect: OperationEffect;
  effect_source: "declared" | "heuristic" | "default";
  effect_confidence: "high" | "medium" | "low";
  risk: OperationRisk;
  safety_class: CommandSafetyClass;
  target_surface: TargetSurface;
  target_surface_source: "declared" | "adapter_type";
  target_surface_confidence: "high" | "low";
  browser: boolean;
  browser_requirement: "never" | "required" | "conditional";
  read_only: boolean;
  idempotency: AdapterCommand["idempotency"];
  idempotent: boolean;
  open_world: boolean;
  paginated: boolean;
}

export interface CommandContractAuth {
  strategy: Strategy | "public";
  required: boolean;
  optional?: boolean;
  setup_command?: string;
}

export interface CommandContractAvailability {
  required_environment: string[];
  discovery: "always" | "configured";
  setup_url?: string;
  runtime_state: "not_evaluated";
}

export interface CommandContractGovernance {
  dimensions: ReturnType<
    typeof evaluateOperationPolicy
  >["capability_scope"]["dimensions"];
  resources: ReturnType<
    typeof evaluateOperationPolicy
  >["capability_scope"]["resources"];
  resource_summary: string[];
}

export interface CommandContractEval {
  fixture_status: "unknown" | "present" | "missing";
  live_status: "unknown" | "passing" | "failing" | "quarantined";
  health_status: "unknown" | "healthy" | "unhealthy" | "quarantined";
}

export interface CommandContractRepair {
  source_kind: "adapter" | "core";
  source_path?: string;
  adapter_path?: string;
  repair_command?: string;
  quarantined: boolean;
  quarantine_reason?: string;
  minimum_capability?: string;
}

export interface CommandContractArtifacts {
  produces_files: boolean;
  validators: string[];
}

export interface CommandContract {
  schema_version: "command-contract.v1";
  identity: CommandContractIdentity;
  description: string;
  schemas: CommandContractSchemas;
  execution: CommandOperatorProfile;
  effect: CommandContractEffect;
  auth: CommandContractAuth;
  availability?: CommandContractAvailability;
  governance: CommandContractGovernance;
  eval: CommandContractEval;
  repair: CommandContractRepair;
  artifacts: CommandContractArtifacts;
  operation: OperationFamilyProfile;
  retrieval?: RetrievalMetadata;
}

export type CommandContractLintSeverity = "error" | "warning";

export interface CommandContractLintIssue {
  code:
    | "missing_source_path"
    | "missing_input_schema"
    | "missing_target_surface"
    | "missing_repair_command";
  severity: CommandContractLintSeverity;
  message: string;
}

export interface BuildCommandContractInput {
  adapter: AdapterManifest;
  commandName: string;
  command: AdapterCommand;
}

export interface BuildCoreCommandContractInput {
  command: CoreDiscoveryCommand;
}

export interface BuildManifestCommandContractInput {
  site: string;
  commandName: string;
  category?: string;
  adapterType: string;
  command: {
    description?: string;
    strategy?: string;
    domain?: string;
    base?: string;
    browser?: boolean;
    browserSession?: AdapterCommand["browserSession"];
    quarantined?: boolean;
    args?: AdapterArg[];
    capabilities?: string[];
    auth_requirement?: AdapterCommand["auth_requirement"];
    availability?: CommandAvailability;
    executables?: string[];
    minimum_capability?: string;
    adapter_path?: string;
    target_surface?: TargetSurface;
    operation_effect?: OperationEffect;
    execution_operator?: AdapterCommand["execution_operator"];
    operation_family?: AdapterCommand["operation_family"];
    idempotency?: AdapterCommand["idempotency"];
    effect_projection?: Pick<
      CommandContractEffect,
      "operation_effect" | "effect_source" | "effect_confidence"
    >;
    method?: AdapterCommand["method"];
    pipeline?: AdapterCommand["pipeline"];
    source_tier?: AdapterCommand["source_tier"];
    shadowed_adapter_path?: string;
    paginated?: boolean;
    retrieval?: RetrievalMetadata;
    output?: AdapterCommand["output"];
    stream?: boolean;
    defaultFormat?: string;
  };
}

type CommandContractArg = AdapterArg | CoreDiscoveryArg;

function jsonTypeForArg(
  arg: CommandContractArg,
): CommandContractInputProperty["type"] {
  switch (arg.type) {
    case "int":
      return "integer";
    case "float":
      return "number";
    case "bool":
      return "boolean";
    case "str[]":
      return "array";
    case "nullable-float":
      return ["number", "null"];
    case "str-or-int":
      return ["string", "integer"];
    case "str":
    default:
      return "string";
  }
}

function buildInputSchema(
  args: readonly CommandContractArg[],
): CommandContractInputSchema {
  const properties: Record<string, CommandContractInputProperty> = {};
  const required: string[] = [];

  for (const arg of args) {
    const property: CommandContractInputProperty = {
      type: jsonTypeForArg(arg),
    };
    if (arg.type === "str[]") property.items = { type: "string" };
    if (arg.description !== undefined) property.description = arg.description;
    if (arg.default !== undefined) property.default = arg.default;
    if (arg.choices !== undefined && arg.choices.length > 0) {
      property.enum = arg.choices;
    }
    if (arg.minimum !== undefined) property.minimum = arg.minimum;
    if (arg.maximum !== undefined) property.maximum = arg.maximum;
    if (arg.minLength !== undefined) property.minLength = arg.minLength;
    if (arg.maxLength !== undefined) property.maxLength = arg.maxLength;
    if ("pattern" in arg && arg.pattern !== undefined) {
      property.pattern = arg.pattern;
    }
    if ("format" in arg && arg.format !== undefined) {
      property.format = arg.format;
    }
    if ("x-unicli-kind" in arg && arg["x-unicli-kind"] !== undefined) {
      property["x-unicli-kind"] = arg["x-unicli-kind"];
    }
    if ("x-unicli-accepts" in arg && arg["x-unicli-accepts"] !== undefined) {
      property["x-unicli-accepts"] = arg["x-unicli-accepts"];
    }
    if (
      "x-unicli-uri-origins" in arg &&
      arg["x-unicli-uri-origins"] !== undefined
    ) {
      property["x-unicli-uri-origins"] = arg["x-unicli-uri-origins"];
    }
    if (
      "x-unicli-uri-path-pattern" in arg &&
      arg["x-unicli-uri-path-pattern"] !== undefined
    ) {
      property["x-unicli-uri-path-pattern"] = arg["x-unicli-uri-path-pattern"];
    }
    properties[arg.name] = property;
    if (arg.required === true) required.push(arg.name);
  }

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function serializeOutputSchema(
  output?: string | OutputSchema,
): Record<string, unknown> | string | undefined {
  if (output === undefined) return undefined;
  if (typeof output === "string") return output;
  return { ...output };
}

function safetyClassFor(input: {
  effect: OperationEffect;
  authRequired: boolean;
}): CommandSafetyClass {
  if (input.effect === "destructive") return "destructive";
  if (input.effect === "read") return input.authRequired ? "auth_read" : "read";
  return "write";
}

function browserRequirement(
  adapter: AdapterManifest,
  command: AdapterCommand,
): CommandContractEffect["browser_requirement"] {
  const declaresBrowserCapability =
    browserCapability(command.minimum_capability) ||
    command.capabilities?.some(browserCapability) === true;
  if (browserCapability(command.minimum_capability)) return "required";
  if (command.browser === false && declaresBrowserCapability) {
    return "conditional";
  }
  return commandUsesBrowser(adapter, command) ? "required" : "never";
}

function browserCapability(capability: string | undefined): boolean {
  if (!capability) return false;
  const normalized = capability.toLowerCase();
  return (
    normalized.startsWith("browser.") || normalized.startsWith("cdp-browser.")
  );
}

function tagsFor(adapter: AdapterManifest, command: AdapterCommand): string[] {
  return [
    adapter.type,
    ...(adapter.category ? [adapter.category] : []),
    ...(command.quarantine === true ? ["quarantined"] : []),
    ...(command.paginated === true ? ["paginated"] : []),
  ].sort();
}

function contractDisplayName(
  adapter: AdapterManifest,
  commandName: string,
): string {
  return `${adapter.displayName ?? adapter.name} ${commandName}`;
}

function coreCommandUsesBrowser(command: CoreDiscoveryCommand): boolean {
  return command.type === "browser";
}

function tagsForCore(command: CoreDiscoveryCommand): string[] {
  return Array.from(
    new Set(["core", command.type, command.category].filter(Boolean)),
  ).sort();
}

export function buildCommandContract(
  input: BuildCommandContractInput,
): CommandContract {
  const { adapter, commandName, command } = input;
  const args = command.adapterArgs ?? [];
  const strategy = commandStrategy(adapter, command);
  const authRequired = commandRequiresAuth(adapter, command);
  const authOptional = commandHasOptionalAuth(command);
  const authSetupCommand = commandAuthSetupCommand(adapter, command);
  const targetSurface = resolveOperationTargetSurface({
    adapterType: adapter.type,
    targetSurface: command.target_surface,
  });
  const operation = resolveOperationFamily({
    command: commandName,
    description: command.description,
    retrieval: command.retrieval,
    explicit: command.operation_family,
  });
  const policy = evaluateOperationPolicy({
    site: adapter.name,
    command: commandName,
    description: command.description,
    adapterType: adapter.type,
    targetSurface,
    strategy,
    domain: command.domain ?? adapter.domain,
    base: command.base ?? adapter.base,
    browser: commandUsesBrowser(adapter, command),
    args,
    capabilities: command.capabilities,
    executables: command.executables,
    minimumCapability: command.minimum_capability,
    effect: command.operation_effect,
    operationFamily: operation.family,
    method: command.method,
    pipeline: command.pipeline,
  });
  const execution = resolveCommandOperator({
    adapterType: adapter.type,
    targetSurface,
    browser: commandUsesBrowser(adapter, command),
    minimumCapability: command.minimum_capability,
    capabilities: command.capabilities,
    explicitOperator: command.execution_operator,
  });
  const sourcePath = command.adapter_path;
  const repairCommand = `unicli repair ${adapter.name} ${commandName}`;
  const quarantined = command.quarantine === true;
  const artifactValidators = inferArtifactValidators(command);

  return {
    schema_version: "command-contract.v1",
    identity: {
      site: adapter.name,
      command: commandName,
      display_name: contractDisplayName(adapter, commandName),
      ...(adapter.category ? { category: adapter.category } : {}),
      tags: tagsFor(adapter, command),
      ...(sourcePath ? { source_path: sourcePath } : {}),
      ...(command.source_tier ? { source_tier: command.source_tier } : {}),
      ...(command.shadowed_adapter_path
        ? { shadowed_source_path: command.shadowed_adapter_path }
        : {}),
    },
    description: command.description ?? "",
    schemas: {
      input: buildInputSchema(args),
      ...(command.output !== undefined
        ? { output: serializeOutputSchema(command.output) }
        : {}),
    },
    execution,
    operation,
    effect: {
      operation_effect: policy.effect,
      effect_source: policy.effect_source,
      effect_confidence: policy.effect_confidence,
      risk: policy.risk,
      safety_class: safetyClassFor({
        effect: policy.effect,
        authRequired,
      }),
      target_surface: targetSurface,
      target_surface_source:
        command.target_surface !== undefined ? "declared" : "adapter_type",
      target_surface_confidence:
        command.target_surface !== undefined ? "high" : "low",
      browser: commandUsesBrowser(adapter, command),
      browser_requirement: browserRequirement(adapter, command),
      read_only: policy.effect === "read",
      idempotency: command.idempotency ?? "unknown",
      idempotent: command.idempotency === "guaranteed",
      open_world:
        policy.capability_scope.dimensions.network.access !== "none" ||
        policy.capability_scope.dimensions.browser.access !== "none",
      paginated: command.paginated === true,
    },
    auth: {
      strategy: strategy ?? "public",
      required: authRequired,
      ...(authOptional ? { optional: true } : {}),
      ...(authSetupCommand ? { setup_command: authSetupCommand } : {}),
    },
    ...(command.availability
      ? {
          availability: {
            required_environment: [...command.availability.environment],
            discovery: command.availability.discovery ?? "always",
            ...(command.availability.setup_url
              ? { setup_url: command.availability.setup_url }
              : {}),
            runtime_state: "not_evaluated" as const,
          },
        }
      : {}),
    governance: {
      dimensions: policy.capability_scope.dimensions,
      resources: policy.capability_scope.resources,
      resource_summary: policy.capability_scope.resource_summary,
    },
    eval: {
      fixture_status: "unknown",
      live_status: quarantined ? "quarantined" : "unknown",
      health_status: quarantined ? "quarantined" : "unknown",
    },
    repair: {
      source_kind: "adapter",
      ...(sourcePath ? { source_path: sourcePath } : {}),
      ...(sourcePath ? { adapter_path: sourcePath } : {}),
      repair_command: repairCommand,
      quarantined,
      ...(command.quarantineReason
        ? { quarantine_reason: command.quarantineReason }
        : {}),
      ...(command.minimum_capability
        ? { minimum_capability: command.minimum_capability }
        : {}),
    },
    artifacts: {
      produces_files: artifactValidators.length > 0,
      validators: artifactValidators.map((validator) => validator.kind),
    },
    ...(command.retrieval ? { retrieval: command.retrieval } : {}),
  };
}

export function buildManifestCommandContract(
  input: BuildManifestCommandContractInput,
): CommandContract {
  const command: AdapterCommand = {
    name: input.commandName,
    description: input.command.description,
    adapter_path: input.command.adapter_path,
    target_surface: input.command.target_surface,
    operation_effect:
      input.command.effect_projection?.operation_effect ??
      input.command.operation_effect,
    execution_operator: input.command.execution_operator,
    operation_family: input.command.operation_family,
    idempotency: input.command.idempotency,
    method: input.command.method,
    pipeline: input.command.pipeline,
    source_tier: input.command.source_tier,
    shadowed_adapter_path: input.command.shadowed_adapter_path,
    strategy: input.command.strategy as AdapterCommand["strategy"],
    browser: input.command.browser,
    browserSession: input.command.browserSession,
    domain: input.command.domain,
    base: input.command.base,
    adapterArgs: input.command.args,
    capabilities: input.command.capabilities,
    auth_requirement: input.command.auth_requirement,
    availability: input.command.availability,
    executables: input.command.executables,
    minimum_capability: input.command.minimum_capability,
    quarantine: input.command.quarantined === true ? true : undefined,
    paginated: input.command.paginated,
    retrieval: input.command.retrieval,
    output: input.command.output,
    stream: input.command.stream,
    defaultFormat: input.command
      .defaultFormat as AdapterCommand["defaultFormat"],
  };
  const adapter: AdapterManifest = {
    name: input.site,
    type: input.adapterType as AdapterManifest["type"],
    ...(input.category ? { category: input.category } : {}),
    strategy: input.command.strategy as AdapterManifest["strategy"],
    domain: input.command.domain,
    base: input.command.base,
    browser: input.command.browser,
    commands: { [input.commandName]: command },
  };
  const contract = buildCommandContract({
    adapter,
    commandName: input.commandName,
    command,
  });
  const projectedEffect = input.command.effect_projection;
  if (!projectedEffect) return contract;
  return {
    ...contract,
    effect: {
      ...contract.effect,
      ...projectedEffect,
    },
  };
}

export function buildCoreCommandContract(
  input: BuildCoreCommandContractInput,
): CommandContract {
  const { command } = input;
  const args = command.args ?? [];
  const targetSurface = resolveOperationTargetSurface({
    adapterType: command.type,
    targetSurface: command.target_surface,
  });
  const browser = coreCommandUsesBrowser(command);
  const operation = resolveOperationFamily({
    command: command.command,
    description: command.description,
    explicit: command.operation_family,
  });
  const policy = evaluateOperationPolicy({
    site: command.site,
    command: command.command,
    description: command.description,
    adapterType: command.type,
    targetSurface,
    strategy: "public",
    browser,
    args: [...args],
    capabilities: [...(command.capabilities ?? [])],
    minimumCapability: command.minimum_capability,
    effect: command.operation_effect,
    operationFamily: operation.family,
  });
  const resolvedExecution = resolveCommandOperator({
    adapterType: command.type,
    targetSurface,
    browser,
    minimumCapability: command.minimum_capability,
    capabilities: command.capabilities,
    explicitOperator: command.execution_operator,
  });
  const execution: CommandOperatorProfile = command.execution_profile
    ? {
        ...resolvedExecution,
        ...command.execution_profile,
        operator: resolvedExecution.operator,
        selection_reason: "declared by the command-specific execution profile",
      }
    : resolvedExecution;
  const sourcePath = command.source_path;

  return {
    schema_version: "command-contract.v1",
    identity: {
      site: command.site,
      command: command.command,
      display_name: `${command.site} ${command.command}`,
      category: command.category,
      tags: tagsForCore(command),
      ...(sourcePath ? { source_path: sourcePath } : {}),
    },
    description: command.description,
    schemas: {
      input: buildInputSchema(args),
    },
    execution,
    operation,
    effect: {
      operation_effect: policy.effect,
      effect_source: policy.effect_source,
      effect_confidence: policy.effect_confidence,
      risk: policy.risk,
      safety_class: safetyClassFor({
        effect: policy.effect,
        authRequired: false,
      }),
      target_surface: targetSurface,
      target_surface_source:
        command.target_surface !== undefined ? "declared" : "adapter_type",
      target_surface_confidence:
        command.target_surface !== undefined ? "high" : "low",
      browser,
      browser_requirement: browser ? "required" : "never",
      read_only: policy.effect === "read",
      idempotency: command.idempotency ?? "unknown",
      idempotent: command.idempotency === "guaranteed",
      open_world:
        policy.capability_scope.dimensions.network.access !== "none" ||
        policy.capability_scope.dimensions.browser.access !== "none",
      paginated: false,
    },
    auth: {
      strategy: "public",
      required: false,
    },
    governance: {
      dimensions: policy.capability_scope.dimensions,
      resources: policy.capability_scope.resources,
      resource_summary: policy.capability_scope.resource_summary,
    },
    eval: {
      fixture_status: "unknown",
      live_status: "unknown",
      health_status: "unknown",
    },
    repair: {
      source_kind: "core",
      ...(sourcePath ? { source_path: sourcePath } : {}),
      quarantined: false,
    },
    artifacts: {
      produces_files: false,
      validators: [],
    },
  };
}
