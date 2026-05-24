import { describe, expect, it } from "vitest";

import {
  buildDeliveryTrajectory,
  deliveryRepairCandidateFromTrajectory,
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
};

const repairableStrategy: DeliveryStrategy = {
  id: "api-path",
  kind: "adapter",
  label: "Use existing adapter",
  priority: 10,
  command: "xiaohongshu.search",
  adapter_path: "src/adapters/xiaohongshu/search.ts",
  verify_command: "unicli test xiaohongshu search",
};

function summary(overrides: Partial<RunSummary>): RunSummary {
  return {
    run_id: "run-xhs-01",
    status: "failed",
    events: 8,
    evidence_count: 0,
    evidence_by_type: {},
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

describe("delivery repair bridge", () => {
  it("turns a repairable adapter diagnosis into one bounded repair candidate", () => {
    const trajectory = buildDeliveryTrajectory({
      objective,
      strategies: [repairableStrategy],
      attempts: [
        attempt({
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
      recorded_at: "2026-05-24T12:25:00Z",
    });

    const candidate = deliveryRepairCandidateFromTrajectory(trajectory);

    expect(candidate).toEqual({
      schema_version: "1",
      objective_id: "deliver-xhs-search",
      attempt_id: "attempt-01",
      strategy_id: "api-path",
      adapter_path: "src/adapters/xiaohongshu/search.ts",
      verify_command: "unicli test xiaohongshu search",
      diagnosis_code: "adapter_drift",
      reason: "Re-snapshot live results and update the result-card locator.",
      command: "xiaohongshu.search",
      step: 3,
      suggestion:
        "Re-snapshot live results and update the result-card locator.",
    });
  });

  it("does not convert permission blocks into repair work", () => {
    const trajectory = buildDeliveryTrajectory({
      objective,
      strategies: [repairableStrategy],
      attempts: [
        attempt({
          summary: summary({
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
      recorded_at: "2026-05-24T12:26:00Z",
    });

    expect(deliveryRepairCandidateFromTrajectory(trajectory)).toBeUndefined();
  });

  it("requires a verification command before opening a repair candidate", () => {
    const trajectory = buildDeliveryTrajectory({
      objective,
      strategies: [{ ...repairableStrategy, verify_command: undefined }],
      attempts: [
        attempt({
          error: {
            code: "schema_mismatch",
            message: "Result shape changed",
            adapter_path: "src/adapters/xiaohongshu/search.ts",
            step: 2,
            retryable: true,
          },
        }),
      ],
      recorded_at: "2026-05-24T12:27:00Z",
    });

    expect(deliveryRepairCandidateFromTrajectory(trajectory)).toBeUndefined();
  });

  it("keeps repair candidates inside owned adapter paths", () => {
    const trajectory = buildDeliveryTrajectory({
      objective,
      strategies: [
        {
          ...repairableStrategy,
          adapter_path: "src/engine/session/run-loop.ts",
        },
      ],
      attempts: [
        attempt({
          error: {
            code: "selector_miss",
            message: "A non-adapter TypeScript file was reported.",
            adapter_path: "src/engine/session/run-loop.ts",
            step: 2,
            retryable: true,
          },
        }),
      ],
      recorded_at: "2026-05-24T12:41:00Z",
    });

    expect(deliveryRepairCandidateFromTrajectory(trajectory)).toBeUndefined();
  });

  it("rejects traversal and embedded adapter-root paths", () => {
    for (const adapterPath of [
      "../../src/adapters/twitter/search.ts",
      "/tmp/unicli/src/adapters/twitter/search.ts",
    ]) {
      const trajectory = buildDeliveryTrajectory({
        objective,
        strategies: [{ ...repairableStrategy, adapter_path: adapterPath }],
        attempts: [
          attempt({
            error: {
              code: "selector_miss",
              message: "An unowned adapter path was reported.",
              adapter_path: adapterPath,
              step: 2,
              retryable: true,
            },
          }),
        ],
        recorded_at: "2026-05-24T12:46:00Z",
      });

      expect(deliveryRepairCandidateFromTrajectory(trajectory)).toBeUndefined();
    }
  });
});
