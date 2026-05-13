/**
 * @owner Uni-CLI Core
 * @does Projects adapter registry commands into the agent-native command contract.
 * @needs AdapterManifest, AdapterCommand, operation policy metadata.
 * @feeds describe, MCP, agent packs, benchmark generation, repair tooling.
 * @breaks Missing source paths, schemas, safety metadata, or repair metadata.
 */

import {
  commandRequiresAuth,
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
import type {
  AdapterArg,
  AdapterCommand,
  AdapterManifest,
  OutputSchema,
  Strategy,
  TargetSurface,
} from "../types.js";

export type CommandSafetyClass = "read" | "auth_read" | "write" | "destructive";

export interface CommandContractIdentity {
  site: string;
  command: string;
  display_name: string;
  category?: string;
  tags: string[];
  source_path?: string;
}

export interface CommandContractInputProperty {
  type: "string" | "integer" | "number" | "boolean";
  description?: string;
  default?: unknown;
  enum?: string[];
  format?: AdapterArg["format"];
  "x-unicli-kind"?: AdapterArg["x-unicli-kind"];
  "x-unicli-accepts"?: AdapterArg["x-unicli-accepts"];
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
  risk: OperationRisk;
  safety_class: CommandSafetyClass;
  target_surface: TargetSurface;
  browser: boolean;
  read_only: boolean;
  idempotent: boolean;
  open_world: boolean;
  paginated: boolean;
}

export interface CommandContractAuth {
  strategy: Strategy | "public";
  required: boolean;
  setup_command?: string;
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
  adapter_path?: string;
  repair_command: string;
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
  effect: CommandContractEffect;
  auth: CommandContractAuth;
  governance: CommandContractGovernance;
  eval: CommandContractEval;
  repair: CommandContractRepair;
  artifacts: CommandContractArtifacts;
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

function jsonTypeForArg(arg: AdapterArg): CommandContractInputProperty["type"] {
  switch (arg.type) {
    case "int":
      return "integer";
    case "float":
      return "number";
    case "bool":
      return "boolean";
    case "str":
    default:
      return "string";
  }
}

function buildInputSchema(args: AdapterArg[]): CommandContractInputSchema {
  const properties: Record<string, CommandContractInputProperty> = {};
  const required: string[] = [];

  for (const arg of args) {
    const property: CommandContractInputProperty = {
      type: jsonTypeForArg(arg),
    };
    if (arg.description !== undefined) property.description = arg.description;
    if (arg.default !== undefined) property.default = arg.default;
    if (arg.choices !== undefined && arg.choices.length > 0) {
      property.enum = arg.choices;
    }
    if (arg.format !== undefined) property.format = arg.format;
    if (arg["x-unicli-kind"] !== undefined) {
      property["x-unicli-kind"] = arg["x-unicli-kind"];
    }
    if (arg["x-unicli-accepts"] !== undefined) {
      property["x-unicli-accepts"] = arg["x-unicli-accepts"];
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

export function buildCommandContract(
  input: BuildCommandContractInput,
): CommandContract {
  const { adapter, commandName, command } = input;
  const args = command.adapterArgs ?? [];
  const strategy = commandStrategy(adapter, command);
  const authRequired = commandRequiresAuth(adapter, command);
  const targetSurface = resolveOperationTargetSurface({
    adapterType: adapter.type,
    targetSurface: command.target_surface,
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
    },
    description: command.description ?? "",
    schemas: {
      input: buildInputSchema(args),
      ...(command.output !== undefined
        ? { output: serializeOutputSchema(command.output) }
        : {}),
    },
    effect: {
      operation_effect: policy.effect,
      risk: policy.risk,
      safety_class: safetyClassFor({
        effect: policy.effect,
        authRequired,
      }),
      target_surface: targetSurface,
      browser: commandUsesBrowser(adapter, command),
      read_only: policy.effect === "read",
      idempotent: policy.effect === "read",
      open_world:
        policy.capability_scope.dimensions.network.access !== "none" ||
        policy.capability_scope.dimensions.browser.access !== "none",
      paginated: command.paginated === true,
    },
    auth: {
      strategy: strategy ?? "public",
      required: authRequired,
      ...(authRequired
        ? { setup_command: `unicli auth setup ${adapter.name}` }
        : {}),
    },
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
  };
}
