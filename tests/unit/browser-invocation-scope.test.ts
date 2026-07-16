import { describe, expect, it } from "vitest";

import { createBrowserInvocationContext } from "../../src/browser/invocation-context.js";
import {
  BrowserInvocationScopeError,
  createBrowserInvocationScope,
  currentBrowserInvocationScope,
  registerBrowserTurnParticipant,
  registerBrowserTurnFinalizer,
  runBrowserInvocation,
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
      runBrowserInvocation(left, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return currentBrowserInvocationScope();
      }),
      runBrowserInvocation(right, async () => {
        await Promise.resolve();
        return currentBrowserInvocationScope();
      }),
    ]);

    expect(leftSeen).toBe(left);
    expect(rightSeen).toBe(right);
    expect(currentBrowserInvocationScope()).toBeUndefined();
  });

  it("defaults distinct Agents to one hidden managed runtime partition", () => {
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
      profilePartitionId: "default",
      isolated: false,
      ephemeral: false,
    });
    expect(
      createBrowserInvocationScope({
        context: context("another-agent", "another-turn"),
      }).profilePartitionId,
    ).toBe("default");
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

  it("rejects conflicting managed profile sources before runtime acquisition", () => {
    expect(() =>
      createBrowserInvocationScope({
        context: context("agent", "turn"),
        provider: "managed",
        ephemeral: true,
        profileId: "persistent-profile",
      }),
    ).toThrowError(/ephemeral managed browser cannot also select/);
  });

  it("rejects managed-only isolation flags on Chrome and remote providers", () => {
    for (const provider of ["chrome", "remote"] as const) {
      expect(() =>
        createBrowserInvocationScope({
          context: context(`${provider}-agent`, `${provider}-turn`),
          provider,
          visibility: provider === "chrome" ? "background" : "hidden",
          isolated: true,
        }),
      ).toThrowError(/managed-only isolated-context option/);
    }
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

  it("preserves an explicitly thrown undefined value after finalization", async () => {
    const scope = createBrowserInvocationScope({
      context: context("throwing-agent", "throwing-turn"),
    });
    let finalized = false;

    try {
      await runBrowserInvocation(scope, async () => {
        registerBrowserTurnFinalizer(
          "throwing-agent\0throwing-turn",
          async () => {
            finalized = true;
          },
        );
        throw undefined;
      });
      throw new Error("Expected runBrowserInvocation to preserve the failure");
    } catch (error) {
      expect(error).toBeUndefined();
    }
    expect(finalized).toBe(true);
  });

  it("retries one retryable lifecycle failure without repeating participant preparation", async () => {
    const scope = createBrowserInvocationScope({
      context: context("retry-agent", "retry-turn"),
    });
    const events: string[] = [];
    let finalizerAttempts = 0;

    await runBrowserInvocation(scope, async () => {
      await registerBrowserTurnParticipant(
        "retry-agent\0retry-turn",
        async () => {
          events.push("prepare");
        },
        async () => {
          finalizerAttempts += 1;
          events.push(`finalize:${String(finalizerAttempts)}`);
          if (finalizerAttempts === 1) {
            throw Object.assign(new Error("transient lifecycle failure"), {
              retryable: true,
            });
          }
        },
      );
    });

    expect(events).toEqual(["prepare", "finalize:1", "finalize:2"]);
  });

  it("allows an explicit lifecycle retry after the bounded invocation retry is exhausted", async () => {
    const scope = createBrowserInvocationScope({
      context: context("later-retry-agent", "later-retry-turn"),
    });
    const events: string[] = [];
    let finalizerAttempts = 0;
    let handle!: NonNullable<
      Awaited<ReturnType<typeof registerBrowserTurnParticipant>>
    >;

    await expect(
      runBrowserInvocation(scope, async () => {
        handle = (await registerBrowserTurnParticipant(
          "later-retry-agent\0later-retry-turn",
          async () => {
            events.push("prepare");
          },
          async () => {
            finalizerAttempts += 1;
            events.push(`finalize:${String(finalizerAttempts)}`);
            if (finalizerAttempts < 3) {
              throw Object.assign(new Error("retry lifecycle later"), {
                retryable: true,
              });
            }
          },
        ))!;
      }),
    ).rejects.toMatchObject({ retryable: true });

    await expect(handle.finalize()).resolves.toBeUndefined();
    expect(events).toEqual([
      "prepare",
      "finalize:1",
      "finalize:2",
      "finalize:3",
    ]);
  });

  it("starts finalization on cancellation without overwriting a later authoritative fulfillment", async () => {
    const controller = new AbortController();
    const cancellation = new Error("MCP task cancelled");
    cancellation.name = "AbortError";
    const scope = createBrowserInvocationScope({
      context: context("cancelled-agent", "cancelled-turn"),
      signal: controller.signal,
    });
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markRegistered!: () => void;
    const registered = new Promise<void>((resolve) => {
      markRegistered = resolve;
    });
    let markFinalized!: () => void;
    const finalized = new Promise<void>((resolve) => {
      markFinalized = resolve;
    });

    const execution = runBrowserInvocation(scope, async () => {
      registerBrowserTurnFinalizer(
        "cancelled-agent\0cancelled-turn",
        async () => {
          markFinalized();
        },
      );
      markRegistered();
      await wait;
      return 42;
    });
    await registered;
    controller.abort(cancellation);
    await finalized;
    release();

    await expect(execution).resolves.toBe(42);
  });

  it("drains a participant registered while the same turn is preparing", async () => {
    const scope = createBrowserInvocationScope({
      context: context("late-participant-agent", "late-participant-turn"),
    });
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });

    await runBrowserInvocation(scope, async () => {
      const first = await registerBrowserTurnParticipant(
        "late-participant-agent\0late-participant-turn",
        async () => {
          events.push("prepare:first:start");
          markFirstStarted();
          await firstGate;
          events.push("prepare:first:end");
        },
        async () => {
          events.push("finalize");
        },
      );
      const finalizing = first!.finalize();
      await firstStarted;
      await registerBrowserTurnParticipant(
        "late-participant-agent\0late-participant-turn",
        async () => {
          events.push("prepare:late");
        },
        async () => {
          events.push("finalize:replacement");
        },
      );
      releaseFirst();
      await finalizing;
    });

    expect(events).toEqual([
      "prepare:first:start",
      "prepare:first:end",
      "prepare:late",
      "finalize:replacement",
    ]);
  });

  it("never downgrades an explicit session finalizer when a turn participant arrives late", async () => {
    const scope = createBrowserInvocationScope({
      context: context("session-close-agent", "session-close-turn"),
    });
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });

    await runBrowserInvocation(scope, async () => {
      const first = await registerBrowserTurnParticipant(
        "session-close-agent\0session-close-turn",
        async () => {
          events.push("prepare:first:start");
          markFirstStarted();
          await firstGate;
          events.push("prepare:first:end");
        },
        async () => {
          events.push("finalize:turn:first");
        },
      );
      const finalizing = first!.finalize(async () => {
        events.push("finalize:session");
      });
      await firstStarted;
      await registerBrowserTurnParticipant(
        "session-close-agent\0session-close-turn",
        async () => {
          events.push("prepare:late");
        },
        async () => {
          events.push("finalize:turn:late");
        },
      );
      releaseFirst();
      await finalizing;
    });

    expect(events).toEqual([
      "prepare:first:start",
      "prepare:first:end",
      "prepare:late",
      "finalize:session",
    ]);
  });

  it("rejects and prepares a detached participant after invocation finalization", async () => {
    const scope = createBrowserInvocationScope({
      context: context("detached-agent", "detached-turn"),
    });
    const events: string[] = [];
    let releaseDetached!: () => void;
    const detachedGate = new Promise<void>((resolve) => {
      releaseDetached = resolve;
    });
    let detached!: Promise<void>;

    await runBrowserInvocation(scope, async () => {
      await registerBrowserTurnParticipant(
        "detached-agent\0detached-turn",
        async () => {
          events.push("prepare:owned");
        },
        async () => {
          events.push("finalize:owned");
        },
      );
      detached = (async () => {
        await detachedGate;
        await registerBrowserTurnParticipant(
          "detached-agent\0another-turn",
          async () => {
            events.push("prepare:detached");
          },
          async () => {
            events.push("finalize:detached");
          },
        );
      })();
    });

    releaseDetached();
    await expect(detached).rejects.toMatchObject({
      code: "browser_turn_ended",
      retryable: false,
    });
    expect(events).toEqual([
      "prepare:owned",
      "finalize:owned",
      "prepare:detached",
    ]);
  });
});
