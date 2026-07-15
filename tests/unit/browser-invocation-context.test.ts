import { describe, expect, it } from "vitest";

import {
  BrowserInvocationContextError,
  createBrowserInvocationContext,
} from "../../src/browser/invocation-context.js";

describe("createBrowserInvocationContext", () => {
  it("uses Codex thread and turn metadata without merging metadata into arguments", () => {
    const metadata = {
      "x-codex-turn-metadata": {
        session_id: "codex-session",
        thread_id: "codex-thread",
        turn_id: "codex-turn",
        model: "gpt-test",
      },
      unrelated: "preserved-by-transport",
    };

    expect(
      createBrowserInvocationContext({
        transport: "mcp-stdio",
        metadata,
      }),
    ).toEqual({
      agent_session_id: "codex-thread",
      turn_id: "codex-turn",
      transport: "mcp-stdio",
    });
    expect(metadata).toEqual({
      "x-codex-turn-metadata": {
        session_id: "codex-session",
        thread_id: "codex-thread",
        turn_id: "codex-turn",
        model: "gpt-test",
      },
      unrelated: "preserved-by-transport",
    });
  });

  it("accepts the canonical JSON-string metadata projection", () => {
    expect(
      createBrowserInvocationContext({
        transport: "mcp-http",
        metadata: {
          "x-codex-turn-metadata": JSON.stringify({
            session_id: "codex-session",
            thread_id: "codex-thread",
            turn_id: "codex-turn",
          }),
        },
      }),
    ).toMatchObject({
      agent_session_id: "codex-thread",
      turn_id: "codex-turn",
    });
  });

  it("uses generic MCP session identity and mints a distinct turn", () => {
    const first = createBrowserInvocationContext({
      transport: "mcp-http",
      mcpSessionId: "mcp-session",
    });
    const second = createBrowserInvocationContext({
      transport: "mcp-http",
      mcpSessionId: "mcp-session",
    });

    expect(first.agent_session_id).toBe("mcp-session");
    expect(second.agent_session_id).toBe("mcp-session");
    expect(first.turn_id).not.toBe(second.turn_id);
  });

  it("lets an explicit CLI identity override ambient metadata", () => {
    expect(
      createBrowserInvocationContext({
        transport: "cli",
        agentSessionId: "cli-session",
        turnId: "cli-turn",
        profilePartitionId: "team-login",
        metadata: {
          "x-codex-turn-metadata": {
            thread_id: "ignored-thread",
            turn_id: "ignored-turn",
          },
        },
      }),
    ).toEqual({
      agent_session_id: "cli-session",
      turn_id: "cli-turn",
      transport: "cli",
      profile_partition_id: "team-login",
    });
  });

  it("rejects malformed trusted metadata instead of silently minting identity", () => {
    expect(() =>
      createBrowserInvocationContext({
        transport: "mcp-stdio",
        metadata: { "x-codex-turn-metadata": "{" },
      }),
    ).toThrowError(BrowserInvocationContextError);
    expect(() =>
      createBrowserInvocationContext({
        transport: "mcp-stdio",
        metadata: {
          "x-codex-turn-metadata": { thread_id: "thread\u0000id" },
        },
      }),
    ).toThrowError(/control characters/);
  });
});
