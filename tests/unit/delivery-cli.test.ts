import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Command } from "commander";

import { registerDeliveryCommand } from "../../src/commands/delivery.js";
import { buildDeliveryOperatorSpecTemplate } from "../../src/engine/delivery/spec.js";
import { compileAll } from "../../src/engine/kernel/compile.js";
import {
  createEvidenceCapturedEvent,
  createRunCompletedEvent,
  createRunEventSequence,
  createRunStartedEvent,
  type RunTraceMetadata,
} from "../../src/engine/session/events.js";
import {
  appendRunEvent,
  createRunStore,
  readRunEvents,
} from "../../src/engine/session/store.js";
import { registerAdapter } from "../../src/registry.js";
import { AdapterType, ExitCode } from "../../src/types.js";

function captureConsole(): {
  getStdout: () => string;
  getStderr: () => string;
  restore: () => void;
} {
  let stdout = "";
  let stderr = "";
  const originalLog = console.log;
  const originalError = console.error;
  console.log = ((...args: unknown[]) => {
    stdout += args.map(String).join(" ") + "\n";
  }) as typeof console.log;
  console.error = ((...args: unknown[]) => {
    stderr += args.map(String).join(" ") + "\n";
  }) as typeof console.error;
  return {
    getStdout: () => stdout,
    getStderr: () => stderr,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.option("-f, --format <format>", "output format");
  registerDeliveryCommand(program);
  return program;
}

describe("unicli delivery command", () => {
  let tmp: string;
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "unicli-delivery-cli-"));
    process.exitCode = undefined;
    const fixture = {
      name: "delivery-fixture",
      type: AdapterType.WEB_API,
      commands: {
        read: {
          name: "read",
          description: "Read a deterministic delivery fixture",
          adapterArgs: [{ name: "topic", type: "string", required: true }],
          func: async (_page, args) => [
            { title: `delivered:${String(args.topic)}` },
          ],
        },
      },
    };
    registerAdapter(fixture);
    compileAll([fixture]);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    process.exitCode = originalExitCode;
  });

  async function writeCompletedRun(
    rootDir: string,
    runId = "run-delivery-cli-01",
  ): Promise<string> {
    const store = createRunStore({ rootDir });
    const metadata: RunTraceMetadata = {
      run_id: runId,
      trace_id: "01HDELIVERYCLITEST000001",
      command: "twitter.search",
      site: "twitter",
      cmd: "search",
      adapter_path: "src/adapters/twitter/search.yaml",
      permission_profile: "open",
      transport_surface: "cli",
      target_surface: "web",
      args_hash: "sha256:delivery-cli",
      pipeline_steps: 1,
    };
    const sequence = createRunEventSequence();
    await appendRunEvent(
      store,
      createRunStartedEvent(metadata, sequence, {
        timestamp: "2026-05-24T13:00:00.000Z",
      }),
    );
    await appendRunEvent(
      store,
      createEvidenceCapturedEvent(metadata, sequence, {
        evidence_type: "result-envelope",
        data: { ok: true, rows: 2 },
        timestamp: "2026-05-24T13:00:01.000Z",
      }),
    );
    await appendRunEvent(store, {
      ...createRunCompletedEvent(metadata, sequence, { status: "ok" }),
      timestamp: "2026-05-24T13:00:02.000Z",
    });
    return metadata.run_id;
  }

  it("builds a delivery trajectory from recorded run evidence", async () => {
    const runId = await writeCompletedRun(tmp);
    const specPath = join(tmp, "delivery-spec.json");
    writeFileSync(
      specPath,
      JSON.stringify({
        objective: {
          id: "deliver-twitter-search",
          goal: "Return current search results with reviewable evidence",
          evidence_gates: [
            { kind: "run_completed" },
            {
              kind: "required_evidence_type",
              evidence_type: "result-envelope",
            },
          ],
        },
        strategies: [
          {
            id: "api-adapter",
            kind: "adapter",
            label: "Use bundled Twitter adapter",
            priority: 10,
            command: "twitter.search",
            adapter_path: "src/adapters/twitter/search.yaml",
            verify_command: "unicli test twitter search",
          },
        ],
        runs: [{ run_id: runId, strategy_id: "api-adapter" }],
      }),
      "utf-8",
    );
    const consoleCapture = captureConsole();
    try {
      await createProgram().parseAsync([
        "node",
        "test",
        "-f",
        "json",
        "delivery",
        "trajectory",
        specPath,
        "--root",
        tmp,
        "--recorded-at",
        "2026-05-24T13:00:03.000Z",
      ]);
    } finally {
      consoleCapture.restore();
    }

    const envelope = JSON.parse(consoleCapture.getStdout()) as {
      ok: boolean;
      command: string;
      data: {
        verification_status: string;
        trials: Array<{
          run_id: string;
          status: string;
          failed_gates: string[];
        }>;
      };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toBe("delivery.trajectory");
    expect(envelope.data.verification_status).toBe("verified");
    expect(envelope.data.trials).toEqual([
      expect.objectContaining({
        run_id: runId,
        status: "delivered",
        failed_gates: [],
      }),
    ]);
  });

  it("assigns contiguous attempt ordinals to multiple recorded runs", async () => {
    const firstRunId = await writeCompletedRun(tmp, "run-delivery-cli-01");
    const secondRunId = await writeCompletedRun(tmp, "run-delivery-cli-02");
    const specPath = join(tmp, "multi-run-spec.json");
    writeFileSync(
      specPath,
      JSON.stringify({
        objective: {
          id: "deliver-twitter-search",
          goal: "Return current search results with reviewable evidence",
        },
        strategies: [
          {
            id: "api-adapter",
            kind: "adapter",
            label: "Use bundled Twitter adapter",
            priority: 10,
            command: "twitter.search",
          },
        ],
        runs: [
          { run_id: firstRunId, strategy_id: "api-adapter" },
          { run_id: secondRunId, strategy_id: "api-adapter" },
        ],
      }),
      "utf-8",
    );
    const consoleCapture = captureConsole();
    try {
      await createProgram().parseAsync([
        "node",
        "test",
        "-f",
        "json",
        "delivery",
        "trajectory",
        specPath,
        "--root",
        tmp,
      ]);
    } finally {
      consoleCapture.restore();
    }

    const envelope = JSON.parse(consoleCapture.getStdout()) as {
      data: { trials: Array<{ ordinal: number }> };
    };
    expect(envelope.data.trials.map((trial) => trial.ordinal)).toEqual([1, 2]);
  });

  it("emits a bounded repair candidate from a repairable delivery spec", async () => {
    const specPath = join(tmp, "repair-spec.json");
    writeFileSync(
      specPath,
      JSON.stringify({
        objective: {
          id: "deliver-twitter-search",
          goal: "Return current search results with reviewable evidence",
          evidence_gates: [{ kind: "run_completed" }],
        },
        strategies: [
          {
            id: "api-adapter",
            kind: "adapter",
            label: "Use bundled Twitter adapter",
            priority: 10,
            command: "twitter.search",
            adapter_path: "src/adapters/twitter/search.yaml",
            verify_command: "unicli test twitter search",
          },
        ],
        attempts: [
          {
            id: "attempt-01",
            ordinal: 1,
            strategy_id: "api-adapter",
            run_id: "run-repairable-01",
            summary: {
              run_id: "run-repairable-01",
              status: "failed",
              events: 4,
              evidence_count: 0,
              evidence_by_type: {},
            },
            error: {
              code: "selector_miss",
              message: "result selector no longer matches",
              adapter_path: "src/adapters/twitter/search.yaml",
              step: 2,
              retryable: true,
            },
          },
        ],
      }),
      "utf-8",
    );
    const consoleCapture = captureConsole();
    try {
      await createProgram().parseAsync([
        "node",
        "test",
        "-f",
        "json",
        "delivery",
        "repair-candidate",
        specPath,
      ]);
    } finally {
      consoleCapture.restore();
    }

    const envelope = JSON.parse(consoleCapture.getStdout()) as {
      ok: boolean;
      command: string;
      data: {
        candidate: {
          adapter_path: string;
          verify_command: string;
          diagnosis_code: string;
        };
      };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toBe("delivery.repair-candidate");
    expect(envelope.data.candidate).toMatchObject({
      adapter_path: "src/adapters/twitter/search.yaml",
      verify_command: "unicli test twitter search",
      diagnosis_code: "adapter_drift",
    });
  });

  it("runs the next delivery experiment through the shared kernel and records the attempt", async () => {
    const specPath = join(tmp, "run-spec.json");
    writeFileSync(
      specPath,
      JSON.stringify({
        objective: {
          id: "deliver-fixture-read",
          goal: "Run the next strategy and prove it with recorded evidence",
          evidence_gates: [
            { kind: "run_completed" },
            {
              kind: "required_evidence_type",
              evidence_type: "result-envelope",
            },
          ],
        },
        strategies: [
          {
            id: "fixture-adapter",
            kind: "adapter",
            label: "Use the delivery fixture adapter",
            priority: 10,
            command: "delivery-fixture.read",
            args: { topic: "closed-loop" },
          },
        ],
      }),
      "utf-8",
    );
    const consoleCapture = captureConsole();
    try {
      await createProgram().parseAsync([
        "node",
        "test",
        "-f",
        "json",
        "delivery",
        "run",
        specPath,
        "--root",
        tmp,
        "--run-id",
        "run-delivery-fixture-01",
      ]);
    } finally {
      consoleCapture.restore();
    }

    const events = await readRunEvents(
      createRunStore({ rootDir: tmp }),
      "run-delivery-fixture-01",
    );
    const envelope = JSON.parse(consoleCapture.getStdout()) as {
      ok: boolean;
      command: string;
      data: {
        run_id: string;
        strategy_id: string;
        result: { exit_code: number; result_count: number };
        trajectory: {
          verification_status: string;
          trials: Array<{ run_id: string; status: string }>;
        };
      };
    };

    expect(envelope.ok).toBe(true);
    expect(envelope.command).toBe("delivery.run");
    expect(envelope.data.run_id).toBe("run-delivery-fixture-01");
    expect(envelope.data.strategy_id).toBe("fixture-adapter");
    expect(envelope.data.result).toMatchObject({
      exit_code: 0,
      result_count: 1,
    });
    expect(envelope.data.trajectory.verification_status).toBe("verified");
    expect(envelope.data.trajectory.trials).toEqual([
      expect.objectContaining({
        run_id: "run-delivery-fixture-01",
        status: "delivered",
      }),
    ]);
    expect(events.map((event) => event.name)).toContain("run.completed");
  });

  it("accepts a generated delivery spec template as an active trajectory", async () => {
    const specPath = join(tmp, "generated-template-spec.json");
    const spec = buildDeliveryOperatorSpecTemplate({
      intent: "Read the deterministic delivery fixture",
      site: "delivery-fixture",
      command: "read",
      description: "Read a deterministic delivery fixture",
      adapter_type: AdapterType.WEB_API,
      target_surface: "web",
      args: { topic: "closed-loop" },
    });
    writeFileSync(specPath, JSON.stringify(spec), "utf-8");
    const consoleCapture = captureConsole();
    try {
      await createProgram().parseAsync([
        "node",
        "test",
        "-f",
        "json",
        "delivery",
        "trajectory",
        specPath,
        "--root",
        tmp,
        "--recorded-at",
        "2026-05-24T13:00:03.000Z",
      ]);
    } finally {
      consoleCapture.restore();
    }

    const envelope = JSON.parse(consoleCapture.getStdout()) as {
      ok: boolean;
      command: string;
      data: {
        verification_status: string;
        next_experiment: { command: string; action: string };
      };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toBe("delivery.trajectory");
    expect(envelope.data.verification_status).toBe("active");
    expect(envelope.data.next_experiment).toMatchObject({
      action: "run_strategy",
      command: "delivery-fixture.read",
    });
  });

  it("does not execute repair-only delivery states as normal experiments", async () => {
    const specPath = join(tmp, "repair-only-run-spec.json");
    writeFileSync(
      specPath,
      JSON.stringify({
        objective: {
          id: "deliver-fixture-repair-only",
          goal: "Stop before executing repair-only states",
          evidence_gates: [{ kind: "run_completed" }],
        },
        strategies: [
          {
            id: "fixture-adapter",
            kind: "adapter",
            label: "Use the delivery fixture adapter",
            priority: 10,
            command: "delivery-fixture.read",
            args: { topic: "closed-loop" },
            verify_command: "unicli test delivery-fixture read",
          },
        ],
        attempts: [
          {
            id: "attempt-01",
            ordinal: 1,
            strategy_id: "fixture-adapter",
            run_id: "run-repair-only-01",
            summary: {
              run_id: "run-repair-only-01",
              status: "failed",
              events: 4,
              evidence_count: 0,
              evidence_by_type: {},
            },
            error: {
              code: "selector_miss",
              message: "selector drift",
              adapter_path: "src/adapters/twitter/search.yaml",
              step: 2,
              retryable: true,
            },
          },
        ],
      }),
      "utf-8",
    );
    const consoleCapture = captureConsole();
    try {
      await createProgram().parseAsync([
        "node",
        "test",
        "-f",
        "json",
        "delivery",
        "run",
        specPath,
        "--root",
        tmp,
      ]);
    } finally {
      consoleCapture.restore();
    }

    const envelope = JSON.parse(consoleCapture.getStderr()) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(consoleCapture.getStdout()).toBe("");
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toMatchObject({
      code: "invalid_input",
      message:
        "delivery next action is not directly executable: repair_adapter",
    });
  });

  it("returns a structured error envelope for invalid specs", async () => {
    const specPath = join(tmp, "invalid-spec.json");
    writeFileSync(specPath, JSON.stringify({ objective: {} }), "utf-8");
    const consoleCapture = captureConsole();
    try {
      await createProgram().parseAsync([
        "node",
        "test",
        "-f",
        "json",
        "delivery",
        "assess",
        specPath,
      ]);
    } finally {
      consoleCapture.restore();
    }

    const envelope = JSON.parse(consoleCapture.getStderr()) as {
      ok: boolean;
      command: string;
      error: { code: string };
    };
    expect(consoleCapture.getStdout()).toBe("");
    expect(process.exitCode).toBe(ExitCode.USAGE_ERROR);
    expect(envelope.ok).toBe(false);
    expect(envelope.command).toBe("delivery.assess");
    expect(envelope.error.code).toBe("invalid_input");
  });

  it("rejects run refs that point at unknown strategies", async () => {
    const specPath = join(tmp, "invalid-run-strategy-spec.json");
    writeFileSync(
      specPath,
      JSON.stringify({
        objective: {
          id: "deliver-twitter-search",
          goal: "Return current search results with reviewable evidence",
        },
        strategies: [
          {
            id: "api-adapter",
            kind: "adapter",
            label: "Use bundled Twitter adapter",
            priority: 10,
          },
        ],
        runs: [{ run_id: "run-missing-01", strategy_id: "typo-adapter" }],
      }),
      "utf-8",
    );
    const consoleCapture = captureConsole();
    try {
      await createProgram().parseAsync([
        "node",
        "test",
        "-f",
        "json",
        "delivery",
        "trajectory",
        specPath,
        "--root",
        tmp,
      ]);
    } finally {
      consoleCapture.restore();
    }

    const envelope = JSON.parse(consoleCapture.getStderr()) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(consoleCapture.getStdout()).toBe("");
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toMatchObject({
      code: "invalid_input",
      message: "runs[].strategy_id references unknown strategy: typo-adapter",
    });
  });

  it("rejects malformed optional numeric fields instead of ignoring them", async () => {
    const specPath = join(tmp, "invalid-number-spec.json");
    writeFileSync(
      specPath,
      JSON.stringify({
        objective: {
          id: "deliver-twitter-search",
          goal: "Return current search results with reviewable evidence",
          attempt_budget: { max_attempts: "3" },
        },
        strategies: [
          {
            id: "api-adapter",
            kind: "adapter",
            label: "Use bundled Twitter adapter",
            priority: 10,
          },
        ],
      }),
      "utf-8",
    );
    const consoleCapture = captureConsole();
    try {
      await createProgram().parseAsync([
        "node",
        "test",
        "-f",
        "json",
        "delivery",
        "assess",
        specPath,
      ]);
    } finally {
      consoleCapture.restore();
    }

    const envelope = JSON.parse(consoleCapture.getStderr()) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(consoleCapture.getStdout()).toBe("");
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toMatchObject({
      code: "invalid_input",
      message: "attempt_budget.max_attempts must be a finite number",
    });
  });
});
