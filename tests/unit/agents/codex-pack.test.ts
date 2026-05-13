import { describe, expect, it } from "vitest";

import {
  buildCodexPack,
  formatCodexPack,
} from "../../../src/agents/codex-pack.js";
import { AdapterType, type AdapterManifest } from "../../../src/types.js";

function fixtureAdapters(): AdapterManifest[] {
  return [
    {
      name: "readsite",
      type: AdapterType.WEB_API,
      category: "reference",
      domain: "read.example.com",
      commands: {
        search: {
          name: "search",
          description: "Search read-only content",
          adapter_path: "src/adapters/readsite/search.yaml",
          adapterArgs: [{ name: "query", type: "str", required: true }],
          pipeline: [{ fetch: { url: "https://read.example.com/search" } }],
        },
      },
    },
    {
      name: "writesite",
      type: AdapterType.WEB_API,
      category: "social",
      domain: "write.example.com",
      commands: {
        post: {
          name: "post",
          description: "Post a message",
          adapter_path: "src/adapters/writesite/post.yaml",
          adapterArgs: [{ name: "text", type: "str", required: true }],
          pipeline: [
            {
              fetch: {
                url: "https://write.example.com/post",
                method: "POST",
              },
            },
          ],
        },
      },
    },
  ];
}

describe("Codex install pack", () => {
  it("emits compact deferred MCP config and measured smoke tasks", () => {
    const pack = buildCodexPack({
      version: "0.220.0-test",
      date: "2026-05-13",
      adapters: fixtureAdapters(),
    });

    expect(pack.mcp_config.args).toEqual([
      "-y",
      "@zenalexa/unicli",
      "mcp",
      "serve",
      "--profile",
      "deferred",
    ]);
    expect(pack.default_surface).toBe("native_cli_plus_deferred_mcp");
    expect(pack.tool_exposure.default_tools).toBe(4);
    expect(pack.tool_exposure.deferred_stubs).toBe(2);
    expect(pack.contract_summary.schema_version).toBe("command-contract.v1");
    expect(pack.contract_summary.read_only).toBe(1);
    expect(pack.contract_summary.write_or_destructive).toBe(1);
    expect(pack.smoke_tasks.map((task) => task.command)).toEqual([
      'unicli search "hackernews top stories"',
      "unicli mcp health --json",
      "npx -y @zenalexa/unicli mcp serve --profile deferred",
    ]);
    expect(pack.token_budget.estimated_tokens).toBeLessThan(1200);
  });

  it("formats an AGENTS-ready pack without enumerating every command", () => {
    const text = formatCodexPack(
      buildCodexPack({
        version: "0.220.0-test",
        date: "2026-05-13",
        adapters: fixtureAdapters(),
      }),
    );

    expect(text).toContain("[mcp_servers.unicli]");
    expect(text).toContain('--profile", "deferred');
    expect(text).toContain("native CLI first");
    expect(text).toContain("CommandContract");
    expect(text).not.toContain("unicli readsite search");
    expect(text).not.toContain("unicli writesite post");
  });
});
