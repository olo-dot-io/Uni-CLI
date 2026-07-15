import { existsSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Command } from "commander";

import { browserBrokerPaths } from "../../../src/browser/runtime-transport.js";
import { registerBrowserCommands } from "../../../src/commands/browser/index.js";
import { InMemoryBrowserRuntimeHarness } from "../../helpers/in-memory-browser-runtime.js";

let runtime: InMemoryBrowserRuntimeHarness;
let previousRuntimeRoot: string | undefined;

beforeEach(async () => {
  previousRuntimeRoot = process.env.UNICLI_BROWSER_RUNTIME_DIR;
  runtime = new InMemoryBrowserRuntimeHarness();
  process.env.UNICLI_BROWSER_RUNTIME_DIR = runtime.runtimeRoot;
  process.exitCode = undefined;
  await runtime.start();
});

afterEach(async () => {
  await runtime.cleanup();
  if (previousRuntimeRoot === undefined) {
    delete process.env.UNICLI_BROWSER_RUNTIME_DIR;
  } else {
    process.env.UNICLI_BROWSER_RUNTIME_DIR = previousRuntimeRoot;
  }
  process.exitCode = undefined;
});

describe("unicli browser broker command surface", () => {
  it("reports broker/provider/session truth without starting a browser target", async () => {
    const result = await runCommand(["browser", "status", "--json"]);

    expect(result.stderr).toBe("");
    expect(result.data).toMatchObject({
      state: "running",
      status: {
        runtime_id: runtime.broker.runtimeId,
        providers: {
          managed: [],
          chrome: { connected: false, target_count: 0 },
          remote: { configured: false, target_count: 0 },
        },
        sessions: { sessions: [], target_leases: [] },
      },
    });
    expect(runtime.provider.acquireCount).toBe(0);
  });

  it("defaults to a hidden managed target and reuses it across turns of one Agent session", async () => {
    const opened = await runCommand([
      "browser",
      "--session",
      "agent-a",
      "--turn",
      "turn-1",
      "open",
      "https://example.com/path",
    ]);
    const state = await runCommand([
      "browser",
      "--session",
      "agent-a",
      "--turn",
      "turn-2",
      "state",
      "--compact",
    ]);

    expect(opened.stderr).toBe("");
    expect(opened.data).toMatchObject({
      requested_url: "https://example.com/path",
      url: "https://example.com/path",
      title: "Example fixture",
      workspace: "default",
    });
    expect(state.data).toEqual({
      url: "https://example.com/path",
      snapshot: "[1]<button>Continue</button>",
    });
    expect(runtime.provider.acquireCount).toBe(1);
    expect(runtime.provider.pages[0]?.visibility).toBe("hidden");

    const status = await brokerStatus();
    expect(status.sessions.sessions).toEqual([
      expect.objectContaining({
        agent_session_id: "agent-a",
        active_turn_ids: [],
        target_ids: [runtime.provider.pages[0]!.targetId],
      }),
    ]);
    expect(status.sessions.target_leases).toEqual([
      expect.objectContaining({
        owner_session_id: "agent-a",
        provider: "managed",
        visibility: "hidden",
        profile_partition_id: "default",
      }),
    ]);
  });

  it("keeps different Agent sessions on distinct targets while sharing one profile runtime", async () => {
    await runCommand([
      "browser",
      "--session",
      "agent-left",
      "--turn",
      "turn-left",
      "start",
    ]);
    await runCommand([
      "browser",
      "--session",
      "agent-right",
      "--turn",
      "turn-right",
      "start",
    ]);

    expect(runtime.provider.acquireCount).toBe(2);
    expect(
      new Set(runtime.provider.pages.map((page) => page.targetId)).size,
    ).toBe(2);
    const status = await brokerStatus();
    expect(status.providers.managed).toEqual([
      expect.objectContaining({
        profile_partition_id: "default",
        target_count: 2,
        visibility: "hidden",
      }),
    ]);
    expect(status.sessions.sessions).toHaveLength(2);
  });

  it("releases an isolated managed target when its owning turn ends", async () => {
    const started = await runCommand([
      "browser",
      "--session",
      "isolated-agent",
      "--turn",
      "isolated-turn",
      "--isolated",
      "start",
    ]);

    expect(started.error).toBeNull();
    expect(runtime.provider.acquireCount).toBe(1);
    expect(runtime.provider.releaseCount).toBe(1);
    const status = await brokerStatus();
    expect(status.sessions.target_leases).toEqual([]);
    expect(status.sessions.sessions).toEqual([
      expect.objectContaining({
        agent_session_id: "isolated-agent",
        active_turn_ids: [],
        target_ids: [],
      }),
    ]);
  });

  it("rejects visibility escalation instead of falling back to another provider", async () => {
    const result = await runCommand([
      "browser",
      "--provider",
      "managed",
      "--visibility",
      "foreground",
      "start",
    ]);

    expect(result.data).toBeNull();
    expect(result.error).toMatchObject({
      code: "browser_invocation_scope_invalid",
      retryable: false,
    });
    expect(result.error?.message).toContain("requires hidden visibility");
    expect(runtime.provider.acquireCount).toBe(0);
  });

  it("returns the exact Chrome provider error when background control has no native host", async () => {
    const result = await runCommand([
      "browser",
      "--provider",
      "chrome",
      "--visibility",
      "background",
      "start",
    ]);

    expect(result.data).toBeNull();
    expect(result.error).toMatchObject({
      code: "chrome_provider_unavailable",
      retryable: true,
    });
    expect(runtime.provider.acquireCount).toBe(0);
  });

  it("bind defaults to the Chrome background provider without allocating a managed target", async () => {
    const result = await runCommand([
      "browser",
      "--session",
      "chrome-agent",
      "bind",
      "10",
    ]);

    expect(result.data).toBeNull();
    expect(result.error).toMatchObject({
      code: "chrome_provider_unavailable",
      retryable: true,
    });
    expect(runtime.provider.acquireCount).toBe(0);
  });

  it("ends an explicit session and releases only its broker-owned targets", async () => {
    await runCommand([
      "browser",
      "--session",
      "agent-a",
      "--turn",
      "turn-a",
      "start",
    ]);
    await runCommand([
      "browser",
      "--session",
      "agent-b",
      "--turn",
      "turn-b",
      "start",
    ]);

    const ended = await runCommand(["browser", "session-end", "agent-a"]);

    expect(ended.data).toMatchObject({
      agent_session_id: "agent-a",
      released_targets: [
        expect.objectContaining({ owner_session_id: "agent-a" }),
      ],
    });
    expect(runtime.provider.releaseCount).toBe(1);
    const status = await brokerStatus();
    expect(
      status.sessions.sessions.map((entry) => entry.agent_session_id),
    ).toEqual(["agent-b"]);
    expect(status.sessions.target_leases).toHaveLength(1);
  });

  it("reports and retries a provider release that failed after session end", async () => {
    await runCommand(["browser", "--session", "retry-release-agent", "start"]);
    runtime.provider.releaseFailuresRemaining = 1;

    const ended = await runCommand([
      "browser",
      "session-end",
      "retry-release-agent",
    ]);

    expect(ended.data).toBeNull();
    expect(ended.error?.message).toContain("Injected target release failure");
    expect((await brokerStatus()).sessions).toMatchObject({
      sessions: [],
      target_leases: [],
      pending_release_session_ids: ["retry-release-agent"],
    });
    expect(runtime.provider.pages[0]?.closed).toBe(false);

    await runtime.broker.reapIdleSessions();

    expect(runtime.provider.releaseAttemptCount).toBe(2);
    expect(runtime.provider.releaseCount).toBe(1);
    expect(runtime.provider.pages[0]?.closed).toBe(true);
    expect((await brokerStatus()).sessions.pending_release_session_ids).toEqual(
      [],
    );
  });

  it("probes a stopped broker without auto-starting or creating endpoint files", async () => {
    await runtime.stopControlPlane();
    const result = await runCommand(["browser", "status", "--json"]);

    expect(result.data).toEqual({ state: "stopped" });
    expect(runtime.provider.acquireCount).toBe(0);
    expect(
      existsSync(browserBrokerPaths(runtime.runtimeRoot).descriptorPath),
    ).toBe(false);
  });

  it("stops idempotently when no broker owns the runtime endpoint", async () => {
    await runtime.stopControlPlane();

    const result = await runCommand(["browser", "broker", "stop"]);

    expect(result.stderr).toBe("");
    expect(result.data).toEqual({
      state: "stopped",
      already_stopped: true,
    });
    expect(
      existsSync(browserBrokerPaths(runtime.runtimeRoot).descriptorPath),
    ).toBe(false);
  });
});

async function brokerStatus() {
  return runtime.status();
}

async function runCommand(args: string[]): Promise<{
  data: Record<string, unknown> | null;
  error?: { code: string; message: string; retryable: boolean };
  stdout: string;
  stderr: string;
}> {
  const program = new Command();
  program.exitOverride();
  program.option("-f, --format <format>", "output format");
  registerBrowserCommands(program);
  let stdout = "";
  let stderr = "";
  const originalLog = console.log;
  const originalError = console.error;
  console.log = ((...values: unknown[]) => {
    stdout += `${values.map(String).join(" ")}\n`;
  }) as typeof console.log;
  console.error = ((...values: unknown[]) => {
    stderr += `${values.map(String).join(" ")}\n`;
  }) as typeof console.error;
  try {
    await program.parseAsync(["-f", "json", ...args], { from: "user" });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  const serialized = (stdout || stderr).trim();
  const envelope = JSON.parse(serialized) as {
    data: Record<string, unknown> | null;
    error?: { code: string; message: string; retryable: boolean };
  };
  return { ...envelope, stdout, stderr };
}
