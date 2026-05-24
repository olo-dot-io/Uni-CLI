import { describe, expect, it } from "vitest";

import {
  buildDeliveryTrajectory,
  deliveryAttemptFromRunEvents,
  type DeliveryObjective,
  type DeliveryStrategy,
} from "../../src/engine/delivery/index.js";
import {
  createEvidenceCapturedEvent,
  createRunCompletedEvent,
  createRunEventSequence,
  createRunFailedEvent,
  createRunStartedEvent,
  createToolCallCompletedEvent,
  createToolCallFailedEvent,
  createToolCallStartedEvent,
  type RunTraceMetadata,
} from "../../src/engine/session/events.js";
import type { RunEvent } from "../../src/engine/session/types.js";

const objective: DeliveryObjective = {
  id: "deliver-reddit-search",
  goal: "Return current reddit search results with result-envelope evidence",
  evidence_gates: [
    { kind: "run_completed" },
    { kind: "required_evidence_type", evidence_type: "result-envelope" },
  ],
};

const strategies: DeliveryStrategy[] = [
  {
    id: "adapter-path",
    kind: "adapter",
    label: "Use bundled reddit adapter",
    priority: 10,
    command: "reddit.search",
    adapter_path: "src/adapters/reddit/search.yaml",
    verify_command: "unicli test reddit search",
  },
];

function metadata(runId: string): RunTraceMetadata {
  return {
    run_id: runId,
    trace_id: `01HDELIVERY${runId.toUpperCase().replaceAll("-", "")}`,
    command: "reddit.search",
    site: "reddit",
    cmd: "search",
    adapter_path: "src/adapters/reddit/search.yaml",
    permission_profile: "open",
    transport_surface: "cli",
    target_surface: "web",
    args_hash: "sha256:reddit-search",
    pipeline_steps: 3,
  };
}

function completedTrace(runId: string): RunEvent[] {
  const meta = metadata(runId);
  const sequence = createRunEventSequence();
  const resultData = {
    exit_code: 0,
    result_count: 2,
    duration_ms: 11,
  };
  return [
    createRunStartedEvent(meta, sequence),
    createToolCallStartedEvent(meta, sequence),
    createToolCallCompletedEvent(meta, sequence, resultData),
    createEvidenceCapturedEvent(meta, sequence, {
      evidence_type: "result-envelope",
      data: {
        outcome: "success",
        exit_code: 0,
        result_count: 2,
        duration_ms: 11,
        adapter_path: meta.adapter_path,
      },
    }),
    createRunCompletedEvent(meta, sequence, resultData),
  ];
}

function selectorFailureTrace(runId: string): RunEvent[] {
  const meta = metadata(runId);
  const sequence = createRunEventSequence();
  const error = {
    code: "selector_miss",
    message: "Result selector did not match any nodes.",
    adapter_path: meta.adapter_path,
    step: 2,
    suggestion: "Refresh the result selector from a live snapshot.",
    retryable: true,
  };
  const resultData = {
    exit_code: 70,
    result_count: 0,
    duration_ms: 13,
    error,
    envelope: { command: meta.command, error },
  };
  return [
    createRunStartedEvent(meta, sequence),
    createToolCallStartedEvent(meta, sequence),
    createToolCallFailedEvent(meta, sequence, resultData),
    createEvidenceCapturedEvent(meta, sequence, {
      evidence_type: "result-envelope",
      data: {
        outcome: "failure",
        exit_code: 70,
        result_count: 0,
        duration_ms: 13,
        adapter_path: meta.adapter_path,
        has_error: true,
      },
    }),
    createRunFailedEvent(meta, sequence, resultData),
  ];
}

describe("delivery session integration", () => {
  it("converts completed run events into a delivered attempt", () => {
    const attempt = deliveryAttemptFromRunEvents({
      id: "attempt-01",
      ordinal: 1,
      strategy_id: "adapter-path",
      events: completedTrace("run-reddit-ok"),
    });

    const trajectory = buildDeliveryTrajectory({
      objective,
      strategies,
      attempts: [attempt],
      recorded_at: "2026-05-24T11:56:00Z",
    });

    expect(attempt.summary).toMatchObject({
      run_id: "run-reddit-ok",
      status: "completed",
      evidence_by_type: { "result-envelope": 1 },
    });
    expect(attempt.error).toBeUndefined();
    expect(trajectory.verification_status).toBe("verified");
  });

  it("extracts structured run errors so trajectory can plan adapter repair", () => {
    const attempt = deliveryAttemptFromRunEvents({
      id: "attempt-01",
      ordinal: 1,
      strategy_id: "adapter-path",
      events: selectorFailureTrace("run-reddit-selector-fail"),
    });

    const trajectory = buildDeliveryTrajectory({
      objective,
      strategies,
      attempts: [attempt],
      recorded_at: "2026-05-24T11:57:00Z",
    });

    expect(attempt.error).toMatchObject({
      code: "selector_miss",
      adapter_path: "src/adapters/reddit/search.yaml",
      step: 2,
      retryable: true,
    });
    expect(trajectory.assessment.diagnosis).toMatchObject({
      code: "adapter_drift",
      repairable: true,
    });
    expect(trajectory.next_experiment).toMatchObject({
      action: "repair_adapter",
      verify_command: "unicli test reddit search",
    });
  });
});
