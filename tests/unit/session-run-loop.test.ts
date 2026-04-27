import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runResolvedCommand } from "../../src/mcp/dispatch.js";
import { runCommand } from "../../src/protocol/acp-helpers.js";
import {
  buildInvocation,
  compileAll,
  _resetCompiledCacheForTests,
} from "../../src/engine/invoke.js";
import {
  createRunStore,
  readRunEvents,
} from "../../src/engine/session/store.js";
import { executeWithRunRecording } from "../../src/engine/session/run-loop.js";
import { registerAdapter } from "../../src/registry.js";
import { AdapterType, type AdapterManifest } from "../../src/types.js";

const fixture: AdapterManifest = {
  name: "session-fixture",
  type: AdapterType.WEB_API,
  commands: {
    read: {
      name: "read",
      description: "Read fixture data",
      adapterArgs: [],
      func: async () => ({ ok: true }),
    },
    fail: {
      name: "fail",
      description: "Read fixture data then fail",
      adapterArgs: [],
      func: async () => {
        throw new Error("fixture failure");
      },
    },
  },
};

const originalRecordRun = process.env.UNICLI_RECORD_RUN;
const originalRunRoot = process.env.UNICLI_RUN_ROOT;

describe("recorded run wrapper", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "unicli-session-run-"));
    delete process.env.UNICLI_RECORD_RUN;
    delete process.env.UNICLI_RUN_ROOT;
    _resetCompiledCacheForTests();
    registerAdapter(fixture);
    compileAll([fixture]);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (originalRecordRun === undefined) {
      delete process.env.UNICLI_RECORD_RUN;
    } else {
      process.env.UNICLI_RECORD_RUN = originalRecordRun;
    }
    if (originalRunRoot === undefined) {
      delete process.env.UNICLI_RUN_ROOT;
    } else {
      process.env.UNICLI_RUN_ROOT = originalRunRoot;
    }
  });

  it("returns the original InvocationResult while recording success events", async () => {
    const store = createRunStore({ rootDir: join(tmp, "runs") });
    const inv = buildInvocation(
      "cli",
      "session-fixture",
      "read",
      { args: {}, source: "shell" },
      { permissionProfile: "open" },
    )!;

    const result = await executeWithRunRecording(inv, {
      enabled: true,
      store,
      runId: "run-success",
    });

    expect(result.exitCode).toBe(0);
    expect(result.results).toEqual([{ ok: true }]);

    const events = await readRunEvents(store, "run-success");
    expect(events.map((event) => event.name)).toEqual([
      "run.started",
      "tool.call.started",
      "permission.evaluated",
      "tool.call.completed",
      "evidence.captured",
      "run.completed",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(events[0].metadata).toMatchObject({
      command: "session-fixture.read",
      adapter_path: "src/adapters/session-fixture/read.yaml",
      permission_profile: "open",
      transport_surface: "cli",
      target_surface: "web",
    });
  });

  it("records failure events with adapter path and error envelope", async () => {
    const store = createRunStore({ rootDir: join(tmp, "runs") });
    const inv = buildInvocation("cli", "session-fixture", "fail", {
      args: {},
      source: "shell",
    })!;

    const result = await executeWithRunRecording(inv, {
      enabled: true,
      store,
      runId: "run-failed",
    });

    expect(result.error?.message).toContain("fixture failure");
    const events = await readRunEvents(store, "run-failed");
    expect(events.map((event) => event.name)).toEqual([
      "run.started",
      "tool.call.started",
      "permission.evaluated",
      "tool.call.failed",
      "evidence.captured",
      "run.failed",
    ]);
    expect(events.at(-2)?.data).toMatchObject({
      evidence_type: "result-envelope",
      outcome: "failure",
    });
    expect(events.at(-1)?.data).toMatchObject({
      error: {
        adapter_path: "src/adapters/session-fixture/fail.yaml",
      },
    });
  });

  it("does not write a trace when recording is disabled", async () => {
    const store = createRunStore({ rootDir: join(tmp, "runs") });
    const inv = buildInvocation("cli", "session-fixture", "read", {
      args: {},
      source: "shell",
    })!;

    const result = await executeWithRunRecording(inv, {
      enabled: false,
      store,
      runId: "run-off",
    });

    expect(result.exitCode).toBe(0);
    await expect(readRunEvents(store, "run-off")).resolves.toEqual([]);
  });

  it("records MCP command runs when the environment gate is enabled", async () => {
    const runRoot = join(tmp, "mcp-runs");
    process.env.UNICLI_RECORD_RUN = "1";
    process.env.UNICLI_RUN_ROOT = runRoot;

    const result = await runResolvedCommand(
      fixture,
      fixture.commands.read,
      "read",
      {},
    );

    expect(result.isError).not.toBe(true);
    const [runId] = readdirSync(runRoot);
    expect(runId).toMatch(/^run-/);
    const events = await readRunEvents(
      createRunStore({ rootDir: runRoot }),
      runId,
    );
    expect(events.map((event) => event.name)).toContain("evidence.captured");
    expect(events[0].metadata).toMatchObject({
      command: "session-fixture.read",
      transport_surface: "mcp",
    });
  });

  it("records ACP command runs when the environment gate is enabled", async () => {
    const runRoot = join(tmp, "acp-runs");
    process.env.UNICLI_RECORD_RUN = "1";
    process.env.UNICLI_RUN_ROOT = runRoot;

    const results = await runCommand(fixture, fixture.commands.read, {});

    expect(results).toEqual([{ ok: true }]);
    const [runId] = readdirSync(runRoot);
    expect(runId).toMatch(/^run-/);
    const events = await readRunEvents(
      createRunStore({ rootDir: runRoot }),
      runId,
    );
    expect(events.map((event) => event.name)).toContain("evidence.captured");
    expect(events[0].metadata).toMatchObject({
      command: "session-fixture.read",
      transport_surface: "acp",
    });
  });
});
