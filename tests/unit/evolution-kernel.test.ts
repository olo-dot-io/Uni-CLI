import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createAdapterEvolutionSession,
  createEvolutionStore,
  distillRunEvidence,
  promoteEvolutionSession,
  readEvolutionSession,
  rollbackEvolutionSession,
  verifyEvolutionSession,
} from "../../src/engine/evolution/index.js";
import {
  appendRunEvent,
  createRunStore,
} from "../../src/engine/session/store.js";
import {
  createEnvironmentSnapshotEvent,
  createEvidenceCapturedEvent,
  createRunEventSequence,
  createRunFailedEvent,
  createRunStartedEvent,
  createToolCallFailedEvent,
  createToolCallStartedEvent,
  type RunTraceMetadata,
} from "../../src/engine/session/events.js";
import { registerAdapter } from "../../src/registry.js";
import { AdapterType, type AdapterCommand } from "../../src/types.js";

const BASE_ADAPTER = `site: evolution-fixture
name: probe
description: Probe the evolution fixture
type: web-api
strategy: public
operation_effect: read
pipeline:
  - fetch:
      url: https://example.com/status
capabilities: ["http.fetch"]
minimum_capability: http.fetch
trust: public
confidentiality: public
quarantine: false
schema_version: v2
`;

describe("harness evolution kernel", () => {
  let root: string;
  let originalHome: string | undefined;
  let sourcePath: string;
  let runRoot: string;
  let adapterCommand: AdapterCommand;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "unicli-evolution-"));
    originalHome = process.env.HOME;
    process.env.HOME = join(root, "home");
    sourcePath = join(
      process.env.HOME,
      ".unicli",
      "adapters",
      "evolution-fixture",
      "probe.yaml",
    );
    mkdirSync(dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, BASE_ADAPTER);
    runRoot = join(root, "runs");
    adapterCommand = {
      name: "probe",
      description: "Probe evolution fixture",
      adapter_path: sourcePath,
      source_tier: "user",
      target_surface: "web",
      operation_effect: "read",
      execution_operator: "structured-api",
      capabilities: ["http.fetch"],
      minimum_capability: "http.fetch",
      pipeline: [{ fetch: { url: "https://example.com/status" } }],
    };
    await writeFailedReplayRun(runRoot, "run-evolution-proposal");
    await writeFailedReplayRun(runRoot, "run-evolution-validation");
    await writeFailedReplayRun(runRoot, "run-evolution-held-out");
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(root, { recursive: true, force: true });
  });

  it("distills run failures without carrying secret replay arguments", async () => {
    const packet = await distillRunEvidence({
      store: createRunStore({ rootDir: runRoot }),
      runIds: ["run-evolution-proposal"],
      component: {
        kind: "adapter",
        id: "adapter:evolution-fixture.probe",
        site: "evolution-fixture",
        command: "probe",
        source_path: sourcePath,
        source_tier: "user",
      },
      scope: {
        model_affinity: ["fixture-model"],
        permission_profile: "open",
        target_surface: "web",
        operation_effect: "read",
      },
      createdAt: "2026-08-10T12:00:00.000Z",
    });

    expect(packet.summary).toMatchObject({
      runs: 1,
      completed: 0,
      failed: 1,
      failure_classes: { adapter_behavior: 1 },
      error_codes: { selector_miss: 1 },
    });
    expect(packet.sources[0].error?.message).toContain("token=<redacted>");
    expect(packet.sources[0].error?.message).toContain("api_key=<redacted>");
    expect(JSON.stringify(packet)).not.toContain("private replay value");
  });

  it("rejects run ids reused across evolution data splits", async () => {
    await expect(
      createAdapterEvolutionSession({
        evolutionStore: createEvolutionStore({
          rootDir: join(root, "evolution-overlap"),
        }),
        runStore: createRunStore({ rootDir: runRoot }),
        site: "evolution-fixture",
        command: "probe",
        adapterCommand,
        proposalRunIds: ["run-evolution-proposal"],
        validationRunIds: ["run-evolution-proposal"],
      }),
    ).rejects.toThrow(/must be disjoint/);
  });

  it("rejects candidates that change the verified authorization scope", async () => {
    const candidatePath = join(root, "scope-changing-candidate.yaml");
    writeFileSync(
      candidatePath,
      BASE_ADAPTER.replace(
        "operation_effect: read",
        "operation_effect: destructive",
      ),
    );

    await expect(
      createAdapterEvolutionSession({
        evolutionStore: createEvolutionStore({
          rootDir: join(root, "evolution-scope-change"),
        }),
        runStore: createRunStore({ rootDir: runRoot }),
        site: "evolution-fixture",
        command: "probe",
        adapterCommand,
        proposalRunIds: ["run-evolution-proposal"],
        candidatePath,
      }),
    ).rejects.toThrow(/changes evolution scope fields: operation_effect/);
  });

  it("verifies, promotes, and rolls back one isolated adapter candidate", async () => {
    registerAdapter({
      name: "evolution-fixture",
      type: AdapterType.WEB_API,
      commands: { probe: adapterCommand },
    });
    const candidatePath = join(root, "candidate.yaml");
    writeFileSync(candidatePath, `${BASE_ADAPTER}# candidate-success\n`);
    const evalPath = join(root, "held-out.yaml");
    writeFileSync(
      evalPath,
      [
        "name: evolution-held-out",
        "adapter: evolution-fixture",
        "cases:",
        "  - id: independent-probe",
        "    command: probe",
        "    judges:",
        "      - { type: exitCode, equals: 0 }",
        "",
      ].join("\n"),
    );
    const cliPath = join(root, "fake-unicli.cjs");
    writeFileSync(
      cliPath,
      [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const file = path.join(process.env.UNICLI_USER_ADAPTER_DIR, "evolution-fixture", "probe.yaml");',
        'const ok = fs.readFileSync(file, "utf8").includes("candidate-success");',
        'process.stdout.write(JSON.stringify({ok, schema_version:"2", command:"evolution-fixture.probe", meta:{duration_ms:1, effect_verdict:{status:"not_applicable", evidence:"declared_read", reason:"read"}}, data:[], error:ok?null:{code:"selector_miss",message:"baseline failed"}}));',
        "process.exitCode = ok ? 0 : 1;",
        "",
      ].join("\n"),
    );
    const evolutionStore = createEvolutionStore({
      rootDir: join(root, "evolution"),
    });
    const session = await createAdapterEvolutionSession({
      evolutionStore,
      runStore: createRunStore({ rootDir: runRoot }),
      site: "evolution-fixture",
      command: "probe",
      adapterCommand,
      proposalRunIds: ["run-evolution-proposal"],
      validationRunIds: ["run-evolution-validation"],
      heldOutRunIds: ["run-evolution-held-out"],
      heldOutEvalTargets: [evalPath],
      candidatePath,
      sessionId: "evo-fixture",
      cliCommand: `${process.execPath} ${cliPath}`,
      createdAt: "2026-08-10T12:10:00.000Z",
    });
    expect(session.state).toBe("draft");
    expect(readFileSync(sourcePath, "utf-8")).toBe(BASE_ADAPTER);

    const manifestPath = join(
      root,
      "evolution",
      session.session_id,
      "session.json",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      candidate: { path: string };
    };
    const candidateArtifactPath = manifest.candidate.path;
    manifest.candidate.path = join(root, "outside-candidate.yaml");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await expect(
      readEvolutionSession(evolutionStore, session.session_id),
    ).rejects.toThrow(/artifact path/);
    manifest.candidate.path = candidateArtifactPath;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const verified = await verifyEvolutionSession({
      store: evolutionStore,
      sessionId: session.session_id,
      adapterCommand,
      verifiedAt: "2026-08-10T12:20:00.000Z",
    });
    expect(verified.report.decision).toMatchObject({
      eligible: true,
      candidate_changed: true,
      strict_validation_improvement: true,
      held_out_present: true,
      held_out_no_regression: true,
    });
    expect(verified.report.validation.baseline.passed).toBe(0);
    expect(verified.report.validation.candidate.passed).toBe(1);
    expect(verified.report.held_out.baseline.passed).toBe(0);
    expect(verified.report.held_out.candidate.passed).toBe(2);
    expect(readFileSync(verified.report.patch_path, "utf-8")).toContain(
      "+# candidate-success",
    );

    const promoted = await promoteEvolutionSession({
      store: evolutionStore,
      sessionId: session.session_id,
      promotedAt: "2026-08-10T12:30:00.000Z",
    });
    expect(promoted.session.state).toBe("promoted");
    expect(readFileSync(sourcePath, "utf-8")).toContain("candidate-success");

    const rolledBack = await rollbackEvolutionSession({
      store: evolutionStore,
      sessionId: session.session_id,
      rolledBackAt: "2026-08-10T12:40:00.000Z",
    });
    expect(rolledBack.session.state).toBe("rolled_back");
    expect(rolledBack.restored).toBe("previous_overlay");
    expect(readFileSync(sourcePath, "utf-8")).toBe(BASE_ADAPTER);
  });
});

