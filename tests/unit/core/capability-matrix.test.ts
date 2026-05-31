import { describe, expect, it } from "vitest";
import {
  buildArchitectureCapabilityMatrix,
  buildArchitectureWorkflowReadiness,
  surfacesForCapabilityEntry,
  type CapabilityMatrixInventoryEntry,
} from "../../../src/core/capability-matrix.js";

const catalogRows: CapabilityMatrixInventoryEntry[] = [
  {
    ref: "bilibili.search",
    site: "bilibili",
    command: "search",
    source_kind: "adapter",
    adapter_type: "web-api",
    target_surface: "web",
    category: "video",
    source_path: "src/adapters/bilibili/search.ts",
    safety_class: "read",
    operation_effect: "read",
    capabilities: ["http.fetch"],
    uses_browser: false,
    is_local_computer_use: false,
  },
  {
    ref: "browser.click",
    site: "browser",
    command: "click",
    source_kind: "core",
    adapter_type: "browser",
    target_surface: "web",
    category: "dev",
    source_path: "src/commands/browser/index.ts",
    safety_class: "write",
    operation_effect: "local_app",
    capabilities: [],
    uses_browser: true,
    is_local_computer_use: false,
  },
  {
    ref: "macos.music-control",
    site: "macos",
    command: "music-control",
    source_kind: "adapter",
    adapter_type: "desktop",
    target_surface: "desktop",
    category: "desktop",
    source_path: "src/adapters/macos/music-control.yaml",
    safety_class: "write",
    operation_effect: "local_app",
    minimum_capability: "subprocess.exec",
    capabilities: ["subprocess.exec"],
    uses_browser: false,
    is_local_computer_use: true,
  },
  {
    ref: "mcp.serve",
    site: "mcp",
    command: "serve",
    source_kind: "core",
    adapter_type: "service",
    target_surface: "system",
    category: "dev",
    source_path: "src/commands/mcp.ts",
    safety_class: "write",
    operation_effect: "service_state",
    capabilities: [],
    uses_browser: false,
    is_local_computer_use: false,
  },
  {
    ref: "gh.repo",
    site: "gh",
    command: "repo",
    source_kind: "adapter",
    adapter_type: "bridge",
    target_surface: "system",
    category: "dev",
    source_path: "src/adapters/gh/repo.yaml",
    safety_class: "read",
    operation_effect: "read",
    minimum_capability: "subprocess.exec",
    capabilities: ["subprocess.exec"],
    uses_browser: false,
    is_local_computer_use: false,
  },
];

describe("capability matrix", () => {
  it("classifies each command into the real computer-control substrates it touches", () => {
    expect(surfacesForCapabilityEntry(catalogRows[0]!)).toEqual(["web"]);
    expect(surfacesForCapabilityEntry(catalogRows[1]!)).toEqual([
      "web",
      "browser",
    ]);
    expect(surfacesForCapabilityEntry(catalogRows[2]!)).toEqual([
      "desktop",
      "system",
    ]);
    expect(surfacesForCapabilityEntry(catalogRows[3]!)).toEqual([
      "system",
      "protocol",
    ]);
    expect(surfacesForCapabilityEntry(catalogRows[4]!)).toEqual([
      "system",
      "bridge",
    ]);
  });

  it("builds catalog-derived coverage without implying live verification", () => {
    const matrix = buildArchitectureCapabilityMatrix(catalogRows);

    expect(matrix).toContainEqual(
      expect.objectContaining({
        surface: "browser",
        command_count: 1,
        core_commands: 1,
        write_commands: 1,
        representative_commands: ["browser.click"],
      }),
    );
    expect(matrix).toContainEqual(
      expect.objectContaining({
        surface: "system",
        command_count: 3,
        local_computer_use_commands: 1,
        source_path_coverage: { present: 3, missing: 0 },
      }),
    );
  });

  it("projects vehicle-assistant workflows into cataloged, partial, or gap readiness", () => {
    const workflows = buildArchitectureWorkflowReadiness(catalogRows);
    const byId = new Map(workflows.map((workflow) => [workflow.id, workflow]));

    expect(byId.get("media-playback")).toEqual(
      expect.objectContaining({
        readiness: "cataloged",
        representative_commands: ["macos.music-control"],
      }),
    );
    expect(byId.get("video-search")).toEqual(
      expect.objectContaining({
        readiness: "cataloged",
        representative_commands: ["bilibili.search"],
      }),
    );
    expect(byId.get("productivity-state")).toEqual(
      expect.objectContaining({
        readiness: "gap",
        gap: "no cataloged productivity state path",
      }),
    );
  });
});
