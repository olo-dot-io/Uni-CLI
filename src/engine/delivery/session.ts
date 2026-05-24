/**
 * @owner   src/engine/delivery/session.ts
 * @does    Adapts recorded session run events into delivery attempts.
 * @needs   src/engine/session/query.ts, src/engine/session/types.ts, src/engine/delivery/types.ts
 * @feeds   src/engine/delivery/trajectory.ts and future run-record driven delivery commands.
 * @breaks  Missing structured error extraction hides repairable adapter failures from the delivery trajectory.
 * @invariants latest structured AgentError wins; malformed error payloads are ignored, not fabricated.
 * @side-effects none
 * @perf    O(events) scan; allocates one summary and optional error object.
 * @concurrency pure and reentrant.
 * @test    tests/unit/engine-delivery-session.test.ts
 * @stability experimental
 * @since   2026-05-24
 */

import type { AgentError } from "../../output/envelope.js";
import { summarizeRunEvents } from "../session/query.js";
import type { RunEvent } from "../session/types.js";
import type {
  DeliveryAttempt,
  DeliveryAttemptFromRunEventsInput,
} from "./types.js";

export function deliveryAttemptFromRunEvents(
  input: DeliveryAttemptFromRunEventsInput,
): DeliveryAttempt {
  const runId =
    input.run_id ??
    input.events[0]?.metadata.run_id ??
    input.events[0]?.run_id ??
    input.id;
  const summary = summarizeRunEvents(input.events, { runId });
  const error = extractLatestAgentError(input.events);
  return {
    id: input.id,
    ordinal: input.ordinal,
    strategy_id: input.strategy_id,
    run_id: summary.run_id,
    summary,
    ...(error ? { error } : {}),
  };
}

function extractLatestAgentError(events: RunEvent[]): AgentError | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const error =
      agentErrorFromValue(event.data?.error) ??
      agentErrorFromValue(agentEnvelopeError(event.data?.envelope));
    if (error) return error;
  }
  return undefined;
}

function agentEnvelopeError(envelope: unknown): unknown {
  if (!isRecord(envelope)) return undefined;
  return envelope.error;
}

function agentErrorFromValue(value: unknown): AgentError | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.code !== "string" || typeof value.message !== "string") {
    return undefined;
  }
  return {
    code: value.code,
    message: value.message,
    ...(typeof value.adapter_path === "string"
      ? { adapter_path: value.adapter_path }
      : {}),
    ...(typeof value.step === "number" && Number.isFinite(value.step)
      ? { step: value.step }
      : {}),
    ...(typeof value.suggestion === "string"
      ? { suggestion: value.suggestion }
      : {}),
    ...(typeof value.retryable === "boolean"
      ? { retryable: value.retryable }
      : {}),
    ...(Array.isArray(value.alternatives)
      ? {
          alternatives: value.alternatives.filter(
            (entry): entry is string => typeof entry === "string",
          ),
        }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
