import { describe, expect, it } from "vitest";
import {
  COMMAND_LIFECYCLE_STEPS,
  AGENT_COMPUTER_INTERFACE_STAGES,
  auditArchitectureTree,
  buildArchitectureTree,
} from "../../../src/core/architecture-tree.js";
import { AdapterType, Strategy } from "../../../src/types.js";
import type { CoreDiscoveryCommand } from "../../../src/discovery/core-catalog.js";
import type { AdapterManifest } from "../../../src/types.js";

const fixtureAdapters: AdapterManifest[] = [
  {
    name: "web",
    type: AdapterType.WEB_API,
    domain: "example.com",
    commands: {
      search: {
        name: "search",
        description: "Search example content",
        adapter_path: "src/adapters/web/search.yaml",
        adapterArgs: [{ name: "query", type: "str", required: true }],
        strategy: Strategy.PUBLIC,
        capabilities: ["http.fetch"],
        minimum_capability: "http.fetch",
      },
    },
  },
  {
    name: "local-app",
    type: AdapterType.DESKTOP,
    commands: {
      click: {
        name: "click",
        description: "Click a local app ref",
        target_surface: "desktop",
        adapter_path: "src/adapters/local-app/click.yaml",
        adapterArgs: [{ name: "ref", type: "str", required: true }],
        capabilities: ["desktop-ax.click"],
        minimum_capability: "desktop-ax.click",
      },
      missingSource: {
        name: "missingSource",
        description: "Intentionally lacks adapter_path for audit coverage",
        target_surface: "desktop",
        adapterArgs: [{ name: "ref", type: "str", required: true }],
        capabilities: ["desktop-ax.click"],
        minimum_capability: "desktop-ax.click",
      },
    },
  },
];

const fixtureCoreCommands: CoreDiscoveryCommand[] = [
  {
    site: "compute",
    command: "snapshot",
    description: "Capture a compact accessibility snapshot",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    source_path: "src/commands/compute.ts",
  },
];

describe("architecture tree", () => {
  it("keeps the Agent-Computer Interface stages as the product spine", () => {
    expect(AGENT_COMPUTER_INTERFACE_STAGES).toEqual([
      "intent",
      "select",
      "govern",
      "act",
      "observe",
      "diagnose",
      "repair-or-reroute",
      "deliver",
      "expose",
    ]);
  });

  it("keeps the command lifecycle as an internal authoring cycle", () => {
    expect(COMMAND_LIFECYCLE_STEPS).toEqual([
      "create",
      "discover",
      "invoke",
      "observe",
      "repair",
      "publish",
    ]);
  });

  it("builds a tree around the Agent-Computer Interface, not a catalog lifecycle", () => {
    const tree = buildArchitectureTree({ adapters: fixtureAdapters });

    expect(tree.summary.total_commands).toBe(3);
    expect(tree.summary.local_computer_use_commands).toBe(2);
    expect(tree.root.children.map((node) => node.id)).toContain(
      "computer-control-platform",
    );

    const platformNode = tree.root.children.find(
      (node) => node.id === "computer-control-platform",
    );
    expect(platformNode?.children.map((node) => node.id)).toEqual([
      "control-intent",
      "control-select",
      "control-govern",
      "control-act",
      "control-observe",
      "control-diagnose",
      "control-repair-or-reroute",
      "control-deliver",
      "control-expose",
    ]);

    const substrateNode = tree.root.children.find(
      (node) => node.id === "action-substrates",
    );
    expect(substrateNode?.children.map((node) => node.id)).toEqual([
      "web-api-substrate",
      "browser-substrate",
      "desktop-os-substrate",
      "local-tool-substrate",
      "protocol-substrate",
      "visual-substrate",
    ]);
  });

  it("includes core Commander commands in the Agent-Computer Interface inventory", () => {
    const tree = buildArchitectureTree({
      adapters: fixtureAdapters,
      coreCommands: fixtureCoreCommands,
    });

    expect(tree.summary.total_commands).toBe(4);
    expect(tree.summary.adapter_commands).toBe(3);
    expect(tree.summary.core_commands).toBe(1);
    expect(tree.summary.local_computer_use_commands).toBe(3);
    expect(tree.command_inventory).toContainEqual(
      expect.objectContaining({
        ref: "compute.snapshot",
        source_kind: "core",
        source_path: "src/commands/compute.ts",
        target_surface: "desktop",
        safety_class: "write",
        operation_effect: "local_file",
        capabilities: [],
        is_local_computer_use: true,
      }),
    );
  });

  it("builds a capability matrix and workflow readiness from the same inventory", () => {
    const tree = buildArchitectureTree({
      adapters: fixtureAdapters,
      coreCommands: fixtureCoreCommands,
    });

    expect(tree.capability_matrix).toContainEqual(
      expect.objectContaining({
        surface: "desktop",
        command_count: 3,
        local_computer_use_commands: 3,
      }),
    );
    expect(tree.workflow_readiness).toContainEqual(
      expect.objectContaining({
        id: "installed-app-operation",
        readiness: "cataloged",
        command_count: 3,
      }),
    );
  });

  it("audits missing repair source paths without hiding them behind success", () => {
    const audit = auditArchitectureTree({ adapters: fixtureAdapters });

    expect(audit.total_commands).toBe(3);
    expect(audit.adapter_commands).toBe(3);
    expect(audit.core_commands).toBe(0);
    expect(audit.missing_source_paths).toEqual(["local-app.missingSource"]);
    expect(audit.control_stages).toEqual(AGENT_COMPUTER_INTERFACE_STAGES);
    expect(audit.non_product_identities).toContain("computer-use-sandbox-only");
    expect(audit.capability_matrix.map((entry) => entry.surface)).toEqual([
      "web",
      "browser",
      "desktop",
      "system",
      "protocol",
      "bridge",
    ]);
    expect(audit.workflow_readiness.map((entry) => entry.id)).toContain(
      "browser-tab-control",
    );
    expect(audit.lifecycle_steps).toEqual(COMMAND_LIFECYCLE_STEPS);
    expect(audit.evidence_scope).toBe("catalog-contracts");
    expect(audit.catalog_integrity).toBe("incomplete");
    expect(audit.runtime_readiness).toBe("not_evaluated");
  });
});
