/**
 * @owner src/core/architecture-tree.ts
 * @does Builds the callable Uni-CLI Agent-Computer Interface architecture tree and audit from adapter and core command contracts.
 * @needs src/core/command-contract, src/discovery/core-catalog, src/types
 * @feeds src/commands/architecture.ts, tests/unit/core/architecture-tree.test.ts
 * @breaks Propagates command-contract construction errors when adapter metadata is malformed.
 * @invariants Agent-Computer Interface order is stable: intent, select, govern, act, observe, diagnose, repair-or-reroute, deliver, expose; architecture-tree.v1 keeps the serialized computer-control-platform node id for compatibility.
 * @side-effects none
 * @perf O(commands) over loaded adapter and core command registries; allocates one inventory entry per command.
 * @concurrency Pure and reentrant; no shared mutable state.
 * @test tests/unit/core/architecture-tree.test.ts
 * @stability experimental
 * @since 2026-05-26
 */

import {
  buildCommandContract,
  buildCoreCommandContract,
} from "./command-contract.js";
import {
  buildArchitectureCapabilityMatrix,
  buildArchitectureWorkflowReadiness,
  type ArchitectureCapabilityMatrixEntry,
  type ArchitectureWorkflowReadiness,
} from "./capability-matrix.js";
import type { CoreDiscoveryCommand } from "../discovery/core-catalog.js";
import { AdapterType } from "../types.js";
import type {
  AdapterCommand,
  AdapterManifest,
  TargetSurface,
} from "../types.js";

export const COMMAND_LIFECYCLE_STEPS = [
  "create",
  "discover",
  "invoke",
  "observe",
  "repair",
  "publish",
] as const;

export const AGENT_COMPUTER_INTERFACE_STAGES = [
  "intent",
  "select",
  "govern",
  "act",
  "observe",
  "diagnose",
  "repair-or-reroute",
  "deliver",
  "expose",
] as const;

export type CommandLifecycleStep = (typeof COMMAND_LIFECYCLE_STEPS)[number];
export type AgentComputerInterfaceStage =
  (typeof AGENT_COMPUTER_INTERFACE_STAGES)[number];
export type ArchitecturePriority = "P0" | "P1" | "P2";
export type ArchitectureNodeKind =
  | "root"
  | "group"
  | "surface"
  | "substrate"
  | "runtime"
  | "control-stage"
  | "lifecycle"
  | "verification";

export interface ArchitectureTreeNode {
  id: string;
  label: string;
  kind: ArchitectureNodeKind;
  priority?: ArchitecturePriority;
  description: string;
  command_count?: number;
  children: ArchitectureTreeNode[];
}

export interface ArchitectureCommandInventoryEntry {
  ref: string;
  site: string;
  command: string;
  source_kind: "adapter" | "core";
  adapter_type: string;
  target_surface: TargetSurface;
  source_path?: string;
  safety_class: string;
  operation_effect: string;
  effect_source: "declared" | "heuristic" | "default";
  effect_confidence: "high" | "medium" | "low";
  execution_operator: string;
  perception: string;
  actuation: string;
  target_scope: string;
  verification: string;
  interaction_impact: string;
  category?: string;
  minimum_capability?: string;
  capabilities: string[];
  uses_browser: boolean;
  is_local_computer_use: boolean;
}

export interface ArchitectureTreeSummary {
  total_sites: number;
  total_commands: number;
  adapter_commands: number;
  core_commands: number;
  local_computer_use_commands: number;
  missing_source_path_commands: number;
}

export interface ArchitectureTree {
  schema_version: "architecture-tree.v1";
  control_stages: readonly AgentComputerInterfaceStage[];
  lifecycle_steps: readonly CommandLifecycleStep[];
  summary: ArchitectureTreeSummary;
  root: ArchitectureTreeNode;
  command_inventory: ArchitectureCommandInventoryEntry[];
  capability_matrix: ArchitectureCapabilityMatrixEntry[];
  workflow_readiness: ArchitectureWorkflowReadiness[];
}

