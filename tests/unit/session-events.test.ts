import { describe, expect, it } from "vitest";

import {
  createEnvironmentSnapshotEvent,
  createEvidenceCapturedEvent,
  createPermissionEvaluatedEvent,
  createRunEventSequence,
  createRunStartedEvent,
  createRuntimePermissionDeniedEvent,
  createToolCallStartedEvent,
  projectRunEventForPublicSurface,
  type RunTraceMetadata,
} from "../../src/engine/session/events.js";

const metadata: RunTraceMetadata = {
  run_id: "run-01",
  trace_id: "01HXTRACE000000000000000000",
  command: "demo.search",
  site: "demo",
  cmd: "search",
  adapter_path: "src/adapters/demo/search.yaml",
  permission_profile: "locked",
  transport_surface: "cli",
  target_surface: "web",
  args_hash: "sha256:abc123",
  pipeline_steps: 2,
};

describe("session event builders", () => {
  it("builds run.started with required run metadata", () => {
    const sequence = createRunEventSequence();
    const event = createRunStartedEvent(metadata, sequence, {
      timestamp: "2026-04-27T12:00:00.000Z",
    });

    expect(event).toMatchObject({
      schema_version: "1",
      name: "run.started",
      run_id: "run-01",
      trace_id: "01HXTRACE000000000000000000",
      sequence: 1,
      timestamp: "2026-04-27T12:00:00.000Z",
      visibility: "internal",
      metadata,
    });
  });

  it("builds environment snapshots as public reproducibility context", () => {
    const sequence = createRunEventSequence();
    const event = createEnvironmentSnapshotEvent(metadata, sequence, {
      schema_version: "1",
      unicli_version: "0.217.0",
      node_version: "v24.0.0",
      platform: "darwin",
      arch: "arm64",
      ci: false,
      permission_profile: "locked",
      transport_surface: "cli",
      target_surface: "web",
      pipeline_steps: 2,
    });

    expect(event).toMatchObject({
      schema_version: "1",
      name: "environment.snapshot",
      visibility: "public",
      data: {
        schema_version: "1",
        unicli_version: "0.217.0",
        node_version: "v24.0.0",
        platform: "darwin",
        arch: "arm64",
        ci: false,
        permission_profile: "locked",
        transport_surface: "cli",
        target_surface: "web",
        pipeline_steps: 2,
      },
    });
    expect(event).not.toHaveProperty("internal");
    expect(event).not.toHaveProperty("secret");
  });

  it("allocates monotonically increasing sequence numbers", () => {
    const sequence = createRunEventSequence();

    const first = createRunStartedEvent(metadata, sequence);
    const second = createToolCallStartedEvent(metadata, sequence, {
      args_hash: "sha256:abc123",
    });
    const third = createPermissionEvaluatedEvent(metadata, sequence, {
      profile: "locked",
      effect: "read",
      risk: "low",
      enforcement: "allow",
    });

    expect([first.sequence, second.sequence, third.sequence]).toEqual([
      1, 2, 3,
    ]);
  });

  it("projects events for public surfaces without internal or secret payloads", () => {
    const sequence = createRunEventSequence();
    const event = createEvidenceCapturedEvent(metadata, sequence, {
      visibility: "secret",
      evidence_type: "terminal",
      data: { summary: "captured 2 lines" },
      internal: { raw: "PATH=/tmp\nTOKEN=abc" },
      secret: { token: "abc" },
    });

    const projected = projectRunEventForPublicSurface(event);

    expect(projected).toMatchObject({
      name: "evidence.captured",
      visibility: "secret",
      data: { summary: "captured 2 lines" },
    });
    expect(projected).not.toHaveProperty("internal");
    expect(projected).not.toHaveProperty("secret");
  });

  it("builds runtime permission deny events without exposing raw resources publicly", () => {
    const sequence = createRunEventSequence();
    const event = createRuntimePermissionDeniedEvent(
      metadata,
      sequence,
      {
        code: "permission_denied",
        adapter_path: metadata.adapter_path,
        action: "fetch_text",
        step: 0,
        rule_id: "deny-runtime-domain",
        resource_buckets: ["domains"],
        retryable: false,
      },
      {
        resources: {
          domains: ["blocked.example"],
        },
      },
    );

    const projected = projectRunEventForPublicSurface(event);

    expect(projected).toMatchObject({
      name: "permission.runtime_denied",
      data: {
        code: "permission_denied",
        rule_id: "deny-runtime-domain",
        resource_buckets: ["domains"],
      },
    });
    expect(projected).not.toHaveProperty("internal");
    expect(projected).not.toHaveProperty("secret");
    expect(JSON.stringify(projected)).not.toContain("blocked.example");
  });
});
