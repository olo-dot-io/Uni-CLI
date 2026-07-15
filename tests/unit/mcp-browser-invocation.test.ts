import { describe, expect, it } from "vitest";

import { currentBrowserInvocationScope } from "../../src/browser/invocation-scope.js";
import { buildHandler } from "../../src/mcp/handler.js";
import type { McpTool } from "../../src/mcp/tools.js";

function inspectionTool(seenArgs: Record<string, unknown>[]): McpTool {
  return {
    name: "inspect_invocation",
    description: "Inspect the test invocation",
    inputSchema: { type: "object", properties: {} },
    handler: (args) => {
      seenArgs.push(args);
      const scope = currentBrowserInvocationScope();
      return {
        content: [{ type: "text", text: JSON.stringify(scope) }],
        structuredContent: { type: "json", data: scope },
      };
    },
  };
}

describe("MCP browser invocation propagation", () => {
  it("uses Codex thread/turn metadata without merging trusted metadata into tool arguments", async () => {
    const seenArgs: Record<string, unknown>[] = [];
    const handler = buildHandler([inspectionTool(seenArgs)]);
    const response = await handler(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "inspect_invocation",
          arguments: { requested: true },
          _meta: {
            "x-codex-turn-metadata": {
              session_id: "codex-session",
              thread_id: "codex-thread",
              turn_id: "codex-turn",
            },
          },
        },
      },
      { transport: "mcp-stdio", mcpSessionId: "stdio-connection" },
    );

    expect(seenArgs).toEqual([{ requested: true }]);
    expect(
      (
        response?.result as {
          structuredContent: { data: unknown };
        }
      ).structuredContent.data,
    ).toEqual({
      context: {
        agent_session_id: "codex-thread",
        turn_id: "codex-turn",
        transport: "mcp-stdio",
      },
      provider: "managed",
      visibility: "hidden",
      profilePartitionId: "default",
      isolated: false,
      ephemeral: false,
    });
  });

  it("uses the Streamable HTTP MCP session across calls and mints distinct turns", async () => {
    const handler = buildHandler([inspectionTool([])]);
    const call = () =>
      handler(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "inspect_invocation", arguments: {} },
        },
        { transport: "mcp-http", mcpSessionId: "http-session" },
      );
    const [first, second] = await Promise.all([call(), call()]);
    const readContext = (response: Awaited<ReturnType<typeof call>>) =>
      (
        response?.result as {
          structuredContent: {
            data: { context: { agent_session_id: string; turn_id: string } };
          };
        }
      ).structuredContent.data.context;
    const firstContext = readContext(first);
    const secondContext = readContext(second);

    expect(firstContext.agent_session_id).toBe("http-session");
    expect(secondContext.agent_session_id).toBe("http-session");
    expect(firstContext.turn_id).not.toBe(secondContext.turn_id);
  });
});
