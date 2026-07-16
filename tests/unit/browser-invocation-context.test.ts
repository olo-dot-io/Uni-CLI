import { describe, expect, it } from "vitest";

import {
  BrowserInvocationContextError,
  createBrowserInvocationContext,
} from "../../src/browser/invocation-context.js";

describe("createBrowserInvocationContext", () => {
  it("uses the Codex thread as session correlation but mints a request-local broker turn", () => {
    const metadata = {
      "x-codex-turn-metadata": {
        session_id: "codex-session",
        thread_id: "codex-thread",
        turn_id: "codex-turn",
        model: "gpt-test",
      },
      unrelated: "preserved-by-transport",
    };

    const context = createBrowserInvocationContext({
      transport: "mcp-stdio",
      metadata,
    });
    expect(context).toEqual({
      agent_session_id: "codex-thread",
      turn_id: expect.stringMatching(/^invocation:/),
      transport: "mcp-stdio",
      upstream_turn_id: "codex-turn",
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
      turn_id: expect.stringMatching(/^invocation:/),
      upstream_turn_id: "codex-turn",
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

  it("reuses a stable per-Agent CLI identity across processes without merging turns", () => {
    const environment = { CODEX_THREAD_ID: "codex-cli-thread" };
    const first = createBrowserInvocationContext({
      transport: "cli",
      environment,
    });
    const second = createBrowserInvocationContext({
      transport: "cli",
      environment,
    });

    expect(first.agent_session_id).toBe("codex-cli-thread");
    expect(second.agent_session_id).toBe("codex-cli-thread");
    expect(first.turn_id).not.toBe(second.turn_id);
    const anonymousFirst = createBrowserInvocationContext({
      transport: "cli",
      environment: {},
    });
    const anonymousSecond = createBrowserInvocationContext({
      transport: "cli",
      environment: {},
    });
    expect(anonymousFirst.agent_session_id).toMatch(/^cli:anonymous:/);
    expect(anonymousSecond.agent_session_id).toMatch(/^cli:anonymous:/);
    expect(anonymousFirst.agent_session_id).not.toBe(
      anonymousSecond.agent_session_id,
    );
    expect(
      createBrowserInvocationContext({
        transport: "cli",
        environment: {
          CODEX_THREAD_ID: "codex-thread",
          UNICLI_AGENT_SESSION_ID: "declared-agent",
        },
      }).agent_session_id,
    ).toBe("declared-agent");
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
