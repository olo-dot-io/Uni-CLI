import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AGENT_PLUGIN_MCP_SCHEMA,
  AGENT_PLUGIN_SCHEMA,
  AgentPluginError,
  inspectAgentPlugin,
  registerAgentPluginSkills,
} from "../../src/plugin/agent-plugin.js";
import { resolveCommand } from "../../src/registry.js";
import { loadPlugins } from "../../src/plugin/loader.js";
import { loadSkills } from "../../src/protocol/skill.js";

describe("Agent Plugins 1.0", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("loads portable skills, validates MCP config, and projects operations", () => {
    const root = mkdtempSync(join(tmpdir(), "unicli-agent-plugin-"));
    roots.push(root);
    mkdirSync(join(root, "skills", "summarize"), { recursive: true });
    writeFileSync(
      join(root, "plugin.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_SCHEMA,
        name: "fixture.tools",
        version: "1.0.0",
        description: "Fixture portable tools",
        unknown: true,
      }),
    );
    writeFileSync(
      join(root, "skills", "summarize", "SKILL.md"),
      [
        "---",
        "name: summarize",
        "description: Summarize one local artifact",
        "allowed-tools: Read Bash(jq:*)",
        "pipeline:",
        "  - shell: echo must-not-execute",
        "---",
        "",
        "Read the artifact and return a concise summary.",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "mcp.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: {
          local: {
            type: "stdio",
            command: "./bin/server",
            args: ["--data", "${PLUGIN_DATA}/fixture"],
          },
          remote: {
            type: "streamable-http",
            url: "https://example.com/mcp",
          },
          insecure: {
            type: "streamable-http",
            url: "http://example.com/mcp",
          },
        },
      }),
    );

    const inspection = inspectAgentPlugin(root);
    expect(inspection.skills.map((skill) => skill.name)).toEqual(["summarize"]);
    expect(inspection.mcp.valid).toBe(true);
    expect(Object.keys(inspection.mcp.servers)).toEqual([
      "local",
      "remote",
      "insecure",
    ]);
    expect(inspection.projected_operations).toEqual([
      "agent-plugin.fixture.tools.summarize",
    ]);
    expect(inspection.skills[0].allowedTools).toEqual(["Read", "Bash(jq:*)"]);
    expect(inspection.skills[0].pipeline).toBeUndefined();
    expect(inspection.issues.map((issue) => issue.component)).toEqual([
      "manifest",
    ]);

    registerAgentPluginSkills(inspection);
    const operation = resolveCommand("agent-plugin.fixture.tools", "summarize");
    expect(operation?.command.pipeline).toBeUndefined();
    expect(operation?.command.operation_effect).toBe("read");
  });

  it("skips non-conforming skills without disabling valid components", () => {
    const root = mkdtempSync(join(tmpdir(), "unicli-agent-plugin-"));
    roots.push(root);
    mkdirSync(join(root, "skills", "wrong-directory"), { recursive: true });
    writeFileSync(
      join(root, "plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "strict-skills" }),
    );
    writeFileSync(
      join(root, "skills", "wrong-directory", "SKILL.md"),
      [
        "---",
        "name: different-name",
        "description: This name does not match the skill directory",
        "---",
        "",
      ].join("\n"),
    );

    const inspection = inspectAgentPlugin(root);
    expect(inspection.skills).toEqual([]);
    expect(inspection.issues).toEqual([
      expect.objectContaining({ severity: "warning", component: "skills" }),
    ]);
  });

  it("keeps rejected portable skills out of generic skill discovery", async () => {
    const home = mkdtempSync(join(tmpdir(), "unicli-agent-plugin-home-"));
    roots.push(home);
    const root = join(home, ".unicli", "plugins", "strict-skills");
    mkdirSync(join(root, "skills", "valid"), { recursive: true });
    mkdirSync(join(root, "skills", "wrong-directory"), { recursive: true });
    writeFileSync(
      join(root, "plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "strict-skills" }),
    );
    writeFileSync(
      join(root, "skills", "valid", "SKILL.md"),
      ["---", "name: valid", "description: Valid portable skill", "---"].join(
        "\n",
      ),
    );
    writeFileSync(
      join(root, "skills", "wrong-directory", "SKILL.md"),
      [
        "---",
        "name: rejected",
        "description: Name does not match the directory",
        "---",
      ].join("\n"),
    );

    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const result = await loadPlugins();
      expect(result.loaded).toEqual(["strict-skills"]);
      expect(result.errors).toEqual([
        expect.stringContaining("skipped skill wrong-directory"),
      ]);
      const discovered = loadSkills({
        repoDir: join(home, "missing-repo"),
        homeDir: home,
      }).filter((skill) => skill.source === "plugin");
      expect(discovered.map((skill) => skill.name)).toEqual(["valid"]);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  it("rejects a package that targets an unsupported manifest schema", () => {
    const root = mkdtempSync(join(tmpdir(), "unicli-agent-plugin-"));
    roots.push(root);
    writeFileSync(
      join(root, "plugin.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/2.0.0/plugin.schema.json",
        name: "fixture-v2",
      }),
    );
    expect(() => inspectAgentPlugin(root)).toThrowError(AgentPluginError);
    expect(() => inspectAgentPlugin(root)).toThrow(/unsupported/);
  });

  it("does not load a native extension after a fatal portable manifest error", async () => {
    const home = mkdtempSync(join(tmpdir(), "unicli-agent-plugin-home-"));
    roots.push(home);
    const root = join(home, ".unicli", "plugins", "invalid-portable");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "plugin.json"),
      JSON.stringify({ $schema: "unsupported", name: "invalid-portable" }),
    );
    writeFileSync(
      join(root, "unicli-plugin.json"),
      JSON.stringify({ name: "must-not-load", version: "1.0.0" }),
    );
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const result = await loadPlugins();
      expect(result.loaded).toEqual([]);
      expect(result.errors).toHaveLength(1);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  it("loads the native manifest declared by the portable extension", async () => {
    const home = mkdtempSync(join(tmpdir(), "unicli-agent-plugin-home-"));
    roots.push(home);
    const root = join(home, ".unicli", "plugins", "declared-extension");
    mkdirSync(join(root, "runtime"), { recursive: true });
    mkdirSync(join(root, "adapters", "declared-extension"), {
      recursive: true,
    });
    writeFileSync(
      join(root, "plugin.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_SCHEMA,
        name: "declared-extension",
        extensions: {
          "dev.unicli": { manifest: "./runtime/unicli.json" },
        },
      }),
    );
    writeFileSync(
      join(root, "runtime", "unicli.json"),
      JSON.stringify({
        name: "declared-extension",
        version: "1.0.0",
        adapters: "adapters/",
      }),
    );
    writeFileSync(
      join(root, "adapters", "declared-extension", "ping.yaml"),
      [
        "site: declared-extension",
        "name: ping",
        "description: Ping through a declared runtime extension",
        "type: web-api",
        "strategy: public",
        "operation_effect: read",
        "pipeline:",
        "  - select: data",
        "capabilities: []",
        "minimum_capability: none",
        "trust: public",
        "confidentiality: public",
        "quarantine: false",
        "schema_version: v2",
        "",
      ].join("\n"),
    );

    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const result = await loadPlugins();
      expect(result).toEqual({ loaded: ["declared-extension"], errors: [] });
      expect(resolveCommand("declared-extension", "ping")).toBeDefined();
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });
});
