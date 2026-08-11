import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
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
  let originalPermissionProfile: string | undefined;
  let sourcePath: string;
  let runRoot: string;
  let adapterCommand: AdapterCommand;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "unicli-evolution-"));
    originalHome = process.env.HOME;
    originalPermissionProfile = process.env.UNICLI_PERMISSION_PROFILE;
    delete process.env.UNICLI_PERMISSION_PROFILE;
    process.env.HOME = join(root, "home");
    sourcePath = join(
      process.env.HOME,
      ".unicli",
      "adapters",
      "evolution-fixture",
      "probe.yml",
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
    await writeFailedReplayRun(runRoot, "run-evolution-auth", "auth_required");
  });

  function sessionInput(
    evolutionStore: ReturnType<typeof createEvolutionStore>,
  ): Parameters<typeof createAdapterEvolutionSession>[0] {
    return {
      evolutionStore,
      runStore: createRunStore({ rootDir: runRoot }),
      site: "evolution-fixture",
      command: "probe",
      adapterCommand,
      proposalRunIds: ["run-evolution-proposal"],
    };
  }

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalPermissionProfile === undefined) {
      delete process.env.UNICLI_PERMISSION_PROFILE;
    } else {
      process.env.UNICLI_PERMISSION_PROFILE = originalPermissionProfile;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("inherits the active permission profile for paired evaluation", async () => {
    process.env.UNICLI_PERMISSION_PROFILE = "locked";
    const session = await createAdapterEvolutionSession(
      sessionInput(
        createEvolutionStore({
          rootDir: join(root, "evolution-locked-profile"),
        }),
      ),
    );

    expect(session.component.scope.permission_profile).toBe("locked");
  });

  it("persists path-like eval targets and the run store as absolute paths", async () => {
    const session = await createAdapterEvolutionSession({
      ...sessionInput(
        createEvolutionStore({
          rootDir: join(root, "evolution-durable-paths"),
        }),
      ),
      validationEvalTargets: ["relative-evals/check.yaml"],
      heldOutEvalTargets: ["fixture-logical-name", "smoke/github"],
    });

    expect(session.runtime.run_root).toBe(runRoot);
    expect(session.datasets.validation_eval_targets).toEqual([
      join(process.cwd(), "relative-evals", "check.yaml"),
    ]);
    expect(session.datasets.held_out_eval_targets[0]).toBe(
      "fixture-logical-name",
    );
    expect(session.datasets.held_out_eval_targets[1]).toBe(
      join(process.cwd(), "evals", "smoke", "github.yaml"),
    );
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
        approved_network_origins: [],
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
    expect(packet.provenance).toEqual({
      source: "local-run-store",
      content_trust: "untrusted",
      redaction: "applied",
      raw_trace_policy: "local-reference-only",
    });
    expect(packet.sources[0].error?.message).toContain("token=<redacted>");
    expect(packet.sources[0].error?.message).toContain("api_key=<redacted>");
    expect(packet.sources[0].error?.message).toContain(
      '"api_key":"<redacted>"',
    );
    expect(packet.sources[0].error?.message).toContain('"token":"<redacted>"');
    expect(JSON.stringify(packet)).not.toContain("private replay value");
    expect(JSON.stringify(packet)).not.toContain("json-api-secret");
    expect(JSON.stringify(packet)).not.toContain("json-token-secret");
  });

  it("rejects run ids reused across evolution data splits", async () => {
    await expect(
      createAdapterEvolutionSession({
        ...sessionInput(
          createEvolutionStore({ rootDir: join(root, "evolution-overlap") }),
        ),
        validationRunIds: ["run-evolution-proposal"],
      }),
    ).rejects.toThrow(/must be disjoint/);
  });

  it("refuses to evolve adapters from non-repairable proposal failures", async () => {
    await expect(
      createAdapterEvolutionSession({
        ...sessionInput(
          createEvolutionStore({
            rootDir: join(root, "evolution-auth-failure"),
          }),
        ),
        proposalRunIds: ["run-evolution-auth"],
      }),
    ).rejects.toThrow(
      /outside the adapter repair boundary.*authentication_context/,
    );
  });

  it.each([
    ["invalid_input", "caller_input"],
    ["network_error", "upstream_environment"],
  ])(
    "keeps %s failures outside the adapter mutation boundary",
    async (errorCode, failureClass) => {
      const runId = `run-evolution-${errorCode}`;
      await writeFailedReplayRun(runRoot, runId, errorCode);

      await expect(
        createAdapterEvolutionSession({
          ...sessionInput(
            createEvolutionStore({
              rootDir: join(root, `evolution-${errorCode}`),
            }),
          ),
          proposalRunIds: [runId],
        }),
      ).rejects.toThrow(
        new RegExp(`outside the adapter repair boundary.*${failureClass}`),
      );
    },
  );

  it("uses the shared repair classifier for adapter-drift evidence", async () => {
    const runId = "run-evolution-not-found";
    await writeFailedReplayRun(runRoot, runId, "not_found");

    await expect(
      createAdapterEvolutionSession({
        ...sessionInput(
          createEvolutionStore({
            rootDir: join(root, "evolution-not-found"),
          }),
        ),
        proposalRunIds: [runId],
      }),
    ).resolves.toMatchObject({ state: "draft" });
  });

  it("creates exactly one session when Agents race on the same id", async () => {
    const evolutionStore = createEvolutionStore({
      rootDir: join(root, "evolution-create-race"),
    });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        createAdapterEvolutionSession({
          ...sessionInput(evolutionStore),
          sessionId: "evo-create-race",
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(7);
    await expect(
      readEvolutionSession(evolutionStore, "evo-create-race"),
    ).resolves.toMatchObject({ state: "draft", attempts: [] });
  });

  it.each([
    {
      name: "adapter identity",
      candidate: BASE_ADAPTER.replace(
        "description: Probe the evolution fixture",
        "description: Route a different operation",
      ),
      field: "identity_contract",
    },
    {
      name: "operation effect",
      candidate: BASE_ADAPTER.replace(
        "operation_effect: read",
        "operation_effect: destructive",
      ),
      field: "operation_effect",
    },
    {
      name: "network origin",
      candidate: BASE_ADAPTER.replace("example.com", "evil.example"),
      field: "network_origins",
    },
    {
      name: "network method",
      candidate: BASE_ADAPTER.replace(
        "url: https://example.com/status",
        "url: https://example.com/status\n      method: POST",
      ),
      field: "network_methods",
    },
    {
      name: "request headers",
      candidate: BASE_ADAPTER.replace(
        "url: https://example.com/status",
        "url: https://example.com/status\n      headers:\n        Authorization: Bearer candidate",
      ),
      field: "request_headers",
    },
    {
      name: "pipeline actions",
      candidate: BASE_ADAPTER.replace(
        "  - fetch:\n      url: https://example.com/status",
        "  - exec:\n      command: uname",
      ),
      field: "pipeline_actions",
    },
    {
      name: "input contract",
      candidate: BASE_ADAPTER.replace(
        "pipeline:",
        "args:\n  query: { type: str }\npipeline:",
      ),
      field: "input_contract",
    },
    {
      name: "output contract",
      candidate: BASE_ADAPTER.replace(
        "pipeline:",
        "columns: [status]\npipeline:",
      ),
      field: "output_contract",
    },
  ])("rejects candidates that change the verified $name", async (entry) => {
    const candidatePath = join(root, "scope-changing-candidate.yaml");
    writeFileSync(candidatePath, entry.candidate);

    await expect(
      createAdapterEvolutionSession({
        ...sessionInput(
          createEvolutionStore({
            rootDir: join(root, "evolution-scope-change"),
          }),
        ),
        candidatePath,
      }),
    ).rejects.toThrow(
      new RegExp(`changes evolution scope fields: .*${entry.field}`),
    );
  });

  it("allows implementation repair inside the verified contract", async () => {
    const candidatePath = join(root, "same-contract-candidate.yaml");
    writeFileSync(
      candidatePath,
      BASE_ADAPTER.replace("example.com/status", "example.com/v2/status"),
    );
    await expect(
      createAdapterEvolutionSession({
        ...sessionInput(
          createEvolutionStore({
            rootDir: join(root, "evolution-same-contract"),
          }),
        ),
        candidatePath,
        prediction: {
          hypothesis: "the upstream path moved within the verified origin",
          expected_fixes: ["run-evolution-proposal"],
          at_risk: [],
        },
      }),
    ).resolves.toMatchObject({ state: "draft", attempts: [] });
  });

  it("rejects changing an existing subprocess invocation", async () => {
    const execBaseline = BASE_ADAPTER.replace(
      "type: web-api\nstrategy: public",
      "type: bridge\nstrategy: public\nbinary: printf",
    )
      .replace(
        "  - fetch:\n      url: https://example.com/status",
        "  - exec:\n      command: printf\n      args: [baseline]",
      )
      .replace(
        'capabilities: ["http.fetch"]\nminimum_capability: http.fetch\ntrust: public',
        'capabilities: ["subprocess.exec"]\nminimum_capability: subprocess.exec\ntrust: user',
      );
    writeFileSync(sourcePath, execBaseline);
    const candidatePath = join(root, "exec-changing-candidate.yaml");
    writeFileSync(
      candidatePath,
      execBaseline.replace("args: [baseline]", "args: [candidate]"),
    );

    await expect(
      createAdapterEvolutionSession({
        ...sessionInput(
          createEvolutionStore({
            rootDir: join(root, "evolution-exec-change"),
          }),
        ),
        adapterCommand: {
          ...adapterCommand,
          adapter_path: sourcePath,
          capabilities: ["subprocess.exec"],
          minimum_capability: "subprocess.exec",
        },
        proposalRunIds: ["run-evolution-proposal"],
        candidatePath,
      }),
    ).rejects.toThrow(/changes evolution scope fields: .*exec_contract/);
  });

  it("allows an explicitly scoped network-origin repair", async () => {
    const candidatePath = join(root, "approved-origin-candidate.yaml");
    writeFileSync(
      candidatePath,
      BASE_ADAPTER.replace("example.com", "api.example.com"),
    );
    const session = await createAdapterEvolutionSession({
      ...sessionInput(
        createEvolutionStore({
          rootDir: join(root, "evolution-approved-origin"),
        }),
      ),
      candidatePath,
      approvedNetworkOrigins: ["api.example.com"],
      prediction: {
        hypothesis: "the adapter moved to an explicitly reviewed API origin",
        expected_fixes: ["run-evolution-proposal"],
        at_risk: [],
      },
    });
    expect(session.component.scope.approved_network_origins).toEqual([
      "https://api.example.com",
    ]);
  });

  it("requires an independent confirmed-effect verifier for mutation evals", async () => {
    const mutatingCommand: AdapterCommand = {
      ...adapterCommand,
      operation_effect: "create",
    };
    registerAdapter({
      name: "evolution-fixture",
      type: AdapterType.WEB_API,
      commands: {
        probe: {
          ...mutatingCommand,
          adapter_path: undefined,
          source_tier: "runtime",
        },
      },
    });
    const evalPath = join(root, "mutation-without-verifier.yaml");
    writeFileSync(
      evalPath,
      [
        "name: mutation-without-verifier",
        "adapter: evolution-fixture",
        "cases:",
        "  - id: mutate",
        "    command: probe",
        "    judges:",
        "      - { type: exitCode, equals: 0 }",
        "",
      ].join("\n"),
    );
    const evolutionStore = createEvolutionStore({
      rootDir: join(root, "evolution-mutation-verifier"),
    });
    const session = await createAdapterEvolutionSession({
      ...sessionInput(evolutionStore),
      adapterCommand: mutatingCommand,
      validationEvalTargets: [evalPath],
      allowMutationEval: true,
    });
    writeFileSync(session.candidate.path, `${BASE_ADAPTER}# candidate\n`);

    await expect(
      verifyEvolutionSession({
        store: evolutionStore,
        sessionId: session.session_id,
        adapterCommand: mutatingCommand,
        prediction: {
          hypothesis: "the candidate repairs the mutation",
          expected_fixes: ["mutate"],
          at_risk: [],
        },
      }),
    ).rejects.toThrow(/without an effectStatus=confirmed verifier/);
  });

  it("rejects promotion when a packaged baseline changed after verification", async () => {
    const packagedSourcePath = join(root, "packaged", "probe.yaml");
    mkdirSync(dirname(packagedSourcePath), { recursive: true });
    writeFileSync(packagedSourcePath, BASE_ADAPTER);
    const packagedCommand: AdapterCommand = {
      ...adapterCommand,
      adapter_path: packagedSourcePath,
      source_tier: "packaged",
    };
    registerAdapter({
      name: "evolution-fixture",
      type: AdapterType.WEB_API,
      commands: {
        probe: {
          ...adapterCommand,
          adapter_path: undefined,
          source_tier: "runtime",
        },
      },
    });
    const candidatePath = join(root, "packaged-candidate.yaml");
    writeFileSync(candidatePath, `${BASE_ADAPTER}# candidate-success\n`);
    const evolutionStore = createEvolutionStore({
      rootDir: join(root, "evolution-packaged-baseline"),
    });
    const session = await createAdapterEvolutionSession({
      ...sessionInput(evolutionStore),
      adapterCommand: packagedCommand,
      validationRunIds: ["run-evolution-validation"],
      heldOutRunIds: ["run-evolution-held-out"],
      candidatePath,
      prediction: {
        hypothesis: "the candidate repairs both recorded selector failures",
        expected_fixes: ["run-evolution-validation", "run-evolution-held-out"],
        at_risk: [],
      },
      cliCommand: `${process.execPath} ${writeFakeEvolutionCli(root)}`,
      sessionId: "evo-packaged-baseline",
    });
    const verified = await verifyEvolutionSession({
      store: evolutionStore,
      sessionId: session.session_id,
      adapterCommand: packagedCommand,
    });
    expect(verified.report.decision.eligible).toBe(true);

    writeFileSync(packagedSourcePath, `${BASE_ADAPTER}# package-update\n`);
    await expect(
      promoteEvolutionSession({
        store: evolutionStore,
        sessionId: session.session_id,
      }),
    ).rejects.toThrow(/adapter source changed after the evolution session/);
    expect(
      existsSync(
        join(
          process.env.HOME!,
          ".unicli",
          "adapters",
          "evolution-fixture",
          "probe.yaml",
        ),
      ),
    ).toBe(false);
  });

  it("verifies, promotes, and rolls back one isolated adapter candidate", async () => {
    registerAdapter({
      name: "evolution-fixture",
      type: AdapterType.WEB_API,
      commands: { probe: adapterCommand },
    });
    const candidatePath = join(root, "candidate.yaml");
    writeFileSync(candidatePath, `${BASE_ADAPTER}# candidate-failure\n`);
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
    const cliPath = writeFakeEvolutionCli(root);
    const evolutionStore = createEvolutionStore({
      rootDir: join(root, "evolution"),
    });
    const session = await createAdapterEvolutionSession({
      ...sessionInput(evolutionStore),
      validationRunIds: ["run-evolution-validation"],
      heldOutRunIds: ["run-evolution-held-out"],
      heldOutEvalTargets: [evalPath],
      candidatePath,
      prediction: {
        hypothesis: "the candidate repairs the recorded selector failure",
        expected_fixes: ["run-evolution-validation", "independent-probe"],
        at_risk: ["run-evolution-held-out"],
      },
      sessionId: "evo-fixture",
      cliCommand: `${process.execPath} ${cliPath}`,
      createdAt: "2026-08-10T12:10:00.000Z",
    });
    expect(session.state).toBe("draft");
    expect(readFileSync(sourcePath, "utf-8")).toBe(BASE_ADAPTER);
    if (process.platform !== "win32") {
      expect(statSync(session.evidence.path).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(session.evidence.path)).mode & 0o777).toBe(0o700);
    }

    const originalEvidence = readFileSync(session.evidence.path, "utf-8");
    writeFileSync(session.evidence.path, `${originalEvidence}tampered\n`);
    await expect(
      readEvolutionSession(evolutionStore, session.session_id),
    ).rejects.toThrow(/integrity check failed.*evidence/i);
    writeFileSync(session.evidence.path, originalEvidence);

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

    const rejected = await verifyEvolutionSession({
      store: evolutionStore,
      sessionId: session.session_id,
      adapterCommand,
      verifiedAt: "2026-08-10T12:15:00.000Z",
    });
    expect(rejected.session.state).toBe("rejected");
    expect(rejected.session.attempts).toHaveLength(1);
    expect(rejected.report.decision.eligible).toBe(false);
    expect(readFileSync(rejected.report.candidate_path, "utf-8")).toContain(
      "candidate-failure",
    );

    writeFileSync(
      session.candidate.path,
      `${BASE_ADAPTER}# candidate-success\n`,
    );
    const falsified = await verifyEvolutionSession({
      store: evolutionStore,
      sessionId: session.session_id,
      adapterCommand,
      prediction: {
        hypothesis: "the candidate repairs every declared failure",
        expected_fixes: ["run-evolution-validation", "missing-expected-fix"],
        at_risk: ["run-evolution-held-out"],
      },
      verifiedAt: "2026-08-10T12:18:00.000Z",
    });
    expect(falsified.session.state).toBe("rejected");
    expect(falsified.report.decision).toMatchObject({
      eligible: false,
      prediction_satisfied: false,
      strict_validation_improvement: true,
      held_out_no_regression: true,
    });
    expect(falsified.report.prediction.expected_missed).toEqual([
      "missing-expected-fix",
    ]);

    const verified = await verifyEvolutionSession({
      store: evolutionStore,
      sessionId: session.session_id,
      adapterCommand,
      prediction: {
        hypothesis: "the candidate repairs the recorded selector failure",
        expected_fixes: ["run-evolution-validation", "independent-probe"],
        at_risk: ["run-evolution-held-out"],
      },
      verifiedAt: "2026-08-10T12:20:00.000Z",
    });
    expect(verified.report.decision).toMatchObject({
      eligible: true,
      candidate_changed: true,
      prediction_satisfied: true,
      strict_validation_improvement: true,
      held_out_present: true,
      held_out_no_regression: true,
    });
    expect(verified.report.validation.baseline.passed).toBe(0);
    expect(verified.report.validation.candidate.passed).toBe(1);
    expect(verified.report.held_out.baseline.passed).toBe(0);
    expect(verified.report.held_out.candidate.passed).toBe(2);
    expect(verified.report.prediction).toMatchObject({
      expected_fixed: ["run-evolution-validation", "independent-probe"],
      expected_missed: [],
      at_risk_regressions: [],
      unexpected_regressions: [],
    });
    expect(verified.session.attempts).toHaveLength(3);
    expect(verified.session.attempts[2]).toMatchObject({
      report: { sha256: expect.stringMatching(/^sha256:/) },
      patch: { sha256: expect.stringMatching(/^sha256:/) },
    });
    expect(verified.session.attempts[0].report.path).not.toBe(
      verified.session.attempts[2].report.path,
    );
    expect(
      readFileSync(verified.session.attempts[0].candidate.path, "utf-8"),
    ).toContain("candidate-failure");
    expect(
      readFileSync(verified.session.attempts[2].candidate.path, "utf-8"),
    ).toContain("candidate-success");
    expect(readFileSync(verified.report.patch_path, "utf-8")).toContain(
      "+# candidate-success",
    );

    const legacyManifest = JSON.parse(
      readFileSync(manifestPath, "utf-8"),
    ) as Record<string, unknown> & {
      attempts: Array<{
        ordinal: number;
        verified_at: string;
        eligible: boolean;
        candidate: { path: string; sha256: string };
        patch: { path: string };
        report: { path: string };
      }>;
    };
    legacyManifest.schema_version = "unicli.evolution-session.v1";
    legacyManifest.attempts = legacyManifest.attempts.map((attempt) => ({
      ordinal: attempt.ordinal,
      verified_at: attempt.verified_at,
      eligible: attempt.eligible,
      candidate_path: attempt.candidate.path,
      candidate_sha256: attempt.candidate.sha256,
      patch_path: attempt.patch.path,
      report_path: attempt.report.path,
    })) as typeof legacyManifest.attempts;
    writeFileSync(manifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`);
    const migrated = await readEvolutionSession(
      evolutionStore,
      session.session_id,
    );
    expect(migrated.schema_version).toBe("unicli.evolution-session.v2");
    expect(migrated.attempts).toHaveLength(3);
    for (const attempt of migrated.attempts) {
      expect(attempt).toMatchObject({
        candidate: { sha256: expect.stringMatching(/^sha256:/) },
        patch: { sha256: expect.stringMatching(/^sha256:/) },
        report: { sha256: expect.stringMatching(/^sha256:/) },
      });
    }
    expect(JSON.parse(readFileSync(manifestPath, "utf-8")).schema_version).toBe(
      "unicli.evolution-session.v2",
    );

    const latestAttempt = verified.session.attempts[2];
    const originalPatch = readFileSync(latestAttempt.patch.path, "utf-8");
    writeFileSync(latestAttempt.patch.path, `${originalPatch}tampered\n`);
    await expect(
      promoteEvolutionSession({
        store: evolutionStore,
        sessionId: session.session_id,
      }),
    ).rejects.toThrow(/integrity check failed.*patch/i);
    writeFileSync(latestAttempt.patch.path, originalPatch);

    const originalReport = readFileSync(latestAttempt.report.path, "utf-8");
    const tamperedReport = JSON.parse(originalReport) as {
      decision: { reasons: string[] };
    };
    tamperedReport.decision.reasons.push("tampered");
    writeFileSync(
      latestAttempt.report.path,
      `${JSON.stringify(tamperedReport, null, 2)}\n`,
    );
    await expect(
      promoteEvolutionSession({
        store: evolutionStore,
        sessionId: session.session_id,
      }),
    ).rejects.toThrow(/integrity check failed.*report/i);
    writeFileSync(latestAttempt.report.path, originalReport);

    const promotionResults = await Promise.allSettled(
      Array.from({ length: 2 }, () =>
        promoteEvolutionSession({
          store: evolutionStore,
          sessionId: session.session_id,
          promotedAt: "2026-08-10T12:30:00.000Z",
        }),
      ),
    );
    expect(
      promotionResults.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      promotionResults.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const promoted = promotionResults.find(
      (result) => result.status === "fulfilled",
    )!.value;
    expect(promoted.session.state).toBe("promoted");
    expect(promoted.session.promotion?.sha256).toMatch(/^sha256:/);
    expect(promoted.report.attempt).toBe(3);
    expect(readFileSync(sourcePath, "utf-8")).toContain("candidate-success");

    const promotionCrashManifest = JSON.parse(
      readFileSync(manifestPath, "utf-8"),
    ) as Record<string, unknown>;
    promotionCrashManifest.state = "verified";
    delete promotionCrashManifest.promotion;
    writeFileSync(
      manifestPath,
      `${JSON.stringify(promotionCrashManifest, null, 2)}\n`,
    );
    const recoveredPromotion = await promoteEvolutionSession({
      store: evolutionStore,
      sessionId: session.session_id,
    });
    expect(recoveredPromotion.session).toMatchObject({
      state: "promoted",
      promotion: { sha256: promoted.session.promotion?.sha256 },
    });

    const promotionRecord = JSON.parse(
      readFileSync(promoted.session.promotion!.path, "utf-8"),
    ) as { rollback_path: string };
    const originalRollback = readFileSync(
      promotionRecord.rollback_path,
      "utf-8",
    );
    writeFileSync(
      promotionRecord.rollback_path,
      `${originalRollback}tampered\n`,
    );
    await expect(
      rollbackEvolutionSession({
        store: evolutionStore,
        sessionId: session.session_id,
      }),
    ).rejects.toThrow(/integrity check failed.*rollback/i);
    writeFileSync(promotionRecord.rollback_path, originalRollback);

    const rollbackResults = await Promise.allSettled(
      Array.from({ length: 2 }, () =>
        rollbackEvolutionSession({
          store: evolutionStore,
          sessionId: session.session_id,
          rolledBackAt: "2026-08-10T12:40:00.000Z",
        }),
      ),
    );
    expect(
      rollbackResults.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      rollbackResults.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const rolledBack = rollbackResults.find(
      (result) => result.status === "fulfilled",
    )!.value;
    expect(rolledBack.session.state).toBe("rolled_back");
    expect(rolledBack.restored).toBe("previous_overlay");
    expect(readFileSync(sourcePath, "utf-8")).toBe(BASE_ADAPTER);

    const rollbackCrashManifest = JSON.parse(
      readFileSync(manifestPath, "utf-8"),
    ) as Record<string, unknown>;
    rollbackCrashManifest.state = "promoted";
    writeFileSync(
      manifestPath,
      `${JSON.stringify(rollbackCrashManifest, null, 2)}\n`,
    );
    await expect(
      rollbackEvolutionSession({
        store: evolutionStore,
        sessionId: session.session_id,
      }),
    ).resolves.toMatchObject({
      session: { state: "rolled_back" },
      restored: "previous_overlay",
    });
  });
});

async function writeFailedReplayRun(
  runRoot: string,
  runId: string,
  errorCode = "selector_miss",
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
    code: errorCode,
    message:
      'selector failed at https://example.com/?token=secret-value api_key: leaked-key payload={"api_key":"json-api-secret","token":"json-token-secret"}',
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

function writeFakeEvolutionCli(root: string): string {
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
  return cliPath;
}
