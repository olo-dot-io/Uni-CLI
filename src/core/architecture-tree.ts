/**
 * @owner src/core/architecture-tree.ts
 * @does Builds the callable Uni-CLI architecture tree and lifecycle audit from registered command contracts.
 * @needs src/core/command-contract, src/types
 * @feeds src/commands/architecture.ts, tests/unit/core/architecture-tree.test.ts
 * @breaks Propagates command-contract construction errors when adapter metadata is malformed.
 * @invariants Command lifecycle order is stable: create, discover, invoke, observe, repair, publish.
 * @side-effects none
 * @perf O(commands) over the loaded adapter registry; allocates one inventory entry per command.
 * @concurrency Pure and reentrant; no shared mutable state.
 * @test tests/unit/core/architecture-tree.test.ts
 * @stability experimental
 * @since 2026-05-26
 */

import { buildCommandContract } from "./command-contract.js";
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

export type CommandLifecycleStep = (typeof COMMAND_LIFECYCLE_STEPS)[number];
export type ArchitecturePriority = "P0" | "P1" | "P2";
export type ArchitectureNodeKind =
  | "root"
  | "group"
  | "surface"
  | "runtime"
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
  adapter_type: string;
  target_surface: TargetSurface;
  source_path?: string;
  safety_class: string;
  minimum_capability?: string;
  is_local_computer_use: boolean;
}

export interface ArchitectureTreeSummary {
  total_sites: number;
  total_commands: number;
  local_computer_use_commands: number;
  missing_source_path_commands: number;
}

export interface ArchitectureTree {
  schema_version: "architecture-tree.v1";
  lifecycle_steps: readonly CommandLifecycleStep[];
  summary: ArchitectureTreeSummary;
  root: ArchitectureTreeNode;
  command_inventory: ArchitectureCommandInventoryEntry[];
}

export interface ArchitectureTreeAudit {
  schema_version: "architecture-audit.v1";
  total_sites: number;
  total_commands: number;
  local_computer_use_commands: number;
  lifecycle_steps: readonly CommandLifecycleStep[];
  missing_source_paths: string[];
  second_class_surfaces: string[];
  ready_for_full_rewrite: boolean;
}

export interface BuildArchitectureTreeInput {
  adapters: readonly AdapterManifest[];
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
      entries.push({
        ref: commandRef(adapter, commandName),
        site: adapter.name,
        command: commandName,
        adapter_type: adapter.type,
        target_surface: targetSurface,
        ...(contract.identity.source_path
          ? { source_path: contract.identity.source_path }
          : {}),
        safety_class: contract.effect.safety_class,
        ...(command.minimum_capability
          ? { minimum_capability: command.minimum_capability }
          : {}),
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

function node(
  input: Omit<ArchitectureTreeNode, "children"> & {
    children?: ArchitectureTreeNode[];
  },
): ArchitectureTreeNode {
  return { ...input, children: input.children ?? [] };
}

function lifecycleNodes(): ArchitectureTreeNode[] {
  return COMMAND_LIFECYCLE_STEPS.map((step) =>
    node({
      id: `lifecycle-${step}`,
      label: step,
      kind: "lifecycle",
      priority: "P0",
      description: `Command lifecycle step: ${step}.`,
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
      "Bridge between agents and websites, browsers, desktop apps, local tools, system capabilities, and protocol servers.",
    command_count: summary.total_commands,
    children: [
      node({
        id: "first-class-citizens",
        label: "First-class citizens",
        kind: "group",
        priority: "P0",
        description:
          "Product roots that define Uni-CLI semantics across every wrapper.",
        children: [
          node({
            id: "command-contract",
            label: "Command contract",
            kind: "runtime",
            priority: "P0",
            description:
              "Site, command, args, output, auth, safety, capability, source path, and repair path.",
            command_count: summary.total_commands,
          }),
          node({
            id: "invocation-kernel",
            label: "Invocation kernel",
            kind: "runtime",
            priority: "P0",
            description:
              "Validate, harden, authorize, execute, observe, and envelope.",
            command_count: summary.total_commands,
          }),
          node({
            id: "local-computer-use",
            label: "Local computer use",
            kind: "surface",
            priority: "P0",
            description:
              "Native accessibility, CDP, subprocess, and visual cascade for installed software.",
            command_count: summary.local_computer_use_commands,
          }),
          node({
            id: "evidence-loop",
            label: "Evidence loop",
            kind: "runtime",
            priority: "P0",
            description:
              "AgentEnvelope, run traces, post-state evidence, and delivery trajectory.",
            command_count: summary.total_commands,
          }),
        ],
      }),
      node({
        id: "command-lifecycle",
        label: "Command lifecycle",
        kind: "group",
        priority: "P0",
        description:
          "Create, discover, invoke, observe, repair, and publish operations.",
        command_count: summary.total_commands,
        children: lifecycleNodes(),
      }),
      node({
        id: "second-class-surfaces",
        label: "Second-class surfaces",
        kind: "group",
        priority: "P2",
        description:
          "Important wrappers and fallbacks that must not fork command semantics.",
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
            id: "visual-fallback",
            label: "Visual fallback",
            kind: "surface",
            priority: "P2",
            description:
              "Valid only when it can see, act, and verify post-state evidence.",
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
  const commandInventory = collectCommandInventory(input.adapters);
  const localComputerUseCommands = commandInventory.filter(
    (entry) => entry.is_local_computer_use,
  ).length;
  const missingSourcePathCommands = commandInventory.filter(
    (entry) => entry.source_path === undefined,
  ).length;
  const summary: ArchitectureTreeSummary = {
    total_sites: input.adapters.length,
    total_commands: commandInventory.length,
    local_computer_use_commands: localComputerUseCommands,
    missing_source_path_commands: missingSourcePathCommands,
  };

  return {
    schema_version: "architecture-tree.v1",
    lifecycle_steps: COMMAND_LIFECYCLE_STEPS,
    summary,
    root: buildRootNode(summary),
    command_inventory: commandInventory,
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
    local_computer_use_commands: tree.summary.local_computer_use_commands,
    lifecycle_steps: COMMAND_LIFECYCLE_STEPS,
    missing_source_paths: missingSourcePaths,
    second_class_surfaces: [
      "expanded-mcp",
      "visual-fallback",
      "typescript-adapters",
    ],
    ready_for_full_rewrite:
      tree.summary.total_commands > 0 && missingSourcePaths.length === 0,
  };
}
