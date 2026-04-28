import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Command } from "commander";

import { createBrowserSessionLease } from "../../src/engine/browser/session-lease.js";
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
} from "../../src/engine/session/store.js";
import { registerRunsCommand } from "../../src/commands/runs.js";

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

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "unicli-runs-command-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  async function writeBrowserRun(rootDir: string): Promise<string> {
    const store = createRunStore({ rootDir });
    const lease = createBrowserSessionLease({
      namespace: "browser",
      workspace: "browser:default",
      expectedDomain: "example.com",
    });
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
    });
    expect(env.data.runs[0].browser_session_id).toMatch(/^browser-session:/);
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
});
