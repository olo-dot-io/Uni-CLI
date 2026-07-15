import { describe, expect, it } from "vitest";

import { createBrowserInvocationContext } from "../../src/browser/invocation-context.js";
import {
  BrowserInvocationScopeError,
  createBrowserInvocationScope,
  currentBrowserInvocationScope,
  registerBrowserTurnFinalizer,
  runBrowserInvocation,
  runWithBrowserInvocationScope,
} from "../../src/browser/invocation-scope.js";

function context(session: string, turn: string) {
  return createBrowserInvocationContext({
    transport: "cli",
    agentSessionId: session,
    turnId: turn,
  });
}

describe("browser invocation async scope", () => {
  it("keeps concurrent Agent calls isolated across asynchronous boundaries", async () => {
    const left = createBrowserInvocationScope({
      context: context("agent-left", "turn-left"),
      provider: "managed",
      profilePartitionId: "shared-login",
    });
    const right = createBrowserInvocationScope({
      context: context("agent-right", "turn-right"),
      provider: "chrome",
      visibility: "background",
    });

    const [leftSeen, rightSeen] = await Promise.all([
      runWithBrowserInvocationScope(left, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return currentBrowserInvocationScope();
      }),
      runWithBrowserInvocationScope(right, async () => {
        await Promise.resolve();
        return currentBrowserInvocationScope();
      }),
    ]);

    expect(leftSeen).toBe(left);
    expect(rightSeen).toBe(right);
    expect(currentBrowserInvocationScope()).toBeUndefined();
  });

  it("defaults local automation to a hidden managed provider", () => {
    expect(
      createBrowserInvocationScope({ context: context("agent", "turn") }),
    ).toEqual({
      context: {
        agent_session_id: "agent",
        turn_id: "turn",
        transport: "cli",
      },
      provider: "managed",
      visibility: "hidden",
      profilePartitionId: "agent",
      isolated: false,
      ephemeral: false,
    });
  });

  it("refuses provider and visibility escalation instead of falling forward", () => {
    expect(() =>
      createBrowserInvocationScope({
        context: context("agent", "turn"),
        provider: "managed",
        visibility: "foreground",
      }),
    ).toThrowError(BrowserInvocationScopeError);
    expect(() =>
      createBrowserInvocationScope({
        context: context("agent", "turn"),
        provider: "chrome",
        visibility: "hidden",
      }),
    ).toThrowError(/cannot guarantee hidden/);
  });

  it("rejects a partition that conflicts with trusted invocation metadata", () => {
    const trusted = createBrowserInvocationContext({
      transport: "mcp-http",
      agentSessionId: "agent",
      turnId: "turn",
      profilePartitionId: "trusted-partition",
    });
    expect(() =>
      createBrowserInvocationScope({
        context: trusted,
        profilePartitionId: "tool-argument-partition",
      }),
    ).toThrowError(/conflicts/);
  });

  it("finalizes a shared turn exactly once after the owning async invocation", async () => {
    const scope = createBrowserInvocationScope({
      context: context("agent", "turn"),
    });
    const finalized: string[] = [];

    const value = await runBrowserInvocation(scope, async () => {
      registerBrowserTurnFinalizer("agent\0turn", async () => {
        finalized.push("first");
      });
      registerBrowserTurnFinalizer("agent\0turn", async () => {
        finalized.push("replacement");
      });
      expect(finalized).toEqual([]);
      return 42;
    });

    expect(value).toBe(42);
    expect(finalized).toEqual(["replacement"]);
  });
});
