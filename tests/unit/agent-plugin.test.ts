import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
    expect(Object.keys(inspection.mcp.servers)).toEqual(["local", "remote"]);
    expect(inspection.projected_operations).toEqual([
      "agent-plugin.fixture.tools.summarize",
      "agent-plugin.fixture.tools.__mcp_servers",
    ]);
    expect(inspection.skills[0].allowedTools).toEqual(["Read", "Bash(jq:*)"]);
    expect(inspection.skills[0].pipeline).toBeUndefined();
    expect(inspection.issues.map((issue) => issue.component)).toEqual([
      "manifest",
      "mcp",
    ]);

    registerAgentPluginSkills(inspection);
    const operation = resolveCommand("agent-plugin.fixture.tools", "summarize");
    expect(operation?.command.pipeline).toBeUndefined();
    expect(operation?.command.operation_effect).toBe("read");
    const mcpOperation = resolveCommand(
      "agent-plugin.fixture.tools",
      "__mcp_servers",
    );
    expect(mcpOperation?.command.operation_effect).toBe("read");
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

  it.skipIf(process.platform === "win32")(
    "rejects plugin-relative MCP paths through an escaping symlink",
    () => {
      const root = mkdtempSync(join(tmpdir(), "unicli-agent-plugin-"));
      const outside = mkdtempSync(
        join(tmpdir(), "unicli-agent-plugin-outside-"),
      );
      roots.push(root, outside);
      symlinkSync(outside, join(root, "bin"), "dir");
      writeFileSync(
        join(root, "plugin.json"),
        JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "bounded-mcp" }),
      );
      writeFileSync(
        join(root, "mcp.json"),
        JSON.stringify({
          $schema: AGENT_PLUGIN_MCP_SCHEMA,
          mcpServers: {
            escaped: { type: "stdio", command: "./bin/not-created" },
          },
        }),
      );

      const inspection = inspectAgentPlugin(root);
      expect(inspection.mcp.servers).toEqual({});
      expect(inspection.issues).toContainEqual(
        expect.objectContaining({ component: "mcp", severity: "warning" }),
      );
    },
  );

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
});
