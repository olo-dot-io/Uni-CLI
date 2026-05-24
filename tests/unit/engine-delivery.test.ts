import { describe, expect, it } from "vitest";

import {
  assessDeliveryState,
  type DeliveryAttempt,
  type DeliveryObjective,
  type DeliveryStrategy,
} from "../../src/engine/delivery/index.js";
import type { RunSummary } from "../../src/engine/session/query.js";

const objective: DeliveryObjective = {
  id: "deliver-twitter-search",
  goal: "Return current search results with reviewable evidence",
  evidence_gates: [
    { kind: "run_completed" },
    { kind: "required_evidence_type", evidence_type: "result-envelope" },
  ],
  attempt_budget: {
    max_attempts: 4,
    max_attempts_per_strategy: 2,
  },
};

const strategies: DeliveryStrategy[] = [
  {
    id: "api-adapter",
    kind: "adapter",
    label: "Use the bundled API adapter",
    priority: 10,
    command: "twitter.search",
    adapter_path: "src/adapters/twitter/search.yaml",
    verify_command: "unicli test twitter search",
  },
  {
    id: "browser-adapter",
    kind: "browser",
    label: "Use browser extraction",
    priority: 20,
    command: "twitter.browser-search",
    adapter_path: "src/adapters/twitter/browser-search.yaml",
    verify_command: "unicli test twitter browser-search",
  },
];

function summary(overrides: Partial<RunSummary>): RunSummary {
  return {
    run_id: "run-delivery-01",
    status: "completed",
    events: 6,
    evidence_count: 1,
    evidence_by_type: { "result-envelope": 1 },
    ...overrides,
  };
}

function attempt(overrides: Partial<DeliveryAttempt>): DeliveryAttempt {
  return {
    id: "attempt-01",
    ordinal: 1,
    strategy_id: "api-adapter",
    run_id: "run-delivery-01",
    summary: summary({}),
    ...overrides,
  };
}

describe("delivery state assessment", () => {
  it("starts with the highest-priority enabled strategy when no attempts exist", () => {
    const assessment = assessDeliveryState({
      objective,
      strategies,
      attempts: [],
    });

    expect(assessment.status).toBe("ready");
    expect(assessment.next_action).toBe("run_strategy");
    expect(assessment.next_strategy_id).toBe("api-adapter");
  });

  it("marks an objective delivered when the latest run satisfies all evidence gates", () => {
    const assessment = assessDeliveryState({
      objective,
      strategies,
      attempts: [attempt({})],
    });

    expect(assessment.status).toBe("delivered");
    expect(assessment.next_action).toBe("stop");
    expect(assessment.gates.every((gate) => gate.passed)).toBe(true);
    expect(assessment.diagnosis).toBeUndefined();
  });

  it("turns adapter drift failures into repair hypotheses with a verify command", () => {
    const assessment = assessDeliveryState({
      objective,
      strategies,
      attempts: [
        attempt({
          summary: summary({ status: "failed", evidence_count: 0 }),
          error: {
            code: "selector_miss",
            message: "CSS selector did not match",
            adapter_path: "src/adapters/twitter/search.yaml",
            step: 2,
            suggestion: "Refresh the result item selector.",
            retryable: true,
          },
        }),
      ],
    });

    expect(assessment.status).toBe("needs_repair");
    expect(assessment.next_action).toBe("repair_adapter");
    expect(assessment.diagnosis).toMatchObject({
      code: "adapter_drift",
      repairable: true,
      retryable: true,
      adapter_path: "src/adapters/twitter/search.yaml",
      step: 2,
    });
    expect(assessment.hypothesis).toMatchObject({
      action: "repair_adapter",
      target: "src/adapters/twitter/search.yaml",
      verify_command: "unicli test twitter search",
    });
  });

  it("blocks on permission denials instead of misclassifying them as repair", () => {
    const assessment = assessDeliveryState({
      objective,
      strategies,
      attempts: [
        attempt({
          summary: summary({
            status: "failed",
            evidence_count: 0,
            runtime_permission_denied: {
              code: "permission_denied",
              action: "fetch_text",
              step: 0,
              rule_id: "deny-twitter",
              resource_buckets: ["domains"],
              retryable: false,
            },
          }),
          error: {
            code: "permission_denied",
            message: "Permission rule denied runtime resource",
            adapter_path: "src/adapters/twitter/search.yaml",
            step: 0,
            retryable: false,
          },
        }),
      ],
    });

    expect(assessment.status).toBe("blocked");
    expect(assessment.next_action).toBe("request_permission");
    expect(assessment.diagnosis).toMatchObject({
      code: "permission_denied",
      repairable: false,
      retryable: false,
    });
    expect(assessment.hypothesis).toBeUndefined();
  });

  it("switches strategy after the current strategy exhausts its attempt budget", () => {
    const assessment = assessDeliveryState({
      objective,
      strategies,
      attempts: [
        attempt({
          id: "attempt-01",
          ordinal: 1,
          run_id: "run-delivery-01",
          summary: summary({
            run_id: "run-delivery-01",
            evidence_count: 0,
            evidence_by_type: {},
          }),
        }),
        attempt({
          id: "attempt-02",
          ordinal: 2,
          run_id: "run-delivery-02",
          summary: summary({
            run_id: "run-delivery-02",
            evidence_count: 0,
            evidence_by_type: {},
          }),
        }),
      ],
    });

    expect(assessment.status).toBe("needs_retry");
    expect(assessment.next_action).toBe("switch_strategy");
    expect(assessment.next_strategy_id).toBe("browser-adapter");
    expect(assessment.diagnosis).toMatchObject({
      code: "evidence_gate_failed",
      retryable: true,
    });
  });

  it("does not switch into another strategy that already exhausted its budget", () => {
    const oneTryObjective: DeliveryObjective = {
      ...objective,
      attempt_budget: {
        max_attempts: 4,
        max_attempts_per_strategy: 1,
      },
    };
    const assessment = assessDeliveryState({
      objective: oneTryObjective,
      strategies,
      attempts: [
        attempt({
          id: "attempt-browser-01",
          ordinal: 1,
          strategy_id: "browser-adapter",
          run_id: "run-delivery-browser-01",
          summary: summary({
            run_id: "run-delivery-browser-01",
            evidence_count: 0,
            evidence_by_type: {},
          }),
        }),
        attempt({
          id: "attempt-api-01",
          ordinal: 2,
          strategy_id: "api-adapter",
          run_id: "run-delivery-api-01",
          summary: summary({
            run_id: "run-delivery-api-01",
            evidence_count: 0,
            evidence_by_type: {},
          }),
        }),
      ],
    });

    expect(assessment.status).toBe("exhausted");
    expect(assessment.next_action).toBe("inspect_failure");
    expect(assessment.next_strategy_id).toBeUndefined();
    expect(assessment.diagnosis).toMatchObject({
      code: "strategy_exhausted",
      retryable: false,
    });
  });
});
