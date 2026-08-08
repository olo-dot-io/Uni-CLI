import { beforeAll, describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAdaptersFromDir } from "../../src/discovery/loader.js";
import { getAdapter, resolveCommand } from "../../src/registry.js";
import { loadExternalClis } from "../../src/hub/index.js";
import { evalTemplate } from "../../src/engine/template.js";
import type { PipelineContext } from "../../src/engine/executor.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("provider-native social surfaces", () => {
  beforeAll(() => {
    loadAdaptersFromDir(join(ROOT, "src", "adapters"));
  });

  it("registers the full official Zhihu CLI business surface", () => {
    const expected = [
      "native-answer",
      "native-capabilities",
      "native-favorite-items",
      "native-favorite-lists",
      "native-favorites-recent",
      "native-global-search",
      "native-hot",
      "native-my-contents",
      "native-my-followees",
      "native-search",
    ];
    const actual = Object.keys(getAdapter("zhihu")?.commands ?? {}).filter(
      (name) => name.startsWith("native-"),
    );
    expect(actual.sort()).toEqual(expected);

    const command = resolveCommand("zhihu", "native-search")?.command;
    expect(command).toMatchObject({
      execution_operator: "native-cli",
      operation_effect: "read",
      auth_requirement: "required",
      executables: ["zhihu-cli"],
    });
  });

  it("resolves the official Zhihu installation path and explicit override", () => {
    const step = resolveCommand("zhihu", "native-capabilities")?.command
      .pipeline?.[0] as { exec: { command: string } };
    const previous = process.env.ZHIHU_CLI;
    process.env.ZHIHU_CLI = "/tmp/official-zhihu-cli";
    try {
      expect(
        evalTemplate(step.exec.command, {
          args: {},
          data: [],
        } as PipelineContext),
      ).toBe("/tmp/official-zhihu-cli");
    } finally {
      if (previous === undefined) delete process.env.ZHIHU_CLI;
      else process.env.ZHIHU_CLI = previous;
    }
  });

  it("registers official native alternatives for X, Lark, and Bluesky", () => {
    const expected = new Map([
      ["twitter.native-search", "xurl"],
      ["twitter.native-post", "xurl"],
      ["lark.native-message-search", "lark-cli"],
      ["lark.native-doc-fetch", "lark-cli"],
      ["bluesky.native-resolve", "goat"],
      ["bluesky.native-post", "goat"],
    ]);
    for (const [qualifiedName, executable] of expected) {
      const [site, name] = qualifiedName.split(".");
      expect(resolveCommand(site, name)?.command).toMatchObject({
        execution_operator: "native-cli",
        executables: [executable],
      });
    }
  });

  it("keeps Slack content commands off the app-development CLI", () => {
    const commands = Object.keys(getAdapter("slack")?.commands ?? {});
    expect(commands.sort()).toEqual([
      "channels",
      "messages",
      "post",
      "search",
      "send",
      "status",
      "users",
    ]);
    for (const command of commands) {
      expect(resolveCommand("slack", command)?.adapter.type).toBe("web-api");
    }
    expect(resolveCommand("slack", "search")?.command.execution_operator).toBe(
      "structured-api",
    );
  });

  it("catalogues local first-party CLI and MCP server entry points", () => {
    const native = loadExternalClis().filter(
      (entry) => entry.provenance === "official",
    );
    expect(native).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "xurl", native_surface: "cli+mcp" }),
        expect.objectContaining({ name: "goat", native_surface: "cli" }),
        expect.objectContaining({
          name: "lark-mcp",
          native_surface: "mcp-server",
        }),
        expect.objectContaining({
          name: "devvit-mcp",
          provider_scope: "app-development",
        }),
        expect.objectContaining({
          name: "dingtalk-mcp",
          provider_scope: "workspace-content",
        }),
      ]),
    );
  });
});