export interface ArchitectureTreeAudit {
  schema_version: "architecture-audit.v1";
  total_sites: number;
  total_commands: number;
  adapter_commands: number;
  core_commands: number;
  local_computer_use_commands: number;
  control_stages: readonly AgentComputerInterfaceStage[];
  lifecycle_steps: readonly CommandLifecycleStep[];
  capability_matrix: ArchitectureCapabilityMatrixEntry[];
  workflow_readiness: ArchitectureWorkflowReadiness[];
  missing_source_paths: string[];
  non_product_identities: string[];
  evidence_scope: "catalog-contracts";
  catalog_integrity: "complete" | "incomplete";
  runtime_readiness: "not_evaluated";
}

export interface BuildArchitectureTreeInput {
  adapters: readonly AdapterManifest[];
  coreCommands?: readonly CoreDiscoveryCommand[];
}

function commandRef(adapter: AdapterManifest, commandName: string): string {
  return `${adapter.name}.${commandName}`;
}

function isLocalComputerUseCommand(
  adapter: AdapterManifest,
  command: AdapterCommand,
  targetSurface: TargetSurface,
): boolean {
  if (targetSurface === "desktop" || targetSurface === "system") return true;
  if (adapter.type === AdapterType.DESKTOP) return true;
  return (command.capabilities ?? []).some(
    (capability) =>
      capability.startsWith("desktop-") ||
      capability.startsWith("compute.") ||
      capability.startsWith("visual."),
  );
}

function commandCapabilities(command: AdapterCommand): string[] {
  return Array.from(
    new Set([
      ...(command.capabilities ?? []),
      ...(command.minimum_capability ? [command.minimum_capability] : []),
    ]),
  ).sort();
}

function collectCommandInventory(
  adapters: readonly AdapterManifest[],
): ArchitectureCommandInventoryEntry[] {
  const entries: ArchitectureCommandInventoryEntry[] = [];

  for (const adapter of adapters) {
    for (const [commandName, command] of Object.entries(adapter.commands)) {
      const contract = buildCommandContract({
        adapter,
        commandName,
        command,
      });
      const targetSurface = contract.effect.target_surface;
      const capabilities = commandCapabilities(command);
      entries.push({
        ref: commandRef(adapter, commandName),
        site: adapter.name,
        command: commandName,
        source_kind: "adapter",
        adapter_type: adapter.type,
        target_surface: targetSurface,
        ...(adapter.category ? { category: adapter.category } : {}),
        ...(contract.identity.source_path
          ? { source_path: contract.identity.source_path }
          : {}),
        safety_class: contract.effect.safety_class,
        operation_effect: contract.effect.operation_effect,
        effect_source: contract.effect.effect_source,
        effect_confidence: contract.effect.effect_confidence,
        execution_operator: contract.execution.operator,
        perception: contract.execution.perception,
        actuation: contract.execution.actuation,
        target_scope: contract.execution.target_scope,
        verification: contract.execution.verification,
        interaction_impact: contract.execution.interaction_impact,
        ...(command.minimum_capability
          ? { minimum_capability: command.minimum_capability }
          : {}),
        capabilities,
        uses_browser: contract.effect.browser,
        is_local_computer_use: isLocalComputerUseCommand(
          adapter,
          command,
          targetSurface,
        ),
      });
    }
  }

  return entries.sort((leftEntry, rightEntry) =>
    leftEntry.ref.localeCompare(rightEntry.ref),
  );
}

function isLocalComputerUseCoreCommand(
  command: CoreDiscoveryCommand,
  targetSurface: TargetSurface,
): boolean {
  return targetSurface === "desktop" || command.type === AdapterType.DESKTOP;
}

