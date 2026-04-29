import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
    "runtime-deny": {
      name: "runtime-deny",
      description: "Fetch denied runtime data",
      adapterArgs: [],
      pipeline: [
        {
          fetch_text: {
            url: "https://blocked.example/secret?token=hidden",
          },
        },
      ],
    },
  },
};

const originalRecordRun = process.env.UNICLI_RECORD_RUN;
const originalRunRoot = process.env.UNICLI_RUN_ROOT;
const originalPermissionRulesPath = process.env.UNICLI_PERMISSION_RULES_PATH;
const originalCi = process.env.CI;
const originalGithubActions = process.env.GITHUB_ACTIONS;

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
    if (originalPermissionRulesPath === undefined) {
      delete process.env.UNICLI_PERMISSION_RULES_PATH;
    } else {
      process.env.UNICLI_PERMISSION_RULES_PATH = originalPermissionRulesPath;
    }
    if (originalCi === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = originalCi;
    }
    if (originalGithubActions === undefined) {
      delete process.env.GITHUB_ACTIONS;
    } else {
      process.env.GITHUB_ACTIONS = originalGithubActions;
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
      "environment.snapshot",
      "tool.call.started",
      "permission.evaluated",
      "tool.call.completed",
      "evidence.captured",
      "run.completed",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(events[0].metadata).toMatchObject({
      command: "session-fixture.read",
      adapter_path: "src/adapters/session-fixture/read.yaml",
      permission_profile: "open",
      transport_surface: "cli",
      target_surface: "web",
    });
    expect(events[1].data).toMatchObject({
      schema_version: "1",
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
      ci: Boolean(process.env.CI || process.env.GITHUB_ACTIONS),
      permission_profile: "open",
      transport_surface: "cli",
      target_surface: "web",
      pipeline_steps: 0,
    });
    expect(typeof events[1].data?.unicli_version).toBe("string");
    expect(events[1].visibility).toBe("public");
    expect(events[1]).not.toHaveProperty("internal");
    expect(events[1]).not.toHaveProperty("secret");
    expect(JSON.stringify(events[1])).not.toContain(tmp);
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
      "environment.snapshot",
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

  it("does not treat false-like CI environment values as active CI", async () => {
    const store = createRunStore({ rootDir: join(tmp, "runs") });
    process.env.CI = "false";
    process.env.GITHUB_ACTIONS = "0";
    const inv = buildInvocation("cli", "session-fixture", "read", {
      args: {},
      source: "shell",
    })!;

    await executeWithRunRecording(inv, {
      enabled: true,
      store,
      runId: "run-ci-false",
    });

    const events = await readRunEvents(store, "run-ci-false");
    const environment = events.find(
      (event) => event.name === "environment.snapshot",
    );
    expect(environment?.data?.ci).toBe(false);
  });

  it("records runtime permission denies as redacted trace decisions", async () => {
    const store = createRunStore({ rootDir: join(tmp, "runs") });
    const rulesPath = join(tmp, "permission-rules.json");
    writeFileSync(
      rulesPath,
      JSON.stringify({
        schema_version: "1",
        rules: [
          {
            id: "deny-blocked-runtime",
            decision: "deny",
            match: {
              resources: { domains: ["blocked.example"] },
            },
            reason: "runtime domain is blocked",
          },
        ],
      }),
      "utf-8",
    );
    process.env.UNICLI_PERMISSION_RULES_PATH = rulesPath;
    const inv = buildInvocation("cli", "session-fixture", "runtime-deny", {
      args: {},
      source: "shell",
    })!;

    const result = await executeWithRunRecording(inv, {
      enabled: true,
      store,
      runId: "run-runtime-denied",
    });

    expect(result.error?.code).toBe("permission_denied");
    const events = await readRunEvents(store, "run-runtime-denied");
    expect(events.map((event) => event.name)).toEqual([
      "run.started",
      "environment.snapshot",
      "tool.call.started",
      "permission.evaluated",
      "permission.runtime_denied",
      "tool.call.failed",
      "evidence.captured",
      "run.failed",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    const runtimeDenied = events.find(
      (event) => event.name === "permission.runtime_denied",
    );
    expect(runtimeDenied?.data).toMatchObject({
      code: "permission_denied",
      adapter_path: "src/adapters/session-fixture/runtime-deny.yaml",
      action: "fetch_text",
      step: 0,
      rule_id: "deny-blocked-runtime",
      resource_buckets: ["domains"],
      retryable: false,
    });
    expect(runtimeDenied?.internal).toEqual({
      resources: { domains: ["blocked.example"] },
    });
    expect(runtimeDenied).not.toHaveProperty("secret");
    expect(JSON.stringify(runtimeDenied?.data)).not.toContain(
      "/secret?token=hidden",
    );
  });

  it("records structured permission config errors before execution", async () => {
    const store = createRunStore({ rootDir: join(tmp, "runs") });
    const rulesPath = join(tmp, "permission-rules.json");
    writeFileSync(rulesPath, '{"schema_version":', "utf-8");
    process.env.UNICLI_PERMISSION_RULES_PATH = rulesPath;
    const inv = buildInvocation("cli", "session-fixture", "read", {
      args: {},
      source: "shell",
    })!;

    const result = await executeWithRunRecording(inv, {
      enabled: true,
      store,
      runId: "run-bad-rules",
    });

    expect(result.error).toMatchObject({
      code: "invalid_input",
      adapter_path: "src/adapters/session-fixture/read.yaml",
    });
    const events = await readRunEvents(store, "run-bad-rules");
    const permission = events.find(
      (event) => event.name === "permission.evaluated",
    );
    expect(permission?.data).toMatchObject({
      error: { code: "invalid_input" },
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
