import { describe, expect, it } from "vitest";

import {
  cli,
  getAdapter,
  listCommands,
  registerAdapter,
  Strategy,
} from "../../src/registry.js";
import { describe as describeAdapter } from "../../src/commands/describe.js";
import {
  buildCatalog,
  buildSkillForCommand,
} from "../../src/commands/skills.js";
import { AdapterType } from "../../src/types.js";

describe("TypeScript adapter registry", () => {
  it("preserves declared args for describe and invocation surfaces", async () => {
    cli({
      site: "unit-ts-registry",
      name: "search",
      description: "Search from a TS adapter",
      strategy: Strategy.COOKIE,
      browser: true,
      args: [
        {
          name: "query",
          type: "str",
          required: true,
          positional: true,
          description: "Search query",
        },
        {
          name: "limit",
          type: "int",
          default: 20,
          description: "Number of results",
        },
      ],
      columns: ["title"],
      func: async () => [],
    });

    const adapter = getAdapter("unit-ts-registry");
    const command = adapter?.commands.search;

    expect(command?.adapterArgs).toEqual([
      {
        name: "query",
        type: "str",
        required: true,
        positional: true,
        description: "Search query",
      },
      {
        name: "limit",
        type: "int",
        default: 20,
        description: "Number of results",
      },
    ]);
  });

  it("carries command-level strategy and browser metadata into discovery surfaces", () => {
    const adapter = {
      name: "unit-command-scope",
      type: AdapterType.WEB_API,
      strategy: Strategy.PUBLIC,
      commands: {
        public: {
          name: "public",
          description: "Public command",
          strategy: Strategy.PUBLIC,
          columns: ["title"],
          pipeline: [],
        },
        private: {
          name: "private",
          description: "Private command",
          strategy: Strategy.COOKIE,
          browser: true,
          columns: ["title"],
          adapterArgs: [
            {
              name: "query",
              type: "str" as const,
              required: true,
              positional: true,
            },
          ],
          pipeline: [],
        },
      },
    };
    registerAdapter(adapter);

    const commandRows = listCommands().filter(
      (row) => row.site === "unit-command-scope",
    );
    expect(commandRows.find((row) => row.command === "public")?.auth).toBe(
      false,
    );
    expect(commandRows.find((row) => row.command === "private")?.auth).toBe(
      true,
    );

    const siteDescription = describeAdapter("unit-command-scope", undefined)
      .payload as {
      commands: Array<{
        name: string;
        strategy: string;
        auth: boolean;
        browser: boolean;
      }>;
    };
    expect(
      siteDescription.commands.find((command) => command.name === "private"),
    ).toMatchObject({
      strategy: "cookie",
      auth: true,
      browser: true,
    });

    const commandDescription = describeAdapter(
      "unit-command-scope",
      "private",
    ).payload;
    expect(commandDescription).toMatchObject({
      strategy: "cookie",
      auth: true,
      browser: true,
    });

    const skill = buildSkillForCommand(
      adapter,
      "private",
      adapter.commands.private,
    );
    expect(skill.body).toContain("strategy is `cookie`");

    const catalogAdapter = buildCatalog().adapters.find(
      (row) => row.site === "unit-command-scope",
    );
    expect(
      catalogAdapter?.commands.find((row) => row.name === "private"),
    ).toMatchObject({
      strategy: "cookie",
      auth: true,
      browser: true,
    });
  });
});