async function writeFailedReplayRun(
  runRoot: string,
  runId: string,
): Promise<void> {
  const store = createRunStore({ rootDir: runRoot });
  const metadata: RunTraceMetadata = {
    run_id: runId,
    trace_id: `01H${runId.replaceAll(/[^A-Za-z0-9]/g, "").toUpperCase()}`,
    command: "evolution-fixture.probe",
    site: "evolution-fixture",
    cmd: "probe",
    adapter_path: "fixture/probe.yaml",
    permission_profile: "open",
    transport_surface: "cli",
    target_surface: "web",
    pipeline_steps: 1,
  };
  const sequence = createRunEventSequence();
  const error = {
    code: "selector_miss",
    message:
      "selector failed at https://example.com/?token=secret-value api_key: leaked-key",
    adapter_path: metadata.adapter_path,
    step: 0,
    retryable: false,
  };
  const result = {
    exit_code: 1,
    result_count: 0,
    duration_ms: 12,
    error,
    envelope: { command: metadata.command, error },
  };
  await appendRunEvent(
    store,
    createRunStartedEvent(metadata, sequence, {
      timestamp: "2026-08-10T11:00:00.000Z",
    }),
  );
  await appendRunEvent(
    store,
    createEnvironmentSnapshotEvent(metadata, sequence, {
      schema_version: "1",
      unicli_version: "1.1.1",
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
      ci: true,
      permission_profile: "open",
      transport_surface: "cli",
      target_surface: "web",
      pipeline_steps: 1,
    }),
  );
  await appendRunEvent(store, {
    ...createToolCallStartedEvent(metadata, sequence),
    secret: {
      replay: {
        schema_version: "1",
        site: "evolution-fixture",
        cmd: "probe",
        args: {},
        source: "shell",
        permission_profile: "open",
        approved: false,
        note: "private replay value",
      },
    },
  });
  await appendRunEvent(
    store,
    createEvidenceCapturedEvent(metadata, sequence, {
      evidence_type: "result-envelope",
      data: {
        outcome: "failure",
        exit_code: 1,
        result_count: 0,
        duration_ms: 12,
        has_error: true,
      },
    }),
  );
  await appendRunEvent(
    store,
    createToolCallFailedEvent(metadata, sequence, result),
  );
  await appendRunEvent(store, createRunFailedEvent(metadata, sequence, result));
}