function collectCoreCommandInventory(
  coreCommands: readonly CoreDiscoveryCommand[] = [],
): ArchitectureCommandInventoryEntry[] {
  return coreCommands.map((command) => {
    const contract = buildCoreCommandContract({ command });
    const targetSurface = contract.effect.target_surface;
    return {
      ref: `${command.site}.${command.command}`,
      site: command.site,
      command: command.command,
      source_kind: "core",
      adapter_type: command.type,
      target_surface: targetSurface,
      category: command.category,
      ...(contract.identity.source_path
        ? { source_path: contract.identity.source_path }
        : {}),
      safety_class: contract.effect.safety_class,
      operation_effect: contract.effect.operation_effect,
      effect_source: contract.effect.effect_source,
      effect_confidence: contract.effect.effect_confidence,
      execution_operator: contract.execution.operator,
      perception: contract.execution.perception,
      actuation: contract.execution.actuation,
      target_scope: contract.execution.target_scope,
      verification: contract.execution.verification,
      interaction_impact: contract.execution.interaction_impact,
      capabilities: [],
      uses_browser: contract.effect.browser,
      is_local_computer_use: isLocalComputerUseCoreCommand(
        command,
        targetSurface,
      ),
    };
  });
}

function collectFullCommandInventory(
  input: BuildArchitectureTreeInput,
): ArchitectureCommandInventoryEntry[] {
  return [
    ...collectCommandInventory(input.adapters),
    ...collectCoreCommandInventory(input.coreCommands),
  ].sort((leftEntry, rightEntry) =>
    leftEntry.ref.localeCompare(rightEntry.ref),
  );
}

function node(
  input: Omit<ArchitectureTreeNode, "children"> & {
    children?: ArchitectureTreeNode[];
  },
): ArchitectureTreeNode {
  return { ...input, children: input.children ?? [] };
}

const CONTROL_STAGE_DESCRIPTIONS: Record<AgentComputerInterfaceStage, string> =
  {
    intent:
      "Accept human or agent intent without preloading a giant tool list.",
    select:
      "Let the caller select a cataloged operation with a declared strategy and substrate; universal alternative arbitration is not yet implemented.",
    govern:
      "Evaluate the permission profile, risk, capability scope, and local policy covered by the selected operation.",
    act: "Invoke adapter commands through the adapter kernel or fixed core commands through their native handlers.",
    observe:
      "Render a stable success/error envelope with timing; add retryability, artifacts, recordings, or post-state evidence only when available.",
    diagnose:
      "Classify auth, policy, context, upstream, environment, or adapter failures when the owning path supplies enough context.",
    "repair-or-reroute":
      "Bound a next experiment with source path, alternatives, evidence, or a verification command when those fields are available.",
    deliver:
      "When the delivery subsystem is used, assess whether its objective is satisfied, active, blocked, or exhausted.",
    expose:
      "Expose the complete native CLI, MCP adapter projections, and documented ACP, HTTP, docs, skills, and script subsets.",
  };

function controlStageNodes(): ArchitectureTreeNode[] {
  return AGENT_COMPUTER_INTERFACE_STAGES.map((stage) =>
    node({
      id: `control-${stage}`,
      label: stage,
      kind: "control-stage",
      priority: "P0",
      description: CONTROL_STAGE_DESCRIPTIONS[stage],
    }),
  );
}

function lifecycleNodes(): ArchitectureTreeNode[] {
  return COMMAND_LIFECYCLE_STEPS.map((step) =>
    node({
      id: `lifecycle-${step}`,
      label: step,
      kind: "lifecycle",
      priority: "P1",
      description: `Internal authoring lifecycle step: ${step}.`,
    }),
  );
}

