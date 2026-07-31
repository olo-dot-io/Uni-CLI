import { describe, expect, it } from "vitest";

import { currentBrowserInvocationScope } from "../../src/browser/invocation-scope.js";
import { buildHandler, createMcpBrowserPolicy } from "../../src/mcp/handler.js";
import type { McpTool } from "../../src/mcp/tools.js";

function inspectionTool(seenArgs: Record<string, unknown>[]): McpTool {
  return {
    name: "inspect_invocation",
    description: "Inspect the test invocation",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    execution: { taskSupport: "optional" },
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
  it("preserves the default partition when an argv-derived policy contains undefined fields", () => {
    expect(
      createMcpBrowserPolicy({
        provider: undefined,
        visibility: undefined,
        profilePartitionId: undefined,
      }),
    ).toMatchObject({
      provider: "managed",
      visibility: "hidden",
      profilePartitionId: "default",
    });
  });

  it("applies one trusted Chrome policy across stdio and HTTP without accepting per-call overrides", async () => {
    const seenArgs: Record<string, unknown>[] = [];
    const handler = buildHandler([inspectionTool(seenArgs)], [], {
      browserPolicy: {
        provider: "chrome",
        visibility: "background",
        profilePartitionId: "mcp-chrome",
      },
    });
    const call = (transport: "mcp-stdio" | "mcp-http", session: string) =>
      handler(
        {
          jsonrpc: "2.0",
          id: session,
          method: "tools/call",
          params: {
            name: "inspect_invocation",
            arguments: {
              provider: "managed",
              visibility: "foreground",
              profilePartitionId: "untrusted",
            },
          },
        },
        { transport, mcpSessionId: session },
      );

    const responses = await Promise.all([
      call("mcp-stdio", "stdio-session"),
      call("mcp-http", "http-session"),
    ]);
    const scopes = responses.map((response) => {
      if (!response?.result) {
        throw new Error("MCP invocation inspection returned no result");
      }
      return (
        response.result as {
          structuredContent: { data: Record<string, unknown> };
        }
      ).structuredContent.data;
    });

    expect(seenArgs).toEqual([
      {
        provider: "managed",
        visibility: "foreground",
        profilePartitionId: "untrusted",
      },
      {
        provider: "managed",
        visibility: "foreground",
        profilePartitionId: "untrusted",
      },
    ]);
    expect(scopes).toEqual([
      {
        context: {
          agent_session_id: expect.stringMatching(/^mcp:[a-f0-9]{64}$/),
          turn_id: expect.any(String),
          transport: "mcp-stdio",
        },
        provider: "chrome",
        visibility: "background",
        profilePartitionId: "mcp-chrome",
        isolated: false,
        ephemeral: false,
      },
      {
        context: {
          agent_session_id: expect.stringMatching(/^mcp:[a-f0-9]{64}$/),
          turn_id: expect.any(String),
          transport: "mcp-http",
        },
        provider: "chrome",
        visibility: "background",
        profilePartitionId: "mcp-chrome",
        isolated: false,
        ephemeral: false,
      },
    ]);
    const stdioScope = scopes[0];
    const httpScope = scopes[1];
    if (!stdioScope || !httpScope) throw new Error("missing invocation scope");
    expect(
      (stdioScope.context as { agent_session_id: string }).agent_session_id,
    ).not.toBe(
      (httpScope.context as { agent_session_id: string }).agent_session_id,
    );
  });

  it("rejects an impossible trusted browser policy before serving requests", () => {
    expect(() =>
      buildHandler([], [], {
        browserPolicy: { provider: "chrome", visibility: "hidden" },
      }),
    ).toThrow(/cannot guarantee hidden visibility/);
  });

  it("forwards the request cancellation signal to direct tools and browser scope", async () => {
    const controller = new AbortController();
    const seenSignals: Array<AbortSignal | undefined> = [];
    const tool: McpTool = {
      name: "inspect_signal",
      description: "Inspect the request cancellation signal",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      execution: { taskSupport: "optional" },
      handler: (_args, context) => {
        seenSignals.push(context?.signal);
        return {
          content: [{ type: "text", text: "ok" }],
          structuredContent: {
            type: "json",
            data: {
              scopeOwnsSignal:
                currentBrowserInvocationScope()?.signal === context?.signal,
            },
          },
        };
      },
    };
    const handler = buildHandler([tool]);
    const response = await handler(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "inspect_signal", arguments: {} },
      },
      {
        transport: "mcp-http",
        mcpSessionId: "http-session",
        signal: controller.signal,
      },
    );

    expect(seenSignals).toEqual([controller.signal]);
    if (!response) throw new Error("inspect_signal returned no response");
    expect(
      (
        response.result as {
          structuredContent: { data: { scopeOwnsSignal: boolean } };
        }
      ).structuredContent.data.scopeOwnsSignal,
    ).toBe(true);
  });

  it("correlates Codex metadata without reusing its conversation turn as a request lifecycle", async () => {
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
    if (!response?.result) {
      throw new Error("MCP invocation inspection returned no result");
    }
    expect(
      (
        response.result as {
          structuredContent: { data: unknown };
        }
      ).structuredContent.data,
    ).toEqual({
      context: {
        agent_session_id: expect.stringMatching(/^mcp:[a-f0-9]{64}$/),
        turn_id: expect.stringMatching(/^invocation:/),
        transport: "mcp-stdio",
        upstream_turn_id: "codex-turn",
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
    const readContext = (response: Awaited<ReturnType<typeof call>>) => {
      if (!response?.result) {
        throw new Error("MCP invocation inspection returned no result");
      }
      return (
        response.result as {
          structuredContent: {
            data: { context: { agent_session_id: string; turn_id: string } };
          };
        }
      ).structuredContent.data.context;
    };
    const firstContext = readContext(first);
    const secondContext = readContext(second);

    expect(firstContext.agent_session_id).toMatch(/^mcp:[a-f0-9]{64}$/);
    expect(secondContext.agent_session_id).toBe(firstContext.agent_session_id);
    expect(firstContext.turn_id).not.toBe(secondContext.turn_id);
  });

  it("reuses sessionless HTTP browser identity only within one verified principal", async () => {
    const handler = buildHandler([inspectionTool([])]);
    const call = (principalId: string) =>
      handler(
        {
          jsonrpc: "2.0",
          id: principalId,
          method: "tools/call",
          params: { name: "inspect_invocation", arguments: {} },
        },
        { transport: "mcp-http", principalId },
      );
    const [first, second, isolated] = await Promise.all([
      call("principal-a"),
      call("principal-a"),
      call("principal-b"),
    ]);
    const readSession = (
      response: Awaited<ReturnType<typeof call>>,
    ): string => {
      if (!response?.result) throw new Error("inspection returned no result");
      return (
        response.result as {
          structuredContent: {
            data: { context: { agent_session_id: string } };
          };
        }
      ).structuredContent.data.context.agent_session_id;
    };
    const firstSession = readSession(first);
    expect(firstSession).toMatch(/^mcp:[a-f0-9]{64}$/);
    expect(readSession(second)).toBe(firstSession);
    expect(readSession(isolated)).not.toBe(firstSession);
  });
});
