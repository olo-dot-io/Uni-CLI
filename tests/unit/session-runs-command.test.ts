import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Command } from "commander";

import { createBrowserSessionLease } from "../../src/engine/browser/session-lease.js";
import {
  createEvidenceCapturedEvent,
  createRuntimePermissionDeniedEvent,
  createRunCompletedEvent,
  createRunEventSequence,
  createRunFailedEvent,
  createRunStartedEvent,
  createToolCallCompletedEvent,
  createToolCallFailedEvent,
  createToolCallStartedEvent,
  type RunTraceMetadata,
} from "../../src/engine/session/events.js";
import {
  appendRunEvent,
  createRunStore,
} from "../../src/engine/session/store.js";
import { registerRunsCommand } from "../../src/commands/runs.js";
import {
  compileAll,
  _resetCompiledCacheForTests,
} from "../../src/engine/invoke.js";
import { registerAdapter } from "../../src/registry.js";
import {
  AdapterType,
  ExitCode,
  type AdapterManifest,
} from "../../src/types.js";

function captureConsole(): {
  getStdout: () => string;
  getStderr: () => string;
  restore: () => void;
} {
  let out = "";
  let err = "";
  const origLog = console.log;
  const origError = console.error;
  console.log = ((...args: unknown[]) => {
    out += args.map(String).join(" ") + "\n";
  }) as typeof console.log;
  console.error = ((...args: unknown[]) => {
    err += args.map(String).join(" ") + "\n";
  }) as typeof console.error;
  return {
    getStdout: () => out,
    getStderr: () => err,
    restore: () => {
      console.log = origLog;
      console.error = origError;
    },
  };
}

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.option("-f, --format <fmt>", "output format");
  registerRunsCommand(program);
  return program;
}

