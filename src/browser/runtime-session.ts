/**
 * @owner       src/browser/runtime-session.ts
 * @does        Own browser Agent-session lifecycle, turn cancellation, target leases, atomic finalization, handoff, TTL reclamation, and per-target mutation ordering.
 * @needs       src/browser/invocation-context.ts
 * @feeds       src/browser/runtime-broker.ts, src/browser/protocol.ts
 * @breaks      BrowserRuntimeSessionError on ended/unknown sessions, ended turns, ownership conflicts, and invalid leases.
 * @invariants  A target has one mutating owner; ended identities cannot resurrect without startSession; mutations are FIFO per target and parallel across targets.
 * @side-effects Mutates broker-local session, tombstone, target, queue, and AbortController state.
 * @perf        O(1) session/target operations amortized; status and idle reaping are O(sessions + targets).
 * @concurrency Linearizable within one JavaScript event loop; target queues serialize mutation while distinct target queues progress independently.
 * @test        tests/unit/browser-runtime-session.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

import type { BrowserInvocationContext } from "./invocation-context.js";

export type BrowserProviderKind = "managed" | "chrome" | "remote";
export type BrowserVisibility = "hidden" | "background" | "foreground";
export type BrowserTargetLifetime = "turn" | "session";

export interface BrowserTargetLeaseInput {
  target_id: string;
  provider: BrowserProviderKind;
  profile_partition_id: string;
  visibility: BrowserVisibility;
  lifetime: BrowserTargetLifetime;
}

export interface BrowserTargetLease extends BrowserTargetLeaseInput {
  owner_session_id: string;
  owner_turn_id: string;
  claimed_at: string;
}

export interface BrowserRuntimeSessionStatus {
  agent_session_id: string;
  active_turn_ids: string[];
  target_ids: string[];
  last_activity_ms: number;
}

export interface BrowserRuntimeRegistryStatus {
  sessions: BrowserRuntimeSessionStatus[];
  tombstoned_session_ids: string[];
  target_leases: BrowserTargetLease[];
}

export interface ReapedBrowserSession {
  agent_session_id: string;
  target_leases: BrowserTargetLease[];
}

type BrowserRuntimeSessionErrorCode =
  | "browser_session_not_started"
  | "browser_session_ended"
  | "browser_session_ending"
  | "browser_turn_ended"
  | "browser_target_invalid"
  | "browser_target_owned"
  | "browser_target_not_found";

export class BrowserRuntimeSessionError extends Error {
  readonly retryable = false;
  readonly suggestion: string;

  constructor(
    readonly code: BrowserRuntimeSessionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BrowserRuntimeSessionError";
    this.suggestion = suggestionFor(code);
  }
}

interface LiveTurn {
  controller: AbortController;
}

interface LiveSession {
  generation: number;
  lastActivityMs: number;
  turns: Map<string, LiveTurn>;
  endedTurnIds: Set<string>;
}

interface OwnedTargetLease {
  publicLease: BrowserTargetLease;
  ownerGeneration: number;
}

interface SessionRegistryOptions {
  now?: () => number;
  tombstoneTtlMs?: number;
  maxTombstones?: number;
}

const DEFAULT_TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_TOMBSTONES = 4096;

class TargetMutationQueue {
  private tail = Promise.resolve();

  async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export class BrowserRuntimeSessionRegistry {
  private readonly now: () => number;
  private readonly tombstoneTtlMs: number;
  private readonly maxTombstones: number;
  private readonly sessions = new Map<string, LiveSession>();
  private readonly sessionTombstones = new Map<string, number>();
  private readonly endingSessionIds = new Set<string>();
  private readonly targets = new Map<string, OwnedTargetLease>();
  private readonly targetQueues = new Map<string, TargetMutationQueue>();
  private nextGeneration = 1;

  constructor(options: SessionRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.tombstoneTtlMs = options.tombstoneTtlMs ?? DEFAULT_TOMBSTONE_TTL_MS;
    this.maxTombstones = options.maxTombstones ?? DEFAULT_MAX_TOMBSTONES;
  }

  startSession(context: BrowserInvocationContext): void {
    validateContext(context);
    this.purgeTombstones();
    if (this.endingSessionIds.has(context.agent_session_id)) {
      throw new BrowserRuntimeSessionError(
        "browser_session_ending",
        `Browser session "${context.agent_session_id}" is still releasing its targets`,
      );
    }
    const existing = this.sessions.get(context.agent_session_id);
    if (existing) {
      this.touchLiveSession(existing, context.turn_id);
      return;
    }
    this.sessionTombstones.delete(context.agent_session_id);
    this.sessions.set(context.agent_session_id, {
      generation: this.nextGeneration++,
      lastActivityMs: this.now(),
      turns: new Map([
        [context.turn_id, { controller: new AbortController() }],
      ]),
      endedTurnIds: new Set(),
    });
  }

  touchSession(context: BrowserInvocationContext): void {
    validateContext(context);
    const session = this.requireLiveSession(context.agent_session_id);
    this.touchLiveSession(session, context.turn_id);
  }

  claimTarget(
    context: BrowserInvocationContext,
    input: BrowserTargetLeaseInput,
  ): BrowserTargetLease {
    const session = this.requireLiveContext(context);
    validateTargetLeaseInput(input);
    const existing = this.targets.get(input.target_id);
    if (existing) {
      if (
        existing.publicLease.owner_session_id === context.agent_session_id &&
        existing.ownerGeneration === session.generation
      ) {
        return existing.publicLease;
      }
      throw targetOwnedError(
        input.target_id,
        existing.publicLease.owner_session_id,
      );
    }
    const publicLease: BrowserTargetLease = {
      ...input,
      owner_session_id: context.agent_session_id,
      owner_turn_id: context.turn_id,
      claimed_at: new Date(this.now()).toISOString(),
    };
    this.targets.set(input.target_id, {
      publicLease,
      ownerGeneration: session.generation,
    });
    this.targetQueues.set(input.target_id, new TargetMutationQueue());
    return publicLease;
  }

  async handoffTarget(
    targetId: string,
    from: BrowserInvocationContext,
    to: BrowserInvocationContext,
  ): Promise<BrowserTargetLease> {
    const queue = this.requireTargetQueue(targetId);
    return queue.enqueue(async () => {
      const source = this.requireLiveContext(from);
      const destination = this.requireLiveContext(to);
      const lease = this.requireTargetLease(targetId);
      assertTargetOwner(lease, from.agent_session_id, source.generation);
      lease.publicLease = {
        ...lease.publicLease,
        owner_session_id: to.agent_session_id,
        owner_turn_id: to.turn_id,
        claimed_at: new Date(this.now()).toISOString(),
      };
      lease.ownerGeneration = destination.generation;
      return lease.publicLease;
    });
  }

  async runTargetMutation<T>(
    context: BrowserInvocationContext,
    targetId: string,
    mutation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.requireLiveContext(context);
    const queue = this.requireTargetQueue(targetId);
    return queue.enqueue(async () => {
      const session = this.requireLiveContext(context);
      const lease = this.requireTargetLease(targetId);
      assertTargetOwner(lease, context.agent_session_id, session.generation);
      const turn = this.requireLiveTurn(session, context.turn_id);
      if (turn.controller.signal.aborted) {
        throw turnEndedError(context.turn_id);
      }
      return mutation(turn.controller.signal);
    });
  }

  async finalizeTarget(
    context: BrowserInvocationContext,
    targetId: string,
    finalize: (signal: AbortSignal) => Promise<void>,
  ): Promise<BrowserTargetLease> {
    this.requireLiveContext(context);
    const queue = this.requireTargetQueue(targetId);
    return queue.enqueue(async () => {
      const session = this.requireLiveContext(context);
      const lease = this.requireTargetLease(targetId);
      assertTargetOwner(lease, context.agent_session_id, session.generation);
      const turn = this.requireLiveTurn(session, context.turn_id);
      if (turn.controller.signal.aborted) {
        throw turnEndedError(context.turn_id);
      }
      await finalize(turn.controller.signal);
      if (this.targets.get(targetId) !== lease) {
        throw new BrowserRuntimeSessionError(
          "browser_target_not_found",
          `Browser target "${targetId}" changed ownership during finalization`,
        );
      }
      this.targets.delete(targetId);
      this.targetQueues.delete(targetId);
      return lease.publicLease;
    });
  }

  async endTurn(
    context: BrowserInvocationContext,
  ): Promise<BrowserTargetLease[]> {
    const session = this.requireLiveSession(context.agent_session_id);
    const turn = this.requireLiveTurn(session, context.turn_id);
    session.turns.delete(context.turn_id);
    session.endedTurnIds.add(context.turn_id);
    session.lastActivityMs = this.now();
    turn.controller.abort(new Error(`Browser turn ended: ${context.turn_id}`));
    return this.releaseTargets(
      (lease) =>
        lease.ownerGeneration === session.generation &&
        lease.publicLease.owner_session_id === context.agent_session_id &&
        lease.publicLease.owner_turn_id === context.turn_id &&
        lease.publicLease.lifetime === "turn",
    );
  }

  async endSession(agentSessionId: string): Promise<BrowserTargetLease[]> {
    const session = this.sessions.get(agentSessionId);
    if (!session) {
      if (this.endingSessionIds.has(agentSessionId)) {
        throw new BrowserRuntimeSessionError(
          "browser_session_ending",
          `Browser session "${agentSessionId}" is already releasing its targets`,
        );
      }
      return [];
    }
    this.sessions.delete(agentSessionId);
    this.endingSessionIds.add(agentSessionId);
    this.recordTombstone(agentSessionId);
    for (const turn of session.turns.values()) {
      turn.controller.abort(
        new Error(`Browser session ended: ${agentSessionId}`),
      );
    }
    try {
      return await this.releaseTargets(
        (lease) =>
          lease.ownerGeneration === session.generation &&
          lease.publicLease.owner_session_id === agentSessionId,
      );
    } finally {
      this.endingSessionIds.delete(agentSessionId);
    }
  }

  async reapIdleSessions(ttlMs: number): Promise<ReapedBrowserSession[]> {
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new BrowserRuntimeSessionError(
        "browser_session_not_started",
        "Browser session TTL must be a non-negative finite number",
      );
    }
    const cutoff = this.now() - ttlMs;
    const idleSessionIds = [...this.sessions.entries()]
      .filter(([, session]) => session.lastActivityMs <= cutoff)
      .map(([agentSessionId]) => agentSessionId)
      .sort();
    const reaped: ReapedBrowserSession[] = [];
    for (const agentSessionId of idleSessionIds) {
      reaped.push({
        agent_session_id: agentSessionId,
        target_leases: await this.endSession(agentSessionId),
      });
    }
    return reaped;
  }

  status(): BrowserRuntimeRegistryStatus {
    this.purgeTombstones();
    const sessions = [...this.sessions.entries()]
      .map(([agentSessionId, session]) => ({
        agent_session_id: agentSessionId,
        active_turn_ids: [...session.turns.keys()].sort(),
        target_ids: [...this.targets.values()]
          .filter(
            (lease) =>
              lease.ownerGeneration === session.generation &&
              lease.publicLease.owner_session_id === agentSessionId,
          )
          .map((lease) => lease.publicLease.target_id)
          .sort(),
        last_activity_ms: session.lastActivityMs,
      }))
      .sort((left, right) =>
        left.agent_session_id.localeCompare(right.agent_session_id),
      );
    return {
      sessions,
      tombstoned_session_ids: [...this.sessionTombstones.keys()].sort(),
      target_leases: [...this.targets.values()]
        .map((lease) => lease.publicLease)
        .sort((left, right) => left.target_id.localeCompare(right.target_id)),
    };
  }

  private requireLiveContext(context: BrowserInvocationContext): LiveSession {
    const session = this.requireLiveSession(context.agent_session_id);
    this.touchLiveSession(session, context.turn_id);
    return session;
  }

  private requireLiveSession(agentSessionId: string): LiveSession {
    const session = this.sessions.get(agentSessionId);
    if (session) return session;
    if (this.endingSessionIds.has(agentSessionId)) {
      throw new BrowserRuntimeSessionError(
        "browser_session_ending",
        `Browser session "${agentSessionId}" is releasing its targets`,
      );
    }
    if (this.sessionTombstones.has(agentSessionId)) {
      throw new BrowserRuntimeSessionError(
        "browser_session_ended",
        `Browser session "${agentSessionId}" has ended`,
      );
    }
    throw new BrowserRuntimeSessionError(
      "browser_session_not_started",
      `Browser session "${agentSessionId}" has not been started`,
    );
  }

  private touchLiveSession(session: LiveSession, turnId: string): void {
    if (session.endedTurnIds.has(turnId)) throw turnEndedError(turnId);
    if (!session.turns.has(turnId)) {
      session.turns.set(turnId, { controller: new AbortController() });
    }
    session.lastActivityMs = this.now();
  }

  private requireLiveTurn(session: LiveSession, turnId: string): LiveTurn {
    if (session.endedTurnIds.has(turnId)) throw turnEndedError(turnId);
    const turn = session.turns.get(turnId);
    if (!turn) {
      throw new BrowserRuntimeSessionError(
        "browser_session_not_started",
        `Browser turn "${turnId}" has not been started`,
      );
    }
    return turn;
  }

  private requireTargetLease(targetId: string): OwnedTargetLease {
    const lease = this.targets.get(targetId);
    if (lease) return lease;
    throw new BrowserRuntimeSessionError(
      "browser_target_not_found",
      `Browser target "${targetId}" does not exist`,
    );
  }

  private requireTargetQueue(targetId: string): TargetMutationQueue {
    const queue = this.targetQueues.get(targetId);
    if (queue) return queue;
    throw new BrowserRuntimeSessionError(
      "browser_target_not_found",
      `Browser target "${targetId}" does not exist`,
    );
  }

  private async releaseTargets(
    shouldRelease: (lease: OwnedTargetLease) => boolean,
  ): Promise<BrowserTargetLease[]> {
    const candidates = [...this.targets.values()].filter(shouldRelease);
    const released = await Promise.all(
      candidates.map(async (candidate) => {
        const targetId = candidate.publicLease.target_id;
        const queue = this.requireTargetQueue(targetId);
        return queue.enqueue(async () => {
          if (this.targets.get(targetId) !== candidate) return null;
          this.targets.delete(targetId);
          this.targetQueues.delete(targetId);
          return candidate.publicLease;
        });
      }),
    );
    return released.filter(
      (lease): lease is BrowserTargetLease => lease !== null,
    );
  }

  private recordTombstone(agentSessionId: string): void {
    this.sessionTombstones.delete(agentSessionId);
    this.sessionTombstones.set(agentSessionId, this.now());
    this.purgeTombstones();
  }

  private purgeTombstones(): void {
    const cutoff = this.now() - this.tombstoneTtlMs;
    for (const [agentSessionId, endedAt] of this.sessionTombstones) {
      if (endedAt < cutoff) this.sessionTombstones.delete(agentSessionId);
    }
    while (this.sessionTombstones.size > this.maxTombstones) {
      const oldest = this.sessionTombstones.keys().next().value as
        | string
        | undefined;
      if (oldest === undefined) break;
      this.sessionTombstones.delete(oldest);
    }
  }
}

function validateContext(context: BrowserInvocationContext): void {
  if (!context.agent_session_id.trim() || !context.turn_id.trim()) {
    throw new BrowserRuntimeSessionError(
      "browser_session_not_started",
      "Browser invocation requires non-empty Agent-session and turn ids",
    );
  }
}

function validateTargetLeaseInput(input: BrowserTargetLeaseInput): void {
  if (!input.target_id.trim() || !input.profile_partition_id.trim()) {
    throw new BrowserRuntimeSessionError(
      "browser_target_invalid",
      "Browser target and profile partition ids must not be empty",
    );
  }
  if (input.visibility === "hidden" && input.provider === "chrome") {
    throw new BrowserRuntimeSessionError(
      "browser_target_invalid",
      "The Chrome provider cannot guarantee hidden visibility",
    );
  }
}

function assertTargetOwner(
  lease: OwnedTargetLease,
  agentSessionId: string,
  generation: number,
): void {
  if (
    lease.publicLease.owner_session_id !== agentSessionId ||
    lease.ownerGeneration !== generation
  ) {
    throw targetOwnedError(
      lease.publicLease.target_id,
      lease.publicLease.owner_session_id,
    );
  }
}

function targetOwnedError(
  targetId: string,
  ownerSessionId: string,
): BrowserRuntimeSessionError {
  return new BrowserRuntimeSessionError(
    "browser_target_owned",
    `Browser target "${targetId}" is owned by session "${ownerSessionId}"`,
  );
}

function turnEndedError(turnId: string): BrowserRuntimeSessionError {
  return new BrowserRuntimeSessionError(
    "browser_turn_ended",
    `Browser turn "${turnId}" has ended`,
  );
}

function suggestionFor(code: BrowserRuntimeSessionErrorCode): string {
  switch (code) {
    case "browser_session_not_started":
      return "Call start_session before issuing browser operations.";
    case "browser_session_ended":
      return "Call start_session explicitly to revive this Agent session id.";
    case "browser_session_ending":
      return "Wait for target cleanup to finish before restarting the session.";
    case "browser_turn_ended":
      return "Use the current turn id; ended turns cannot be revived.";
    case "browser_target_owned":
      return "Use a separate target or request an explicit target handoff.";
    case "browser_target_not_found":
      return "Create or claim a target before issuing browser operations.";
    case "browser_target_invalid":
      return "Choose a provider, visibility, and partition combination the provider can guarantee.";
  }
}
