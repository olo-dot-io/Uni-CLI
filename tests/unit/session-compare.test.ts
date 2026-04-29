import { describe, expect, it } from "vitest";

import {
  createEvidenceCapturedEvent,
  createPermissionEvaluatedEvent,
  createRunEventSequence,
  createRunFailedEvent,
  createRunStartedEvent,
  createRuntimePermissionDeniedEvent,
  createToolCallFailedEvent,
  createToolCallStartedEvent,
  type RunTraceMetadata,
} from "../../src/engine/session/events.js";
import { compareRunEvents } from "../../src/engine/session/compare.js";
import type { RunEvent, RunId } from "../../src/engine/session/types.js";

function metadataFor(runId: RunId): RunTraceMetadata {
  return {
    run_id: runId,
    trace_id: `01HTRACE${runId.replaceAll("-", "").toUpperCase()}0000`,
    command: "session-fixture.runtime-deny",
    site: "session-fixture",
    cmd: "runtime-deny",
    adapter_path: "src/adapters/session-fixture/runtime-deny.yaml",
    permission_profile: "open",
    transport_surface: "cli",
    target_surface: "web",
    args_hash: "sha256:runtime-deny",
    pipeline_steps: 1,
  };
}

function deniedTrace(
  runId: RunId,
  ruleId: string,
  resourceBuckets: string[],
): RunEvent[] {
  const metadata = metadataFor(runId);
  const sequence = createRunEventSequence();
  const error = {
    code: "permission_denied",
    message: `permission rule "${ruleId}" denies runtime resource`,
    adapter_path: metadata.adapter_path,
    step: 0,
    suggestion: `Edit or remove permission rule "${ruleId}".`,
    retryable: false,
  };
  const resultData = {
    exit_code: 77,
    result_count: 0,
    duration_ms: 7,
    error,
    envelope: { command: metadata.command, error },
  };

  return [
    createRunStartedEvent(metadata, sequence),
    createToolCallStartedEvent(metadata, sequence),
    createPermissionEvaluatedEvent(metadata, sequence, {
      profile: "open",
      effect: "read",
      risk: "low",
      enforcement: "allow",
    }),
    createRuntimePermissionDeniedEvent(
      metadata,
      sequence,
      {
        code: "permission_denied",
        adapter_path: metadata.adapter_path,
        action: "fetch_text",
        step: 0,
        rule_id: ruleId,
        resource_buckets: resourceBuckets,
        retryable: false,
      },
      {
        resources: {
          domains: ["blocked.example"],
        },
      },
    ),
    createToolCallFailedEvent(metadata, sequence, resultData),
    createEvidenceCapturedEvent(metadata, sequence, {
      evidence_type: "result-envelope",
      data: {
        outcome: "failure",
        exit_code: 77,
        result_count: 0,
        duration_ms: 7,
        adapter_path: metadata.adapter_path,
        envelope_command: metadata.command,
        has_error: true,
      },
    }),
    createRunFailedEvent(metadata, sequence, resultData),
  ];
}

describe("run trace comparison", () => {
  it("compares runtime permission deny decisions without raw resources", () => {
    const comparison = compareRunEvents(
      deniedTrace("run-left", "deny-old-domain", ["domains"]),
      deniedTrace("run-right", "deny-new-path", ["paths"]),
      { leftRunId: "run-left", rightRunId: "run-right" },
    );

    expect(comparison.status).toBe("diverged");
    expect(comparison.left.result).toMatchObject({
      error_code: "permission_denied",
      runtime_permission_denied: {
        action: "fetch_text",
        step: 0,
        rule_id: "deny-old-domain",
        resource_buckets: ["domains"],
      },
    });
    expect(comparison.right.result).toMatchObject({
      runtime_permission_denied: {
        rule_id: "deny-new-path",
        resource_buckets: ["paths"],
      },
    });
    expect(comparison.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "runtime_permission_rule",
          impact: "behavior",
          status: "diverged",
        }),
        expect.objectContaining({
          name: "runtime_permission_resource_buckets",
          impact: "behavior",
          status: "diverged",
        }),
      ]),
    );
    expect(JSON.stringify(comparison)).not.toContain("blocked.example");
  });
});
