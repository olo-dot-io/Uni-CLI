import { describe, expect, it } from "vitest";

import {
  cli,
  commandUsesBrowser,
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
  it("stores immutable canonical descriptors so contract caches cannot go stale", () => {
    const source = {
      name: "unit-immutable-registry",
      type: AdapterType.WEB_API,
      commands: {
        read: {
          name: "read",
          execution_operator: "structured-api" as const,
          capabilities: ["http.fetch"],
        },
      },
    };
    registerAdapter(source);
    source.commands.read.capabilities.push("visual.click");
    const stored = getAdapter("unit-immutable-registry")!;

    expect(stored.commands.read.capabilities).toEqual(["http.fetch"]);
    expect(() => {
      stored.commands.read.execution_operator = "visual-coordinate";
    }).toThrow(TypeError);
    expect(stored.commands.read.execution_operator).toBe("structured-api");
  });

  it("lets an explicit command strategy avoid inheriting a browser site lifecycle", () => {
    const adapter = {
      name: "unit-browser-command-precedence",
      type: AdapterType.BROWSER,
      browser: true,
      strategy: Strategy.UI,
      commands: {},
    };
    expect(
      commandUsesBrowser(adapter, {
        name: "direct",
        strategy: Strategy.PUBLIC,
        minimum_capability: "http.fetch",
        capabilities: ["http.fetch"],
      }),
    ).toBe(false);
    expect(
      commandUsesBrowser(adapter, {
        name: "renderer",
        strategy: Strategy.PUBLIC,
        minimum_capability: "cdp-browser.evaluate",
      }),
    ).toBe(true);
  });

  it("merges sites by command and lets user commands shadow only their packaged peer", () => {
    registerAdapter({
      name: "unit-tiered-registry",
      type: AdapterType.WEB_API,
      commands: {
        keep: {
          name: "keep",
          adapter_path: "src/adapters/unit-tiered-registry/keep.yaml",
          source_tier: "packaged",
        },
        replace: {
          name: "replace",
          description: "packaged",
          adapter_path: "src/adapters/unit-tiered-registry/replace.yaml",
          source_tier: "packaged",
        },
      },
    });
    registerAdapter({
      name: "unit-tiered-registry",
      type: AdapterType.WEB_API,
      commands: {
        replace: {
          name: "replace",
          description: "user",
          adapter_path:
            "/tmp/home/.unicli/adapters/unit-tiered-registry/replace.yaml",
          source_tier: "user",
        },
      },
    });
    registerAdapter({
      name: "unit-tiered-registry",
      type: AdapterType.WEB_API,
      commands: {
        replace: {
          name: "replace",
          description: "late packaged",
          adapter_path: "src/adapters/unit-tiered-registry/replace.yaml",
          source_tier: "packaged",
        },
      },
    });

    const adapter = getAdapter("unit-tiered-registry");
    expect(Object.keys(adapter?.commands ?? {}).sort()).toEqual([
      "keep",
      "replace",
    ]);
    expect(adapter?.commands.replace).toMatchObject({
      description: "user",
      source_tier: "user",
      shadowed_adapter_path: "src/adapters/unit-tiered-registry/replace.yaml",
    });
  });

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

  it("preserves loader-discovered adapter_path when TS registration supplies the runtime func", () => {
    registerAdapter({
      name: "unit-ts-path",
      type: AdapterType.WEB_API,
      commands: {
        search: {
          name: "search",
          description: "Static TS stub",
          adapter_path: "src/adapters/unit-ts-path/web.ts",
          adapterArgs: [{ name: "query", type: "str", positional: true }],
        },
      },
    });

    cli({
      site: "unit-ts-path",
      name: "search",
      description: "Runtime TS command",
      strategy: Strategy.PUBLIC,
      args: [{ name: "query", type: "str", positional: true }],
      func: async () => [],
    });

    expect(getAdapter("unit-ts-path")?.commands.search.adapter_path).toBe(
      "src/adapters/unit-ts-path/web.ts",
    );
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
