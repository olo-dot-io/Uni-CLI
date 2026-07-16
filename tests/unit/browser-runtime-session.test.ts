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

  it("cancels a queued mutation without quarantining a target it never reached", async () => {
    const registry = new BrowserRuntimeSessionRegistry();
    const firstTurn = context("shared-agent", "turn-a");
    const secondTurn = context("shared-agent", "turn-b");
    registry.startSession(firstTurn);
    registry.touchSession(secondTurn);
    registry.claimTarget(firstTurn, {
      target_id: "shared-target",
      provider: "managed",
      profile_partition_id: "shared",
      visibility: "hidden",
      lifetime: "session",
    });
    const firstStarted = deferred();
    const firstGate = deferred();
    const first = registry.runTargetMutation(
      firstTurn,
      "shared-target",
      async () => {
        firstStarted.resolve();
        await firstGate.promise;
      },
    );
    await firstStarted.promise;
    const controller = new AbortController();
    let queuedMutationRan = false;
    const cancellation = new Error("cancel queued mutation");
    const queued = registry.runTargetMutation(
      secondTurn,
      "shared-target",
      async () => {
        queuedMutationRan = true;
      },
      controller.signal,
    );

    controller.abort(cancellation);
    expect(registry.status().quarantined_target_ids).toEqual([]);
    expect(registry.targetIdsForContext(secondTurn)).toEqual(["shared-target"]);
    firstGate.resolve();
    await first;
    await expect(queued).rejects.toBe(cancellation);
    expect(queuedMutationRan).toBe(false);
    await expect(
      registry.runTargetMutation(
        secondTurn,
        "shared-target",
        async () => "still-live",
      ),
    ).resolves.toBe("still-live");
  });

  it("reports an ending turn and drains every same-target mutation before completion", async () => {
    const registry = new BrowserRuntimeSessionRegistry();
    const owner = context("draining-agent", "draining-turn");
    registry.startSession(owner);
    registry.claimTarget(owner, {
      target_id: "draining-target",
      provider: "managed",
      profile_partition_id: "shared",
      visibility: "hidden",
      lifetime: "session",
    });
    const firstStarted = deferred();
    const firstGate = deferred();
    const secondStarted = deferred();
    const secondGate = deferred();
    const first = registry.runTargetMutation(
      owner,
      "draining-target",
      async () => {
        firstStarted.resolve();
        await firstGate.promise;
      },
    );
    await firstStarted.promise;
    const second = registry.runTargetMutation(
      owner,
      "draining-target",
      async () => {
        secondStarted.resolve();
        await secondGate.promise;
      },
    );
    firstGate.resolve();
    await first;
    await secondStarted.promise;

    let endSettled = false;
    const ending = registry.endTurn(owner).then((leases) => {
      endSettled = true;
      return leases;
    });
    await Promise.resolve();

    expect(endSettled).toBe(false);
    expect(registry.status()).toMatchObject({
      sessions: [
        {
          agent_session_id: "draining-agent",
          active_turn_ids: [],
          ending_turn_ids: ["draining-turn"],
        },
      ],
      quarantined_target_ids: ["draining-target"],
    });
    expect(registry.targetIdsForContext(owner)).toEqual([]);

    secondGate.resolve();
    await expect(second).rejects.toMatchObject({
      code: "browser_turn_ended",
    });
    await expect(ending).resolves.toEqual([]);
    expect(endSettled).toBe(true);
    expect(registry.status().sessions[0]).toMatchObject({
      active_turn_ids: [],
      ending_turn_ids: [],
    });
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

  it("promotes a handed-off turn target and makes it the destination active target", async () => {
    const registry = new BrowserRuntimeSessionRegistry();
    const source = context("source", "source-turn");
    const destination = context("destination", "destination-turn");
    registry.startSession(source);
    registry.startSession(destination);
    registry.claimTarget(destination, {
      target_id: "destination-old",
      provider: "managed",
      profile_partition_id: "shared",
      visibility: "hidden",
      lifetime: "session",
    });
    registry.claimTarget(source, {
      target_id: "handoff-target",
      provider: "managed",
      profile_partition_id: "shared",
      visibility: "hidden",
      lifetime: "turn",
    });

    const lease = await registry.handoffTarget(
      "handoff-target",
      source,
      destination,
    );

    expect(lease.lifetime).toBe("session");
    expect(registry.targetIdsForSession("destination")).toEqual([
      "handoff-target",
      "destination-old",
    ]);
    await expect(registry.endTurn(destination)).resolves.toEqual([]);
    const nextTurn = context("destination", "destination-next");
    await expect(
      registry.runTargetMutation(nextTurn, "handoff-target", async () => "ok"),
    ).resolves.toBe("ok");
  });

  it("keeps ownership until provider finalization succeeds and then removes the target atomically", async () => {
    const registry = new BrowserRuntimeSessionRegistry();
    const owner = context("owner", "turn-1");
    registry.startSession(owner);
    registry.claimTarget(owner, {
      target_id: "target-finalize",
      provider: "chrome",
      profile_partition_id: "regular-chrome",
      visibility: "background",
      lifetime: "session",
    });
    let releaseProvider: (() => void) | undefined;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const finalizing = registry.finalizeTarget(
      owner,
      "target-finalize",
      () => providerGate,
    );
    const queuedMutation = registry.runTargetMutation(
      owner,
      "target-finalize",
      async () => "late",
    );

    await Promise.resolve();
    expect(registry.status().target_leases).toHaveLength(1);
    releaseProvider?.();
    await expect(finalizing).resolves.toMatchObject({
      target_id: "target-finalize",
    });
    await expect(queuedMutation).rejects.toMatchObject({
      code: "browser_target_not_found",
    });
    expect(registry.status().target_leases).toHaveLength(0);
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

  it("bounds ended request tombstones while preserving recent stale-turn refusal", async () => {
    let now = 1_000;
    const registry = new BrowserRuntimeSessionRegistry({
      now: () => now,
      maxTurnTombstones: 2,
      turnTombstoneTtlMs: 500,
    });
    const first = context("long-lived-agent", "request-1");
    registry.startSession(first);
    await registry.endTurn(first);
    now += 1;
    const second = context("long-lived-agent", "request-2");
    registry.touchSession(second);
    await registry.endTurn(second);
    now += 1;
    const third = context("long-lived-agent", "request-3");
    registry.touchSession(third);
    await registry.endTurn(third);

    expect(registry.status().sessions[0]).toMatchObject({
      ended_turn_tombstone_count: 2,
    });
    expect(() => registry.touchSession(second)).toThrowError(
      expect.objectContaining({ code: "browser_turn_ended" }),
    );
    expect(() => registry.touchSession(third)).toThrowError(
      expect.objectContaining({ code: "browser_turn_ended" }),
    );
    expect(() => registry.touchSession(first)).not.toThrow();

    now += 501;
    expect(() => registry.touchSession(second)).not.toThrow();
    expect(registry.status().sessions[0]).toMatchObject({
      ended_turn_tombstone_count: 0,
    });
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

  it("never reaps a stale session while a target mutation is still in flight", async () => {
    let now = 1_000;
    const registry = new BrowserRuntimeSessionRegistry({ now: () => now });
    const owner = context("long-running-agent", "long-running-turn");
    registry.startSession(owner);
    registry.claimTarget(owner, {
      target_id: "long-running-target",
      provider: "managed",
      profile_partition_id: "default",
      visibility: "hidden",
      lifetime: "session",
    });
    const started = deferred();
    const completion = deferred();
    const mutation = registry.runTargetMutation(
      owner,
      "long-running-target",
      async () => {
        started.resolve();
        await completion.promise;
        return "complete";
      },
    );
    await started.promise;

    now = 10_000;
    expect(registry.isSessionIdle(owner.agent_session_id, 500)).toBe(false);
    await expect(registry.reapIdleSessions(500)).resolves.toEqual([]);

    completion.resolve();
    await expect(mutation).resolves.toBe("complete");
    expect(registry.isSessionIdle(owner.agent_session_id, 500)).toBe(true);
    await expect(registry.reapIdleSessions(500)).resolves.toEqual([
      {
        agent_session_id: owner.agent_session_id,
        target_leases: [
          expect.objectContaining({ target_id: "long-running-target" }),
        ],
      },
    ]);
  });
});