function buildRootNode(summary: ArchitectureTreeSummary): ArchitectureTreeNode {
  return node({
    id: "unicli",
    label: "Uni-CLI",
    kind: "root",
    priority: "P0",
    description:
      "Open Agent-Computer Interface runtime for real software: discover, select, govern, act, observe, diagnose, repair or reroute, deliver, and expose operations across software substrates.",
    command_count: summary.total_commands,
    children: [
      node({
        id: "computer-control-platform",
        label: "Agent-Computer Interface runtime",
        kind: "group",
        priority: "P0",
        description:
          "Top-level executable stages: intent, select, govern, act, observe, diagnose, repair or reroute, deliver, and expose.",
        command_count: summary.total_commands,
        children: controlStageNodes(),
      }),
      node({
        id: "operation-contract",
        label: "Operation contract",
        kind: "runtime",
        priority: "P0",
        description:
          "Agent-callable action identity, args, output, auth posture, safety, capability, source path, and repair path.",
        command_count: summary.total_commands,
      }),
      node({
        id: "control-kernel",
        label: "Control kernel",
        kind: "runtime",
        priority: "P0",
        description:
          "Validate, harden, authorize, invoke, observe, and envelope adapter commands; fixed core commands retain native handlers.",
        command_count: summary.total_commands,
      }),
      node({
        id: "action-substrates",
        label: "Action substrates",
        kind: "group",
        priority: "P0",
        description:
          "Concrete technical boundaries below the platform: useful, swappable, and never the top-level product identity.",
        command_count: summary.total_commands,
        children: [
          node({
            id: "web-api-substrate",
            label: "Web and API",
            kind: "substrate",
            priority: "P0",
            description:
              "HTTP, RSS, cookies, headers, browser-intercept flows, downloads, uploads, publishing, and extraction.",
          }),
          node({
            id: "browser-substrate",
            label: "Browser",
            kind: "substrate",
            priority: "P0",
            description:
              "CDP navigation, refs, DOM and accessibility snapshots, network capture, clicks, typing, screenshots, and render-aware evidence.",
          }),
          node({
            id: "desktop-os-substrate",
            label: "Desktop and OS",
            kind: "substrate",
            priority: "P0",
            description:
              "Installed apps, macOS Accessibility, UIA, AT-SPI, screenshots, app actions, clipboard, calendar, brightness, and OS state.",
            command_count: summary.local_computer_use_commands,
          }),
          node({
            id: "local-tool-substrate",
            label: "Local tools and files",
            kind: "substrate",
            priority: "P0",
            description:
              "Subprocess bridges, external binaries, paper/PDF workflows, media tools, developer CLIs, and file transformations.",
          }),
          node({
            id: "protocol-substrate",
            label: "Agent protocols",
            kind: "substrate",
            priority: "P1",
            description:
              "MCP, ACP, Streamable HTTP, JSON streams, generated agent configs, and skills as exposure or action boundaries.",
          }),
          node({
            id: "visual-substrate",
            label: "Visual coordinate operator",
            kind: "substrate",
            priority: "P2",
            description:
              "Explicit screenshot-and-coordinate action path, valid only when it can see, act, and verify post-state evidence.",
          }),
        ],
      }),
      node({
        id: "evidence-delivery-loop",
        label: "Evidence and delivery loop",
        kind: "runtime",
        priority: "P0",
        description:
          "AgentEnvelope plus operation-specific run traces, post-state checks, objective gates, trajectory, reroute, and bounded repair where supported.",
        command_count: summary.total_commands,
      }),
      node({
        id: "runtime-exposure",
        label: "Runtime exposure",
        kind: "surface",
        priority: "P1",
        description:
          "Native CLI is complete; MCP projects adapter operations; ACP, HTTP, docs, llms.txt, configs, and skills expose documented subsets.",
        command_count: summary.total_commands,
      }),
      node({
        id: "internal-authoring-cycle",
        label: "Internal authoring cycle",
        kind: "group",
        priority: "P1",
        description:
          "Create, discover, invoke, observe, repair, and publish operations; this is internal machinery, not product identity.",
        command_count: summary.total_commands,
        children: lifecycleNodes(),
      }),
      node({
        id: "non-product-identities",
        label: "Non-product identities",
        kind: "group",
        priority: "P2",
        description:
          "Surfaces Uni-CLI can use or expose but must not collapse into.",
        children: [
          node({
            id: "expanded-mcp",
            label: "Expanded MCP",
            kind: "surface",
            priority: "P2",
            description:
              "Opt-in broad tool exposure; compact MCP remains default.",
          }),
          node({
            id: "visual-coordinate-operator",
            label: "Visual coordinate operator",
            kind: "surface",
            priority: "P2",
            description:
              "Explicit desktop-scoped operator, valid only when it can see, act, and verify post-state evidence.",
          }),
          node({
            id: "typescript-adapters",
            label: "TypeScript adapters",
            kind: "runtime",
            priority: "P2",
            description:
              "Escape hatch when finite YAML pipeline primitives are insufficient.",
          }),
        ],
      }),
      node({
        id: "verification",
        label: "Verification",
        kind: "verification",
        priority: "P0",
        description:
          "Typecheck, lint, unit tests, adapter tests, docs build, boundary guard, and release verify.",
      }),
    ],
  });
}

