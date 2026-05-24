import { describe, expect, it } from "vitest";

import {
  buildDeliveryTrajectory,
  type DeliveryAttempt,
  type DeliveryObjective,
  type DeliveryStrategy,
} from "../../src/engine/delivery/index.js";
import type { RunSummary } from "../../src/engine/session/query.js";

const objective: DeliveryObjective = {
  id: "deliver-xhs-search",
  goal: "Return current notes with result evidence",
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
    id: "api-path",
    kind: "adapter",
    label: "Use existing adapter",
    priority: 10,
    command: "xiaohongshu.search",
    adapter_path: "src/adapters/xiaohongshu/search.ts",
    verify_command: "unicli test xiaohongshu search",
  },
  {
    id: "browser-path",
    kind: "browser",
    label: "Use browser session extraction",
    priority: 20,
    command: "xiaohongshu.browser-search",
    adapter_path: "src/adapters/xiaohongshu/browser-search.yaml",
    verify_command: "unicli test xiaohongshu browser-search",
  },
];

function summary(overrides: Partial<RunSummary>): RunSummary {
  return {
    run_id: "run-xhs-01",
    status: "completed",
    events: 8,
    evidence_count: 1,
    evidence_by_type: { "result-envelope": 1 },
    ...overrides,
  };
}

function attempt(overrides: Partial<DeliveryAttempt>): DeliveryAttempt {
  return {
    id: "attempt-01",
    ordinal: 1,
    strategy_id: "api-path",
    run_id: "run-xhs-01",
    summary: summary({}),
    ...overrides,
  };
}

describe("delivery trajectory", () => {
  it("records a verified trajectory when the latest attempt satisfies the evidence gates", () => {
    const trajectory = buildDeliveryTrajectory({
      objective,
      strategies,
      attempts: [attempt({})],
      recorded_at: "2026-05-24T11:50:00Z",
    });

    expect(trajectory.verification_status).toBe("verified");
    expect(trajectory.assessment.status).toBe("delivered");
    expect(trajectory.trials).toEqual([
      expect.objectContaining({
        id: "attempt-01",
        run_id: "run-xhs-01",
        strategy_id: "api-path",
        status: "delivered",
        verification_status: "verified",
        failed_gates: [],
      }),
    ]);
    expect(trajectory.next_experiment).toBeUndefined();
  });

  it("turns a failed attempt into an analyzable repair experiment plan", () => {
    const trajectory = buildDeliveryTrajectory({
      objective,
      strategies,
      attempts: [
        attempt({
          summary: summary({
            status: "failed",
            evidence_count: 0,
            evidence_by_type: {},
          }),
          error: {
            code: "selector_miss",
            message: "Result card selector no longer matches",
            adapter_path: "src/adapters/xiaohongshu/search.ts",
            step: 3,
            suggestion:
              "Re-snapshot live results and update the result-card locator.",
            retryable: true,
          },
        }),
      ],
      recorded_at: "2026-05-24T11:51:00Z",
    });

    expect(trajectory.verification_status).toBe("active");
    expect(trajectory.trials[0]).toMatchObject({
      status: "needs_repair",
      classification: "product_defect",
      diagnosis_code: "adapter_drift",
      failed_gates: ["run_completed", "evidence_type:result-envelope"],
      hypothesis:
        "Re-snapshot live results and update the result-card locator.",
    });
    expect(trajectory.next_experiment).toMatchObject({
      action: "repair_adapter",
      strategy_id: "api-path",
      command: "xiaohongshu.search",
      target: "src/adapters/xiaohongshu/search.ts",
      verify_command: "unicli test xiaohongshu search",
      disproof:
        "The next run still fails the same evidence gates or diagnosis.",
    });
  });

  it("does not mark historical completed attempts as delivered when evidence gates failed", () => {
    const trajectory = buildDeliveryTrajectory({
      objective,
      strategies,
      attempts: [
        attempt({
          id: "attempt-01",
          ordinal: 1,
          run_id: "run-xhs-01",
          summary: summary({
            run_id: "run-xhs-01",
            evidence_count: 0,
            evidence_by_type: {},
          }),
        }),
        attempt({
          id: "attempt-02",
          ordinal: 2,
          run_id: "run-xhs-02",
          summary: summary({
            run_id: "run-xhs-02",
            status: "failed",
            evidence_count: 0,
            evidence_by_type: {},
          }),
          error: {
            code: "selector_miss",
            message: "Result card selector no longer matches",
            adapter_path: "src/adapters/xiaohongshu/search.ts",
            step: 3,
            retryable: true,
          },
        }),
      ],
      recorded_at: "2026-05-24T12:45:00Z",
    });

    expect(trajectory.trials[0]).toMatchObject({
      id: "attempt-01",
      status: "inconclusive",
      verification_status: "active",
      classification: "product_defect",
      diagnosis_code: "evidence_gate_failed",
      failed_gates: ["evidence_type:result-envelope"],
    });
  });

  it("does not create an executable next experiment for permission blocks", () => {
    const trajectory = buildDeliveryTrajectory({
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
              rule_id: "deny-social",
              resource_buckets: ["domains"],
              retryable: false,
            },
          }),
          error: {
            code: "permission_denied",
            message: "Permission rule denied the requested domain.",
            adapter_path: "src/adapters/xiaohongshu/search.ts",
            step: 0,
            retryable: false,
          },
        }),
      ],
      recorded_at: "2026-05-24T11:52:00Z",
    });

    expect(trajectory.verification_status).toBe("blocked");
    expect(trajectory.trials[0]).toMatchObject({
      classification: "user_or_policy_block",
      diagnosis_code: "permission_denied",
      hypothesis: undefined,
    });
    expect(trajectory.next_experiment).toBeUndefined();
  });
});