describe("unicli runs command", () => {
  let tmp: string;
  const originalExitCode = process.exitCode;
  const replayFixture: AdapterManifest = {
    name: "runs-replay-fixture",
    type: AdapterType.WEB_API,
    commands: {
      echo: {
        name: "echo",
        description: "Echo replay args",
        adapterArgs: [
          { name: "query", type: "str", required: true, positional: true },
        ],
        func: async (_page, kwargs) => ({ echoed: kwargs.query }),
      },
    },
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "unicli-runs-command-"));
    process.exitCode = undefined;
    _resetCompiledCacheForTests();
    registerAdapter(replayFixture);
    compileAll([replayFixture]);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    process.exitCode = originalExitCode;
  });

  async function writeBrowserRun(rootDir: string): Promise<string> {
    const store = createRunStore({ rootDir });
    const lease = createBrowserSessionLease({
      namespace: "browser",
      workspace: "browser:default",
      expectedDomain: "example.com",
    });
    lease.target = {
      kind: "daemon-tab",
      captured_at: "2026-04-29T01:00:00.000Z",
      window_id: 9,
      tab_id: 27,
    };
    lease.auth = {
      state: "cookies_present",
      captured_at: "2026-04-29T01:00:00.000Z",
      cookie_count: 2,
    };
    const metadata: RunTraceMetadata = {
      run_id: "run-browser-01",
      trace_id: "01HTRACEBROWSER0000000000",
      command: "browser.click",
      site: "browser",
      cmd: "click",
      adapter_path: "browser",
      permission_profile: "open",
      transport_surface: "cli",
      target_surface: "web",
      args_hash: "sha256:browser",
      pipeline_steps: 0,
      browser_lease: lease,
    };
    const sequence = createRunEventSequence();
    await appendRunEvent(
      store,
      createRunStartedEvent(metadata, sequence, {
        timestamp: "2026-04-29T01:00:00.000Z",
      }),
    );
    await appendRunEvent(
      store,
      createEvidenceCapturedEvent(metadata, sequence, {
        evidence_type: "browser-operator",
        data: { phase: "after", outcome: "success" },
        internal: { screenshot: "private" },
        secret: { token: "hidden" },
        timestamp: "2026-04-29T01:00:01.000Z",
      }),
    );
    await appendRunEvent(store, {
      ...createRunCompletedEvent(metadata, sequence, { status: "ok" }),
      timestamp: "2026-04-29T01:00:02.000Z",
    });
    return metadata.run_id;
  }

  async function writeRuntimeDeniedRun(rootDir: string): Promise<string> {
    const store = createRunStore({ rootDir });
    const metadata: RunTraceMetadata = {
      run_id: "run-runtime-denied-01",
      trace_id: "01HTRACERUNTIME000000000",
      command: "browser.fetch",
      site: "browser",
      cmd: "fetch",
      adapter_path: "src/adapters/browser/fetch.yaml",
      permission_profile: "locked",
      transport_surface: "cli",
      target_surface: "web",
      args_hash: "sha256:runtime-denied",
      pipeline_steps: 1,
    };
    const sequence = createRunEventSequence();
    const error = {
      code: "permission_denied",
      message: "runtime domain is blocked",
      adapter_path: metadata.adapter_path,
    };
    const resultData = {
      exit_code: 77,
      result_count: 0,
      duration_ms: 16,
      error,
      envelope: { command: "browser.fetch", error },
    };
    await appendRunEvent(
      store,
      createRunStartedEvent(metadata, sequence, {
        timestamp: "2026-04-29T01:10:00.000Z",
      }),
    );
    await appendRunEvent(store, {
      ...createToolCallStartedEvent(metadata, sequence),
      timestamp: "2026-04-29T01:10:01.000Z",
    });
    await appendRunEvent(store, {
      ...createRuntimePermissionDeniedEvent(
        metadata,
        sequence,
        {
          code: "permission_denied",
          adapter_path: metadata.adapter_path,
          action: "fetch_text",
          step: 0,
          rule_id: "deny-blocked-runtime",
          resource_buckets: ["domains", "urls"],
          retryable: false,
        },
        {
          resources: {
            domains: ["blocked.example"],
            urls: ["https://blocked.example/secret?token=hidden"],
          },
        },
      ),
      timestamp: "2026-04-29T01:10:02.000Z",
    });
    await appendRunEvent(store, {
      ...createToolCallFailedEvent(metadata, sequence, resultData),
      timestamp: "2026-04-29T01:10:03.000Z",
    });
    await appendRunEvent(store, {
      ...createRunFailedEvent(metadata, sequence, resultData),
      timestamp: "2026-04-29T01:10:04.000Z",
    });
    return metadata.run_id;
  }

  async function writeReplayableRun(rootDir: string): Promise<string> {
    const store = createRunStore({ rootDir });
    const metadata: RunTraceMetadata = {
      run_id: "run-replayable-01",
      trace_id: "01HTRACEREPLAY0000000000",
      command: "runs-replay-fixture.echo",
      site: "runs-replay-fixture",
      cmd: "echo",
      adapter_path: "src/adapters/runs-replay-fixture/echo.yaml",
      permission_profile: "open",
      transport_surface: "cli",
      target_surface: "web",
      args_hash:
        "sha256:b3dc61a04d0090681b39ec6e9610cdc3dd998ed6cbf784840ffb53b4d184eed1",
      pipeline_steps: 0,
    };
    const sequence = createRunEventSequence();
    await appendRunEvent(
      store,
      createRunStartedEvent(metadata, sequence, {
        timestamp: "2026-04-29T02:00:00.000Z",
      }),
    );
    await appendRunEvent(store, {
      ...createToolCallStartedEvent(metadata, sequence),
      timestamp: "2026-04-29T02:00:01.000Z",
      secret: {
        replay: {
          schema_version: "1",
          site: "runs-replay-fixture",
          cmd: "echo",
          args: { query: "hello replay" },
          source: "shell",
          permission_profile: "open",
          approved: false,
          args_hash: metadata.args_hash,
        },
      },
    });
    const resultData = {
      exit_code: 0,
      result_count: 1,
      duration_ms: 10,
      outcome: "success",
      envelope: { command: "runs-replay-fixture.echo" },
    };
    await appendRunEvent(store, {
      ...createToolCallCompletedEvent(metadata, sequence, resultData),
      timestamp: "2026-04-29T02:00:02.000Z",
    });
    await appendRunEvent(
      store,
      createEvidenceCapturedEvent(metadata, sequence, {
        evidence_type: "result-envelope",
        data: {
          outcome: "success",
          exit_code: 0,
          result_count: 1,
          duration_ms: 10,
          adapter_path: metadata.adapter_path,
          envelope_command: "runs-replay-fixture.echo",
          has_error: false,
        },
        timestamp: "2026-04-29T02:00:03.000Z",
      }),
    );
    await appendRunEvent(store, {
      ...createRunCompletedEvent(metadata, sequence, resultData),
      timestamp: "2026-04-29T02:00:04.000Z",
    });
    return metadata.run_id;
  }

  async function writeDivergedRun(rootDir: string): Promise<string> {
    const store = createRunStore({ rootDir });
    const metadata: RunTraceMetadata = {
      run_id: "run-drifted-01",
      trace_id: "01HTRACEDRIFT00000000000",
      command: "runs-replay-fixture.echo",
      site: "runs-replay-fixture",
      cmd: "echo",
      adapter_path: "src/adapters/runs-replay-fixture/echo.yaml",
      permission_profile: "open",
      transport_surface: "cli",
      target_surface: "web",
      args_hash:
        "sha256:b3dc61a04d0090681b39ec6e9610cdc3dd998ed6cbf784840ffb53b4d184eed1",
      pipeline_steps: 0,
    };
    const sequence = createRunEventSequence();
    const error = {
      code: "auth_required",
      message: "auth drift",
      adapter_path: metadata.adapter_path,
    };
    const resultData = {
      exit_code: 77,
      result_count: 0,
      duration_ms: 12,
      error,
      envelope: { command: "runs-replay-fixture.echo", error },
    };
    await appendRunEvent(
      store,
      createRunStartedEvent(metadata, sequence, {
        timestamp: "2026-04-29T02:10:00.000Z",
      }),
    );
    await appendRunEvent(store, {
      ...createToolCallStartedEvent(metadata, sequence),
      timestamp: "2026-04-29T02:10:01.000Z",
    });
    await appendRunEvent(store, {
      ...createToolCallFailedEvent(metadata, sequence, resultData),
      timestamp: "2026-04-29T02:10:02.000Z",
    });
    await appendRunEvent(
      store,
      createEvidenceCapturedEvent(metadata, sequence, {
        evidence_type: "result-envelope",
        data: {
          outcome: "failure",
          exit_code: 77,
          result_count: 0,
          duration_ms: 12,
          adapter_path: metadata.adapter_path,
          envelope_command: "runs-replay-fixture.echo",
          has_error: true,
        },
        timestamp: "2026-04-29T02:10:03.000Z",
      }),
    );
    await appendRunEvent(store, {
      ...createRunFailedEvent(metadata, sequence, resultData),
      timestamp: "2026-04-29T02:10:04.000Z",
    });
    return metadata.run_id;
  }

  it("lists run summaries with browser lease identity", async () => {
    const rootDir = join(tmp, "runs");
    await writeBrowserRun(rootDir);

    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(
        ["-f", "json", "runs", "list", "--root", rootDir],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as {
      ok: boolean;
      command: string;
      data: {
        runs: Array<{
          run_id: string;
          command: string;
          status: string;
          events: number;
          browser_session_id: string;
          browser_workspace_id: string;
          browser_target_kind?: string;
          browser_tab_id?: number;
          browser_window_id?: number;
          browser_auth_state?: string;
          browser_cookie_count?: number;
        }>;
      };
    };
    expect(env.ok).toBe(true);
    expect(env.command).toBe("runs.list");
    expect(env.data.runs).toHaveLength(1);
    expect(env.data.runs[0]).toMatchObject({
      run_id: "run-browser-01",
      command: "browser.click",
      status: "completed",
      events: 3,
      browser_workspace_id: "browser:default",
      browser_target_kind: "daemon-tab",
      browser_tab_id: 27,
      browser_window_id: 9,
      browser_auth_state: "cookies_present",
      browser_cookie_count: 2,
    });
    expect(env.data.runs[0].browser_session_id).toMatch(/^browser-session:/);
  });

  it("lists runtime permission deny summaries without raw resources", async () => {
    const rootDir = join(tmp, "runs");
    await writeRuntimeDeniedRun(rootDir);

    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(
        ["-f", "json", "runs", "list", "--root", rootDir],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as {
      data: {
        runs: Array<{
          run_id: string;
          runtime_permission_denied?: {
            code: string;
            action: string;
            step: number;
            rule_id: string;
            resource_buckets: string[];
            retryable: boolean;
          };
        }>;
      };
    };
    expect(env.data.runs[0]).toMatchObject({
      run_id: "run-runtime-denied-01",
      runtime_permission_denied: {
        code: "permission_denied",
        action: "fetch_text",
        step: 0,
        rule_id: "deny-blocked-runtime",
        resource_buckets: ["domains", "urls"],
        retryable: false,
      },
    });
    expect(cap.getStdout()).not.toContain("blocked.example");
    expect(cap.getStdout()).not.toContain("/secret?token=hidden");
  });

  it("skips unexpected run directories with invalid ids", async () => {
    const rootDir = join(tmp, "runs");
    await writeBrowserRun(rootDir);
    mkdirSync(join(rootDir, "bad run id"), { recursive: true });

    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(
        ["-f", "json", "runs", "list", "--root", rootDir],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as {
      data: { runs: Array<{ run_id: string }> };
    };
    expect(env.data.runs.map((run) => run.run_id)).toEqual(["run-browser-01"]);
  });

  it("marks malformed traces unreadable without failing the list", async () => {
    const rootDir = join(tmp, "runs");
    await writeBrowserRun(rootDir);
    const brokenRunDir = join(rootDir, "run-broken-01");
    mkdirSync(brokenRunDir, { recursive: true });
    writeFileSync(join(brokenRunDir, "trace.jsonl"), "{not json}\n");

    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(
        ["-f", "json", "runs", "list", "--root", rootDir],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as {
      data: {
        runs: Array<{ run_id: string; status: string; error_code?: string }>;
      };
    };
    expect(env.data.runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          run_id: "run-broken-01",
          status: "unreadable",
          error_code: "malformed_jsonl",
        }),
      ]),
    );
  });

  it("shows public events without internal or secret payloads by default", async () => {
    const rootDir = join(tmp, "runs");
    const runId = await writeBrowserRun(rootDir);

    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(
        ["-f", "json", "runs", "show", runId, "--root", rootDir],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as {
      data: {
        run_id: string;
        events: Array<Record<string, unknown>>;
      };
    };
    expect(env.data.run_id).toBe(runId);
    expect(env.data.events).toHaveLength(3);
    expect(env.data.events[1]).not.toHaveProperty("internal");
    expect(env.data.events[1]).not.toHaveProperty("secret");
  });

  it("shows runtime permission deny summaries without raw resources", async () => {
    const rootDir = join(tmp, "runs");
    const runId = await writeRuntimeDeniedRun(rootDir);

    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(
        ["-f", "json", "runs", "show", runId, "--root", rootDir],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as {
      data: {
        summary: {
          runtime_permission_denied?: {
            code: string;
            action: string;
            step: number;
            rule_id: string;
            resource_buckets: string[];
            retryable: boolean;
          };
        };
      };
    };
    expect(env.data.summary.runtime_permission_denied).toEqual({
      code: "permission_denied",
      action: "fetch_text",
      step: 0,
      rule_id: "deny-blocked-runtime",
      resource_buckets: ["domains", "urls"],
      retryable: false,
    });
    expect(cap.getStdout()).not.toContain("blocked.example");
    expect(cap.getStdout()).not.toContain("/secret?token=hidden");
  });

  it("can include internal event payloads while still redacting secret payloads", async () => {
    const rootDir = join(tmp, "runs");
    const runId = await writeBrowserRun(rootDir);

    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(
        [
          "-f",
          "json",
          "runs",
          "show",
          runId,
          "--root",
          rootDir,
          "--include-internal",
        ],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as {
      data: {
        events: Array<Record<string, unknown>>;
      };
    };
    expect(env.data.events[1]).toHaveProperty("internal", {
      screenshot: "private",
    });
    expect(env.data.events[1]).not.toHaveProperty("secret");
  });

  it("probes legacy traces as not replayable when exact args are absent", async () => {
    const rootDir = join(tmp, "runs");
    const runId = await writeBrowserRun(rootDir);

    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(
        ["-f", "json", "runs", "probe", runId, "--root", rootDir],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as {
      data: { replay: { replayable: boolean; reason: string } };
    };
    expect(env.data.replay.replayable).toBe(false);
    expect(env.data.replay.reason).toContain("recorded before replay payloads");
  });

  it("probes replayable traces without exposing argument values", async () => {
    const rootDir = join(tmp, "runs");
    const runId = await writeReplayableRun(rootDir);

    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(
        ["-f", "json", "runs", "probe", runId, "--root", rootDir],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as {
      data: {
        replay: {
          replayable: boolean;
          command: string;
          argument_keys: string[];
        };
      };
    };
    expect(env.data.replay).toMatchObject({
      replayable: true,
      command: "runs-replay-fixture.echo",
      argument_keys: ["query"],
    });
    expect(cap.getStdout()).not.toContain("hello replay");
  });

  it("replays a recorded trace and records the replay as a new run", async () => {
    const rootDir = join(tmp, "runs");
    const runId = await writeReplayableRun(rootDir);

    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(
        [
          "-f",
          "json",
          "runs",
          "replay",
          runId,
          "--root",
          rootDir,
          "--replay-run-id",
          "run-replayed-01",
        ],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as {
      ok: boolean;
      data: {
        original_run_id: string;
        replay_run_id: string;
        result: {
          exit_code: number;
          result_count: number;
          envelope: { command: string; error?: unknown };
        };
        comparison: {
          status: string;
          behavior: { diverged: number; unknown: number };
        };
      };
    };
    expect(env.ok).toBe(true);
    expect(env.data).toMatchObject({
      original_run_id: runId,
      replay_run_id: "run-replayed-01",
      result: {
        exit_code: 0,
        result_count: 1,
        envelope: { command: "runs-replay-fixture.echo" },
      },
      comparison: {
        status: "match",
        behavior: { diverged: 0, unknown: 0 },
      },
    });

    const replayEvents = JSON.parse(cap.getStdout().trim()) as typeof env;
    expect(replayEvents.data.result.envelope.error).toBeUndefined();

    const probeCap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(
        ["-f", "json", "runs", "probe", "run-replayed-01", "--root", rootDir],
        { from: "user" },
      );
    } finally {
      probeCap.restore();
    }
    const probeEnv = JSON.parse(probeCap.getStdout().trim()) as {
      data: {
        replay: {
          replayable: boolean;
          argument_keys: string[];
          source: string;
        };
      };
    };
    expect(probeEnv.data.replay).toMatchObject({
      replayable: true,
      argument_keys: ["query"],
      source: "shell",
    });
  });

  it("compares replay traces without exposing argument values", async () => {
    const rootDir = join(tmp, "runs");
    const runId = await writeReplayableRun(rootDir);

    const replayCap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(
        [
          "-f",
          "json",
          "runs",
          "replay",
          runId,
          "--root",
          rootDir,
          "--replay-run-id",
          "run-replayed-01",
        ],
        { from: "user" },
      );
    } finally {
      replayCap.restore();
    }

    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(
        [
          "-f",
          "json",
          "runs",
          "compare",
          runId,
          "run-replayed-01",
          "--root",
          rootDir,
        ],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as {
      ok: boolean;
      command: string;
      data: {
        status: string;
        behavior: { match: number; diverged: number; unknown: number };
        checks: Array<{ name: string; status: string }>;
      };
    };
    expect(env.ok).toBe(true);
    expect(env.command).toBe("runs.compare");
    expect(env.data.status).toBe("match");
    expect(env.data.behavior.diverged).toBe(0);
    expect(env.data.behavior.unknown).toBe(0);
    expect(env.data.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "command", status: "match" }),
        expect.objectContaining({ name: "args_hash", status: "match" }),
        expect.objectContaining({ name: "result_count", status: "match" }),
      ]),
    );
    expect(cap.getStdout()).not.toContain("hello replay");
  });

  it("reports behavioral divergence between run traces", async () => {
    const rootDir = join(tmp, "runs");
    const runId = await writeReplayableRun(rootDir);
    const driftedRunId = await writeDivergedRun(rootDir);

    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(
        [
          "-f",
          "json",
          "runs",
          "compare",
          runId,
          driftedRunId,
          "--root",
          rootDir,
        ],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as {
      data: {
        status: string;
        behavior: { diverged: number };
        checks: Array<{ name: string; status: string }>;
      };
    };
    expect(env.data.status).toBe("diverged");
    expect(env.data.behavior.diverged).toBeGreaterThan(0);
    expect(env.data.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "status", status: "diverged" }),
        expect.objectContaining({ name: "exit_code", status: "diverged" }),
        expect.objectContaining({ name: "error_code", status: "unknown" }),
        expect.objectContaining({
          name: "result_envelope_has_error",
          status: "diverged",
        }),
      ]),
    );
  });

  it("rejects compare when either trace is missing", async () => {
    const rootDir = join(tmp, "runs");
    const runId = await writeReplayableRun(rootDir);

    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(
        [
          "-f",
          "json",
          "runs",
          "compare",
          runId,
          "run-missing-01",
          "--root",
          rootDir,
        ],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(env.ok).toBe(false);
    expect(env.error).toMatchObject({
      code: "invalid_input",
      message: "run trace not found or empty: run-missing-01",
    });
    expect(process.exitCode).toBe(ExitCode.USAGE_ERROR);
  });

  it("rejects invalid replay run ids before executing", async () => {
    const rootDir = join(tmp, "runs");
    const runId = await writeReplayableRun(rootDir);

    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(
        [
          "-f",
          "json",
          "runs",
          "replay",
          runId,
          "--root",
          rootDir,
          "--replay-run-id",
          "../escape",
        ],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(env.ok).toBe(false);
    expect(env.error).toMatchObject({
      code: "invalid_input",
      message: "invalid run id: ../escape",
    });
    expect(process.exitCode).toBe(ExitCode.USAGE_ERROR);
  });

  it("rejects replay run ids that already have a trace", async () => {
    const rootDir = join(tmp, "runs");
    const runId = await writeReplayableRun(rootDir);

    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(
        [
          "-f",
          "json",
          "runs",
          "replay",
          runId,
          "--root",
          rootDir,
          "--replay-run-id",
          runId,
        ],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(env.ok).toBe(false);
    expect(env.error).toMatchObject({
      code: "invalid_input",
      message: `replay run id already exists: ${runId}`,
    });
    expect(process.exitCode).toBe(ExitCode.USAGE_ERROR);
  });
});