export function buildArchitectureTree(
  input: BuildArchitectureTreeInput,
): ArchitectureTree {
  const commandInventory = collectFullCommandInventory(input);
  const capabilityMatrix = buildArchitectureCapabilityMatrix(commandInventory);
  const workflowReadiness =
    buildArchitectureWorkflowReadiness(commandInventory);
  const localComputerUseCommands = commandInventory.filter(
    (entry) => entry.is_local_computer_use,
  ).length;
  const missingSourcePathCommands = commandInventory.filter(
    (entry) => entry.source_path === undefined,
  ).length;
  const summary: ArchitectureTreeSummary = {
    total_sites: new Set(commandInventory.map((entry) => entry.site)).size,
    total_commands: commandInventory.length,
    adapter_commands: commandInventory.filter(
      (entry) => entry.source_kind === "adapter",
    ).length,
    core_commands: commandInventory.filter(
      (entry) => entry.source_kind === "core",
    ).length,
    local_computer_use_commands: localComputerUseCommands,
    missing_source_path_commands: missingSourcePathCommands,
  };

  return {
    schema_version: "architecture-tree.v1",
    control_stages: AGENT_COMPUTER_INTERFACE_STAGES,
    lifecycle_steps: COMMAND_LIFECYCLE_STEPS,
    summary,
    root: buildRootNode(summary),
    command_inventory: commandInventory,
    capability_matrix: capabilityMatrix,
    workflow_readiness: workflowReadiness,
  };
}

export function auditArchitectureTree(
  input: BuildArchitectureTreeInput,
): ArchitectureTreeAudit {
  const tree = buildArchitectureTree(input);
  const missingSourcePaths = tree.command_inventory
    .filter((entry) => entry.source_path === undefined)
    .map((entry) => entry.ref);

  return {
    schema_version: "architecture-audit.v1",
    total_sites: tree.summary.total_sites,
    total_commands: tree.summary.total_commands,
    adapter_commands: tree.summary.adapter_commands,
    core_commands: tree.summary.core_commands,
    local_computer_use_commands: tree.summary.local_computer_use_commands,
    control_stages: AGENT_COMPUTER_INTERFACE_STAGES,
    lifecycle_steps: COMMAND_LIFECYCLE_STEPS,
    capability_matrix: tree.capability_matrix,
    workflow_readiness: tree.workflow_readiness,
    missing_source_paths: missingSourcePaths,
    non_product_identities: [
      "expanded-mcp",
      "visual-coordinate-operator",
      "typescript-adapters",
      "browser-automation-only",
      "computer-use-sandbox-only",
      "per-site-wrapper-only",
    ],
    evidence_scope: "catalog-contracts",
    catalog_integrity:
      tree.summary.total_commands > 0 && missingSourcePaths.length === 0
        ? "complete"
        : "incomplete",
    runtime_readiness: "not_evaluated",
  };
}
