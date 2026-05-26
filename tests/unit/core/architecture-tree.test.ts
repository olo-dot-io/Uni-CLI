import { describe, expect, it } from "vitest";
import {
  COMMAND_LIFECYCLE_STEPS,
  auditArchitectureTree,
  buildArchitectureTree,
} from "../../../src/core/architecture-tree.js";
import { AdapterType, Strategy } from "../../../src/types.js";
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

describe("architecture tree", () => {
  it("keeps the command lifecycle order as the top-level runtime spine", () => {
    expect(COMMAND_LIFECYCLE_STEPS).toEqual([
      "create",
      "discover",
      "invoke",
      "observe",
      "repair",
      "publish",
    ]);
  });

  it("builds a tree that makes command contracts and local computer use first-class", () => {
    const tree = buildArchitectureTree({ adapters: fixtureAdapters });

    expect(tree.summary.total_commands).toBe(3);
    expect(tree.summary.local_computer_use_commands).toBe(2);
    expect(tree.root.children.map((node) => node.id)).toContain(
      "first-class-citizens",
    );

    const firstClassNode = tree.root.children.find(
      (node) => node.id === "first-class-citizens",
    );
    expect(firstClassNode?.children.map((node) => node.id)).toEqual([
      "command-contract",
      "invocation-kernel",
      "local-computer-use",
      "evidence-loop",
    ]);
  });

  it("audits missing repair source paths without hiding them behind success", () => {
    const audit = auditArchitectureTree({ adapters: fixtureAdapters });

    expect(audit.total_commands).toBe(3);
    expect(audit.missing_source_paths).toEqual(["local-app.missingSource"]);
    expect(audit.lifecycle_steps).toEqual(COMMAND_LIFECYCLE_STEPS);
    expect(audit.ready_for_full_rewrite).toBe(false);
  });
});
