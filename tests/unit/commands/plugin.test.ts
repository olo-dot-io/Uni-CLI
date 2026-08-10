import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Command } from "commander";

import { registerPluginCommands } from "../../../src/commands/plugin.js";
import { AGENT_PLUGIN_SCHEMA } from "../../../src/plugin/agent-plugin.js";

describe("unicli plugin inspect", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits a structured portable package inspection", async () => {
    const root = mkdtempSync(join(tmpdir(), "unicli-plugin-command-"));
    roots.push(root);
    mkdirSync(join(root, "skills", "activate"), { recursive: true });
    writeFileSync(
      join(root, "plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "command-fixture" }),
    );
    writeFileSync(
      join(root, "skills", "activate", "SKILL.md"),
      [
        "---",
        "name: activate",
        "description: Load the command fixture instructions",
        "---",
        "",
        "Return the fixture instructions.",
        "",
      ].join("\n"),
    );

    let output = "";
    const originalLog = console.log;
    console.log = ((...values: unknown[]) => {
      output += `${values.map(String).join(" ")}\n`;
    }) as typeof console.log;
    try {
      const program = new Command();
      program.exitOverride();
      program.option("-f, --format <fmt>", "output format");
      registerPluginCommands(program);
      await program.parseAsync(["-f", "json", "plugin", "inspect", root], {
        from: "user",
      });
    } finally {
      console.log = originalLog;
    }

    const envelope = JSON.parse(output.trim()) as {
      ok: boolean;
      command: string;
      data: {
        manifest: { name: string };
        projected_operations: string[];
      };
    };
    expect(envelope).toMatchObject({
      ok: true,
      command: "plugin.inspect",
      data: {
        manifest: { name: "command-fixture" },
        projected_operations: ["agent-plugin.command-fixture.activate"],
      },
    });
  });
});
