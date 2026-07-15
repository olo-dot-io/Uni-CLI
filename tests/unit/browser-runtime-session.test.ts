import { describe, expect, it } from "vitest";

import {
  BrowserRuntimeSessionError,
  BrowserRuntimeSessionRegistry,
} from "../../src/browser/runtime-session.js";
import type { BrowserInvocationContext } from "../../src/browser/invocation-context.js";

function context(
  agentSessionId: string,
  turnId: string,
): BrowserInvocationContext {
  return {
    agent_session_id: agentSessionId,
    turn_id: turnId,
    transport: "cli",
  };
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("BrowserRuntimeSessionRegistry", () => {
  it("keeps same-target mutations FIFO while distinct targets run in parallel", async () => {
    const registry = new BrowserRuntimeSessionRegistry();
    const sessionA = context("agent-a", "turn-a");
    const sessionB = context("agent-b", "turn-b");
    registry.startSession(sessionA);
    registry.startSession(sessionB);
    registry.claimTarget(sessionA, {
      target_id: "target-a",
      provider: "managed",
      profile_partition_id: "partition-a",
      visibility: "hidden",
      lifetime: "session",
    });
    registry.claimTarget(sessionB, {
      target_id: "target-b",
      provider: "managed",
      profile_partition_id: "partition-b",
      visibility: "hidden",
      lifetime: "session",
    });

    const firstMutationGate = deferred();
    const firstMutationStarted = deferred();
    const events: string[] = [];
    const first = registry.runTargetMutation(sessionA, "target-a", async () => {
      events.push("a1-start");
      firstMutationStarted.resolve();
      await firstMutationGate.promise;
      events.push("a1-end");
    });
    await firstMutationStarted.promise;
    const second = registry.runTargetMutation(
      sessionA,
      "target-a",
      async () => {
        events.push("a2");
      },
    );
    const parallel = registry.runTargetMutation(
      sessionB,
      "target-b",
      async () => {
        events.push("b");
      },
    );

    await parallel;
    expect(events).toEqual(["a1-start", "b"]);
    firstMutationGate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["a1-start", "b", "a1-end", "a2"]);
  });

  it("requires explicit handoff before another session can mutate a target", async () => {
    const registry = new BrowserRuntimeSessionRegistry();
    const sessionA = context("agent-a", "turn-a");
    const sessionB = context("agent-b", "turn-b");
    registry.startSession(sessionA);
    registry.startSession(sessionB);
    registry.claimTarget(sessionA, {
      target_id: "shared-tab",
      provider: "chrome",
      profile_partition_id: "regular-chrome",
      visibility: "background",
      lifetime: "session",
    });

    await expect(
      registry.runTargetMutation(sessionB, "shared-tab", async () => {}),
    ).rejects.toMatchObject({ code: "browser_target_owned" });

    await registry.handoffTarget("shared-tab", sessionA, sessionB);
    await expect(
      registry.runTargetMutation(sessionA, "shared-tab", async () => {}),
    ).rejects.toMatchObject({ code: "browser_target_owned" });
    await expect(
      registry.runTargetMutation(sessionB, "shared-tab", async () => "ok"),
    ).resolves.toBe("ok");
  });

  it("tombstones ended sessions and turns until an explicit lifecycle start", async () => {
    const registry = new BrowserRuntimeSessionRegistry();
    const firstTurn = context("agent-a", "turn-a");
    registry.startSession(firstTurn);
    registry.claimTarget(firstTurn, {
      target_id: "target-a",
      provider: "managed",
      profile_partition_id: "default",
      visibility: "hidden",
      lifetime: "session",
    });

    await registry.endTurn(firstTurn);
    await expect(
      registry.runTargetMutation(firstTurn, "target-a", async () => {}),
    ).rejects.toMatchObject({ code: "browser_turn_ended" });

    const secondTurn = context("agent-a", "turn-b");
    await expect(
      registry.runTargetMutation(secondTurn, "target-a", async () => {}),
    ).resolves.toBeUndefined();

    const reclaimed = await registry.endSession("agent-a");
    expect(reclaimed.map((lease) => lease.target_id)).toEqual(["target-a"]);
    expect(() => registry.touchSession(secondTurn)).toThrowError(
      BrowserRuntimeSessionError,
    );
    expect(() => registry.touchSession(secondTurn)).toThrowError(
      expect.objectContaining({ code: "browser_session_ended" }),
    );

    registry.startSession(secondTurn);
    expect(registry.status().sessions).toEqual([
      expect.objectContaining({
        agent_session_id: "agent-a",
        active_turn_ids: ["turn-b"],
        target_ids: [],
      }),
    ]);
  });

  it("reclaims only idle sessions and preserves a touched neighbor", async () => {
    let now = 1_000;
    const registry = new BrowserRuntimeSessionRegistry({ now: () => now });
    const sessionA = context("agent-a", "turn-a");
    const sessionB = context("agent-b", "turn-b");
    registry.startSession(sessionA);
    registry.startSession(sessionB);
    registry.claimTarget(sessionA, {
      target_id: "target-a",
      provider: "managed",
      profile_partition_id: "default",
      visibility: "hidden",
      lifetime: "session",
    });
    registry.claimTarget(sessionB, {
      target_id: "target-b",
      provider: "managed",
      profile_partition_id: "default",
      visibility: "hidden",
      lifetime: "session",
    });

    now = 1_400;
    registry.touchSession(sessionB);
    now = 1_700;
    const reaped = await registry.reapIdleSessions(500);

    expect(reaped).toEqual([
      {
        agent_session_id: "agent-a",
        target_leases: [expect.objectContaining({ target_id: "target-a" })],
      },
    ]);
    expect(registry.status().sessions).toEqual([
      expect.objectContaining({
        agent_session_id: "agent-b",
        target_ids: ["target-b"],
      }),
    ]);
  });
});
