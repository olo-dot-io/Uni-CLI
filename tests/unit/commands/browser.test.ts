import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Command } from "commander";

import { browserBrokerPaths } from "../../../src/browser/runtime-transport.js";
import type { BrowserTargetCommandResult } from "../../../src/browser/runtime-protocol.js";
import { registerBrowserCommands } from "../../../src/commands/browser/index.js";
import { InMemoryBrowserRuntimeHarness } from "../../helpers/in-memory-browser-runtime.js";

let runtime: InMemoryBrowserRuntimeHarness;
let previousRuntimeRoot: string | undefined;
let previousPermissionRulesPath: string | undefined;

beforeEach(async () => {
  previousRuntimeRoot = process.env.UNICLI_BROWSER_RUNTIME_DIR;
  previousPermissionRulesPath = process.env.UNICLI_PERMISSION_RULES_PATH;
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
  if (previousPermissionRulesPath === undefined) {
    delete process.env.UNICLI_PERMISSION_RULES_PATH;
  } else {
    process.env.UNICLI_PERMISSION_RULES_PATH = previousPermissionRulesPath;
  }
  process.exitCode = undefined;
});

describe("unicli browser broker command surface", () => {
  it("blocks direct browser actions before acquiring a broker target", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "unicli-browser-policy-"));
    try {
      const policyPath = join(tmp, "policy.json");
      writeFileSync(
        policyPath,
        JSON.stringify({
          schema_version: "2",
          default: "deny",
          rules: [],
        }),
        "utf-8",
      );
      process.env.UNICLI_PERMISSION_RULES_PATH = policyPath;

      const result = await runCommand([
        "browser",
        "open",
        "https://example.com/blocked",
      ]);

      expect(result.stdout).toBe("");
      expect(result.error).toMatchObject({
        code: "permission_denied",
        message: expect.stringContaining("policy-default-deny"),
        retryable: false,
      });
      expect(process.exitCode).toBe(77);
      expect(runtime.provider.acquireCount).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("blocks every direct browser command family before local side effects", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "unicli-browser-command-policy-"));
    const previousHome = process.env.HOME;
    try {
      const policyPath = join(tmp, "policy.yaml");
      writeFileSync(
        policyPath,
        ["schema_version: '2'", "default: deny", "rules: []", ""].join("\n"),
        "utf-8",
      );
      process.env.HOME = tmp;
      process.env.UNICLI_PERMISSION_RULES_PATH = policyPath;

      for (const args of [
        ["browser", "profiles"],
        ["browser", "cookies", "example.com"],
        ["browser", "native-host", "install"],
        ["browser", "native-host", "extension-path"],
        ["browser", "init", "policy-blocked/example"],
        ["browser", "verify", "policy-blocked/example"],
      ]) {
        const result = await runCommand(args);
        expect(result.stdout, args.join(" ")).toBe("");
        expect(result.error, args.join(" ")).toMatchObject({
          code: "permission_denied",
          message: expect.stringContaining("policy-default-deny"),
          retryable: false,
        });
        expect(process.exitCode, args.join(" ")).toBe(77);
        process.exitCode = undefined;
      }

      expect(existsSync(join(tmp, ".unicli"))).toBe(false);
      expect(runtime.provider.acquireCount).toBe(0);
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("authorizes the resolved provider and visibility before browser startup", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "unicli-browser-scope-policy-"));
    try {
      const policyPath = join(tmp, "policy.json");
      writeFileSync(
        policyPath,
        JSON.stringify({
          schema_version: "2",
          default: "deny",
          rules: [
            {
              id: "allow-hidden-managed-start",
              decision: "allow",
              match: {
                site: "browser",
                command: "start",
                arguments: {
                  provider: { allowed: ["managed"] },
                  visibility: { allowed: ["hidden"] },
                },
              },
              reason: "allow only the windowless managed runtime",
            },
          ],
        }),
        "utf-8",
      );
      process.env.UNICLI_PERMISSION_RULES_PATH = policyPath;

      const allowed = await runCommand(["browser", "start"]);
      expect(allowed.error).toBeNull();
      expect(allowed.data).toMatchObject({
        provider: "managed",
        visibility: "hidden",
      });
      expect(runtime.provider.acquireCount).toBe(1);

      const denied = await runCommand(["browser", "--focus", "start"]);
      expect(denied.error).toMatchObject({
        code: "permission_denied",
        message: expect.stringContaining("policy-default-deny"),
      });
      expect(process.exitCode).toBe(77);
      expect(runtime.provider.acquireCount).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

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

  it("coalesces concurrent cold target acquisition within one Agent session", async () => {
    const contexts = ["cold-turn-left", "cold-turn-right"].map((turnId) => ({
      agent_session_id: "cold-agent",
      turn_id: turnId,
      transport: "cli" as const,
      profile_partition_id: "cold-login",
    }));
    for (const context of contexts) {
      await runtime.client.requestOrThrow({
        id: `start-${context.turn_id}`,
        action: "session.start",
        context,
      });
    }
    let releaseAcquisition!: () => void;
    runtime.provider.acquireGate = new Promise<void>((resolve) => {
      releaseAcquisition = resolve;
    });

    const commands = contexts.map((context) =>
      runtime.client.requestOrThrow<BrowserTargetCommandResult>({
        id: `command-${context.turn_id}`,
        action: "target.command",
        context,
        provider: "managed",
        visibility: "hidden",
        profile_partition_id: "cold-login",
        isolated: false,
        ephemeral: true,
        command: { method: "title" },
      }),
    );
    await waitUntil(() => runtime.provider.acquireCount > 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseAcquisition();
    const results = await Promise.all(commands);

    expect(runtime.provider.acquireCount).toBe(1);
    expect(results[0]?.target_id).toBe(results[1]?.target_id);
  });

  it("isolates cancellation between waiters sharing one cold target acquisition", async () => {
    const contexts = ["cancel-acquire-first", "cancel-acquire-second"].map(
      (turnId) => ({
        agent_session_id: "cancel-acquire-agent",
        turn_id: turnId,
        transport: "mcp-http" as const,
        profile_partition_id: "cancel-acquire-login",
      }),
    );
    for (const context of contexts) {
      await runtime.broker.dispatch({
        id: `start-${context.turn_id}`,
        action: "session.start",
        context,
      });
    }
    let releaseAcquisition!: () => void;
    runtime.provider.acquireGate = new Promise<void>((resolve) => {
      releaseAcquisition = resolve;
    });
    const firstController = new AbortController();
    const request = (index: number) => ({
      id: `cancel-acquire-command-${String(index)}`,
      action: "target.command" as const,
      context: contexts[index]!,
      provider: "managed" as const,
      visibility: "hidden" as const,
      profile_partition_id: "cancel-acquire-login",
      isolated: false,
      ephemeral: true,
      command: { method: "title" as const },
    });

    const first = runtime.broker.dispatch(request(0), firstController.signal);
    const second = runtime.broker.dispatch(request(1));
    await waitUntil(() => runtime.provider.acquireCount === 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    firstController.abort(new Error("first acquisition waiter disconnected"));

    await expect(first).resolves.toMatchObject({
      ok: false,
      error: { code: "browser_command_canceled", retryable: true },
    });
    expect(runtime.provider.releaseAttemptCount).toBe(0);
    releaseAcquisition();
    const secondResult = await second;

    expect(secondResult).toMatchObject({
      ok: true,
      data: { provider: "managed", data: "Blank" },
    });
    expect(runtime.provider.acquireCount).toBe(1);
    expect(runtime.provider.releaseAttemptCount).toBe(0);
    expect(runtime.broker.status().sessions.target_leases).toHaveLength(1);
  });

  it("starts fresh acquisition without waiting for abandoned provider work", async () => {
    const contexts = ["abandoned-acquire-first", "abandoned-acquire-next"].map(
      (turnId) => ({
        agent_session_id: "abandoned-acquire-agent",
        turn_id: turnId,
        transport: "mcp-http" as const,
        profile_partition_id: "abandoned-acquire-login",
      }),
    );
    for (const context of contexts) {
      await runtime.broker.dispatch({
        id: `start-${context.turn_id}`,
        action: "session.start",
        context,
      });
    }
    let releaseAcquisition!: () => void;
    runtime.provider.acquireGate = new Promise<void>((resolve) => {
      releaseAcquisition = resolve;
    });
    const request = (index: number) => ({
      id: `abandoned-acquire-command-${String(index)}`,
      action: "target.command" as const,
      context: contexts[index]!,
      provider: "managed" as const,
      visibility: "hidden" as const,
      profile_partition_id: "abandoned-acquire-login",
      isolated: false,
      ephemeral: true,
      command: { method: "title" as const },
    });
    const controller = new AbortController();
    const abandoned = runtime.broker.dispatch(request(0), controller.signal);
    await waitUntil(() => runtime.provider.acquireCount === 1);
    controller.abort(new Error("sole acquisition waiter disconnected"));

    await expect(abandoned).resolves.toMatchObject({
      ok: false,
      error: { code: "browser_command_canceled", retryable: true },
    });
    const replacement = runtime.broker.dispatch(request(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runtime.provider.acquireCount).toBe(2);

    releaseAcquisition();
    await expect(replacement).resolves.toMatchObject({
      ok: true,
      data: { target_id: "target-2", data: "Blank" },
    });
    expect(runtime.provider.acquireCount).toBe(2);
    expect(runtime.provider.releaseAttemptCount).toBe(1);
    expect(runtime.provider.releaseCount).toBe(1);
    expect(runtime.broker.status().sessions.target_leases).toEqual([
      expect.objectContaining({ target_id: "target-2" }),
    ]);
  });

  it("preserves a shared target when a queued write is canceled before dispatch", async () => {
    const firstContext = {
      agent_session_id: "queued-cancel-agent",
      turn_id: "queued-cancel-first",
      transport: "mcp-http" as const,
      profile_partition_id: "queued-cancel-profile",
    };
    const secondContext = {
      ...firstContext,
      turn_id: "queued-cancel-second",
    };
    for (const context of [firstContext, secondContext]) {
      await runtime.client.requestOrThrow({
        id: `queued-cancel-start-${context.turn_id}`,
        action: "session.start",
        context,
      });
    }
    const acquired =
      await runtime.client.requestOrThrow<BrowserTargetCommandResult>({
        id: "queued-cancel-acquire",
        action: "target.command",
        context: firstContext,
        provider: "managed",
        visibility: "hidden",
        profile_partition_id: "queued-cancel-profile",
        isolated: false,
        ephemeral: true,
        command: { method: "title" },
      });
    const firstStarted = deferred();
    const firstGate = deferred();
    let secondProviderCalls = 0;
    const page = runtime.provider.pages[0]!;
    page.evaluate = async (expression: string) => {
      if (expression === "first-write") {
        firstStarted.resolve();
        await firstGate.promise;
      } else {
        secondProviderCalls++;
      }
      return null;
    };
    const first = runtime.broker.dispatch({
      id: "queued-cancel-first-write",
      action: "target.command",
      context: firstContext,
      target_id: acquired.target_id,
      provider: "managed",
      visibility: "hidden",
      profile_partition_id: "queued-cancel-profile",
      isolated: false,
      ephemeral: true,
      command: { method: "evaluate", expression: "first-write" },
    });
    await firstStarted.promise;
    const controller = new AbortController();
    const queued = runtime.broker.dispatch(
      {
        id: "queued-cancel-second-write",
        action: "target.command",
        context: secondContext,
        target_id: acquired.target_id,
        provider: "managed",
        visibility: "hidden",
        profile_partition_id: "queued-cancel-profile",
        isolated: false,
        ephemeral: true,
        command: { method: "evaluate", expression: "queued-write" },
      },
      controller.signal,
    );

    controller.abort(new Error("cancel queued write"));
    expect(runtime.broker.status().sessions.quarantined_target_ids).toEqual([]);
    firstGate.resolve();
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(queued).resolves.toMatchObject({
      ok: false,
      error: { code: "browser_command_canceled", retryable: true },
    });
    expect(secondProviderCalls).toBe(0);

    await expect(
      runtime.broker.dispatch({
        id: "queued-cancel-retry",
        action: "target.command",
        context: secondContext,
        target_id: acquired.target_id,
        provider: "managed",
        visibility: "hidden",
        profile_partition_id: "queued-cancel-profile",
        isolated: false,
        ephemeral: true,
        command: { method: "evaluate", expression: "retry-write" },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(runtime.provider.acquireCount).toBe(1);
    expect(page.closed).toBe(false);
  });

  it("preserves a shared target when a dispatched read is canceled", async () => {
    const firstContext = {
      agent_session_id: "read-cancel-agent",
      turn_id: "read-cancel-first",
      transport: "mcp-http" as const,
      profile_partition_id: "read-cancel-profile",
    };
    const secondContext = { ...firstContext, turn_id: "read-cancel-second" };
    for (const context of [firstContext, secondContext]) {
      await runtime.client.requestOrThrow({
        id: `read-cancel-start-${context.turn_id}`,
        action: "session.start",
        context,
      });
    }
    const acquired =
      await runtime.client.requestOrThrow<BrowserTargetCommandResult>({
        id: "read-cancel-acquire",
        action: "target.command",
        context: firstContext,
        provider: "managed",
        visibility: "hidden",
        profile_partition_id: "read-cancel-profile",
        isolated: false,
        ephemeral: true,
        command: { method: "url" },
      });
    const readStarted = deferred();
    const readGate = deferred();
    let titleCalls = 0;
    const page = runtime.provider.pages[0]!;
    page.title = async () => {
      titleCalls++;
      if (titleCalls === 1) {
        readStarted.resolve();
        await readGate.promise;
      }
      return "still-readable";
    };
    const controller = new AbortController();
    const canceledRead = runtime.broker.dispatch(
      {
        id: "read-cancel-command",
        action: "target.command",
        context: firstContext,
        target_id: acquired.target_id,
        provider: "managed",
        visibility: "hidden",
        profile_partition_id: "read-cancel-profile",
        isolated: false,
        ephemeral: true,
        command: { method: "title" },
      },
      controller.signal,
    );
    await readStarted.promise;
    controller.abort(new Error("cancel read"));
    const siblingRead = runtime.broker.dispatch({
      id: "read-cancel-sibling",
      action: "target.command",
      context: secondContext,
      target_id: acquired.target_id,
      provider: "managed",
      visibility: "hidden",
      profile_partition_id: "read-cancel-profile",
      isolated: false,
      ephemeral: true,
      command: { method: "title" },
    });

    expect(runtime.broker.status().sessions.quarantined_target_ids).toEqual([]);
    readGate.resolve();
    await expect(canceledRead).resolves.toMatchObject({
      ok: false,
      error: { code: "browser_command_canceled", retryable: true },
    });
    await expect(siblingRead).resolves.toMatchObject({
      ok: true,
      data: { target_id: acquired.target_id, data: "still-readable" },
    });
    expect(runtime.provider.acquireCount).toBe(1);
    expect(page.closed).toBe(false);
  });

  it("quarantines a consuming network read canceled after its evidence is drained", async () => {
    const context = {
      agent_session_id: "drain-cancel-agent",
      turn_id: "drain-cancel-turn",
      transport: "mcp-http" as const,
      profile_partition_id: "drain-cancel-profile",
    };
    await runtime.client.requestOrThrow({
      id: "drain-cancel-start",
      action: "session.start",
      context,
    });
    const acquired =
      await runtime.client.requestOrThrow<BrowserTargetCommandResult>({
        id: "drain-cancel-acquire",
        action: "target.command",
        context,
        provider: "managed",
        visibility: "hidden",
        profile_partition_id: "drain-cancel-profile",
        isolated: false,
        ephemeral: true,
        command: { method: "title" },
      });
    const drainStarted = deferred();
    const drainGate = deferred();
    const page = runtime.provider.pages[0]!;
    let retainedEvidence = [
      {
        url: "https://evidence.test/",
        method: "GET",
        status: 200,
        contentType: "text/plain",
        size: 1,
      },
    ];
    page.readNetworkCapture = async () => {
      const drained = retainedEvidence;
      retainedEvidence = [];
      drainStarted.resolve();
      await drainGate.promise;
      return drained;
    };
    const controller = new AbortController();
    const canceledDrain = runtime.broker.dispatch(
      {
        id: "drain-cancel-command",
        action: "target.command",
        context,
        target_id: acquired.target_id,
        provider: "managed",
        visibility: "hidden",
        profile_partition_id: "drain-cancel-profile",
        isolated: false,
        ephemeral: true,
        command: { method: "network_capture_read" },
      },
      controller.signal,
    );
    await drainStarted.promise;
    expect(retainedEvidence).toEqual([]);
    controller.abort(new Error("cancel after evidence drain"));
    const sibling = runtime.broker.dispatch({
      id: "drain-cancel-sibling",
      action: "target.command",
      context,
      target_id: acquired.target_id,
      provider: "managed",
      visibility: "hidden",
      profile_partition_id: "drain-cancel-profile",
      isolated: false,
      ephemeral: true,
      command: { method: "title" },
    });

    expect(runtime.broker.status().sessions.quarantined_target_ids).toEqual([
      acquired.target_id,
    ]);
    drainGate.resolve();
    await expect(canceledDrain).resolves.toMatchObject({
      ok: false,
      error: { code: "browser_command_canceled", retryable: false },
    });
    await expect(sibling).resolves.toMatchObject({
      ok: false,
      error: { code: "browser_target_invalid" },
    });
    expect(page.closed).toBe(true);
    expect(runtime.broker.status().sessions.target_leases).toEqual([]);

    await expect(
      runtime.broker.dispatch({
        id: "drain-cancel-fresh",
        action: "target.command",
        context,
        provider: "managed",
        visibility: "hidden",
        profile_partition_id: "drain-cancel-profile",
        isolated: false,
        ephemeral: true,
        command: { method: "title" },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(runtime.provider.acquireCount).toBe(2);
  });

  it("quarantines an in-flight write before a sibling can mutate its target", async () => {
    const firstContext = {
      agent_session_id: "write-cancel-agent",
      turn_id: "write-cancel-first",
      transport: "mcp-http" as const,
      profile_partition_id: "write-cancel-profile",
    };
    const secondContext = { ...firstContext, turn_id: "write-cancel-second" };
    for (const context of [firstContext, secondContext]) {
      await runtime.client.requestOrThrow({
        id: `write-cancel-start-${context.turn_id}`,
        action: "session.start",
        context,
      });
    }
    const acquired =
      await runtime.client.requestOrThrow<BrowserTargetCommandResult>({
        id: "write-cancel-acquire",
        action: "target.command",
        context: firstContext,
        provider: "managed",
        visibility: "hidden",
        profile_partition_id: "write-cancel-profile",
        isolated: false,
        ephemeral: true,
        command: { method: "title" },
      });
    const mutationStarted = deferred();
    const mutationGate = deferred();
    let siblingSideEffects = 0;
    const page = runtime.provider.pages[0]!;
    page.evaluate = async (expression: string) => {
      if (expression === "ambiguous-write") {
        mutationStarted.resolve();
        await mutationGate.promise;
        return "possibly-applied";
      }
      siblingSideEffects++;
      return "sibling-applied";
    };
    const controller = new AbortController();
    const canceledWrite = runtime.broker.dispatch(
      {
        id: "write-cancel-command",
        action: "target.command",
        context: firstContext,
        target_id: acquired.target_id,
        provider: "managed",
        visibility: "hidden",
        profile_partition_id: "write-cancel-profile",
        isolated: false,
        ephemeral: true,
        command: { method: "evaluate", expression: "ambiguous-write" },
      },
      controller.signal,
    );
    await mutationStarted.promise;
    controller.abort(new Error("cancel dispatched write"));
    const siblingWrite = runtime.broker.dispatch({
      id: "write-cancel-sibling",
      action: "target.command",
      context: secondContext,
      target_id: acquired.target_id,
      provider: "managed",
      visibility: "hidden",
      profile_partition_id: "write-cancel-profile",
      isolated: false,
      ephemeral: true,
      command: { method: "evaluate", expression: "sibling-write" },
    });

    expect(runtime.broker.status().sessions).toMatchObject({
      quarantined_target_ids: [acquired.target_id],
    });
    mutationGate.resolve();
    await expect(canceledWrite).resolves.toMatchObject({
      ok: false,
      error: { code: "browser_command_canceled", retryable: false },
    });
    await expect(siblingWrite).resolves.toMatchObject({
      ok: false,
      error: { code: "browser_target_invalid" },
    });
    expect(siblingSideEffects).toBe(0);
    expect(page.closed).toBe(true);
    expect(runtime.broker.status().sessions).toMatchObject({
      target_leases: [],
      quarantined_target_ids: [],
    });

    await expect(
      runtime.broker.dispatch({
        id: "write-cancel-fresh-target",
        action: "target.command",
        context: secondContext,
        provider: "managed",
        visibility: "hidden",
        profile_partition_id: "write-cancel-profile",
        isolated: false,
        ephemeral: true,
        command: { method: "title" },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(runtime.provider.acquireCount).toBe(2);
  });

  it("quarantines a typed provider-ambiguous write before the target queue advances", async () => {
    const context = {
      agent_session_id: "provider-ambiguity-agent",
      turn_id: "provider-ambiguity-turn",
      transport: "mcp-http" as const,
      profile_partition_id: "provider-ambiguity-profile",
    };
    await runtime.client.requestOrThrow({
      id: "provider-ambiguity-start",
      action: "session.start",
      context,
    });
    const acquired =
      await runtime.client.requestOrThrow<BrowserTargetCommandResult>({
        id: "provider-ambiguity-acquire",
        action: "target.command",
        context,
        provider: "managed",
        visibility: "hidden",
        profile_partition_id: "provider-ambiguity-profile",
        isolated: false,
        ephemeral: true,
        command: { method: "title" },
      });
    const mutationStarted = deferred();
    const mutationGate = deferred();
    let siblingSideEffects = 0;
    const page = runtime.provider.pages[0]!;
    page.evaluate = async (expression: string) => {
      if (expression === "transport-lost") {
        mutationStarted.resolve();
        await mutationGate.promise;
        throw Object.assign(new Error("CDP connection closed unexpectedly"), {
          code: "cdp_connection_lost",
          suggestion: "Reconnect before continuing.",
          retryable: true,
          outcome_ambiguous: true,
        });
      }
      siblingSideEffects += 1;
      return "sibling-applied";
    };
    const ambiguous = runtime.broker.dispatch({
      id: "provider-ambiguity-write",
      action: "target.command",
      context,
      target_id: acquired.target_id,
      provider: "managed",
      visibility: "hidden",
      profile_partition_id: "provider-ambiguity-profile",
      isolated: false,
      ephemeral: true,
      command: { method: "evaluate", expression: "transport-lost" },
    });
    await mutationStarted.promise;
    const sibling = runtime.broker.dispatch({
      id: "provider-ambiguity-sibling",
      action: "target.command",
      context,
      target_id: acquired.target_id,
      provider: "managed",
      visibility: "hidden",
      profile_partition_id: "provider-ambiguity-profile",
      isolated: false,
      ephemeral: true,
      command: { method: "evaluate", expression: "sibling-write" },
    });
    mutationGate.resolve();

    await expect(ambiguous).resolves.toMatchObject({
      ok: false,
      error: {
        code: "browser_command_outcome_ambiguous",
        retryable: false,
      },
    });
    await expect(sibling).resolves.toMatchObject({
      ok: false,
      error: { code: "browser_target_invalid" },
    });
    expect(siblingSideEffects).toBe(0);
    expect(page.closed).toBe(true);
    expect(runtime.broker.status().sessions).toMatchObject({
      target_leases: [],
      quarantined_target_ids: [],
    });
  });

  it("preserves a target when a read times out without killing its transport", async () => {
    const context = {
      agent_session_id: "provider-read-agent",
      turn_id: "provider-read-turn",
      transport: "mcp-http" as const,
      profile_partition_id: "provider-read-profile",
    };
    await runtime.client.requestOrThrow({
      id: "provider-read-start",
      action: "session.start",
      context,
    });
    const acquired =
      await runtime.client.requestOrThrow<BrowserTargetCommandResult>({
        id: "provider-read-acquire",
        action: "target.command",
        context,
        provider: "managed",
        visibility: "hidden",
        profile_partition_id: "provider-read-profile",
        isolated: false,
        ephemeral: true,
        command: { method: "url" },
      });
    const page = runtime.provider.pages[0]!;
    let titleCalls = 0;
    page.title = async () => {
      titleCalls += 1;
      if (titleCalls === 1) {
        throw Object.assign(new Error("CDP read timed out"), {
          code: "cdp_command_timeout",
          suggestion: "Retry the read if it is still needed.",
          retryable: true,
          outcome_ambiguous: true,
          target_unusable: false,
        });
      }
      return "recovered-read";
    };
    const request = (id: string) =>
      runtime.broker.dispatch({
        id,
        action: "target.command",
        context,
        target_id: acquired.target_id,
        provider: "managed",
        visibility: "hidden",
        profile_partition_id: "provider-read-profile",
        isolated: false,
        ephemeral: true,
        command: { method: "title" },
      });

    await expect(request("provider-read-failed")).resolves.toMatchObject({
      ok: false,
      error: { code: "cdp_command_timeout", retryable: true },
    });
    await expect(request("provider-read-retry")).resolves.toMatchObject({
      ok: true,
      data: { target_id: acquired.target_id, data: "recovered-read" },
    });
    expect(runtime.provider.acquireCount).toBe(1);
    expect(page.closed).toBe(false);
  });

  it("discards a dead CDP target after a read instead of retrying it forever", async () => {
    const context = {
      agent_session_id: "provider-dead-read-agent",
      turn_id: "provider-dead-read-turn",
      transport: "mcp-http" as const,
      profile_partition_id: "provider-dead-read-profile",
    };
    await runtime.client.requestOrThrow({
      id: "provider-dead-read-start",
      action: "session.start",
      context,
    });
    const acquired =
      await runtime.client.requestOrThrow<BrowserTargetCommandResult>({
        id: "provider-dead-read-acquire",
        action: "target.command",
        context,
        provider: "managed",
        visibility: "hidden",
        profile_partition_id: "provider-dead-read-profile",
        isolated: false,
        ephemeral: true,
        command: { method: "url" },
      });
    const deadPage = runtime.provider.pages[0]!;
    deadPage.title = async () => {
      throw Object.assign(new Error("CDP connection closed unexpectedly"), {
        code: "cdp_connection_lost",
        suggestion: "Reconnect before continuing.",
        retryable: true,
        outcome_ambiguous: true,
        target_unusable: true,
      });
    };

    await expect(
      runtime.broker.dispatch({
        id: "provider-dead-read-failed",
        action: "target.command",
        context,
        target_id: acquired.target_id,
        provider: "managed",
        visibility: "hidden",
        profile_partition_id: "provider-dead-read-profile",
        isolated: false,
        ephemeral: true,
        command: { method: "title" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "browser_target_unusable", retryable: true },
    });
    expect(deadPage.closed).toBe(true);
    expect(runtime.broker.status().sessions.target_leases).toEqual([]);

    await expect(
      runtime.broker.dispatch({
        id: "provider-dead-read-fresh",
        action: "target.command",
        context,
        provider: "managed",
        visibility: "hidden",
        profile_partition_id: "provider-dead-read-profile",
        isolated: false,
        ephemeral: true,
        command: { method: "title" },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(runtime.provider.acquireCount).toBe(2);
  });

  it("keeps one coordinate click contiguous before a sibling target command", async () => {
    const firstContext = {
      agent_session_id: "native-click-order-agent",
      turn_id: "native-click-order-first",
      transport: "mcp-http" as const,
      profile_partition_id: "native-click-order-profile",
    };
    const secondContext = {
      ...firstContext,
      turn_id: "native-click-order-second",
    };
    for (const context of [firstContext, secondContext]) {
      await runtime.client.requestOrThrow({
        id: `native-click-order-start-${context.turn_id}`,
        action: "session.start",
        context,
      });
    }
    const acquired =
      await runtime.client.requestOrThrow<BrowserTargetCommandResult>({
        id: "native-click-order-acquire",
        action: "target.command",
        context: firstContext,
        provider: "managed",
        visibility: "hidden",
        profile_partition_id: "native-click-order-profile",
        isolated: false,
        ephemeral: true,
        command: { method: "title" },
      });
    const clickStarted = deferred();
    const releaseClick = deferred();
    const events: string[] = [];
    const page = runtime.provider.pages[0]!;
    page.nativeClick = async () => {
      events.push("mousePressed");
      clickStarted.resolve();
      await releaseClick.promise;
      events.push("mouseReleased");
    };
    page.evaluate = async () => {
      events.push("sibling");
      return null;
    };
    const clicking = runtime.broker.dispatch({
      id: "native-click-order-click",
      action: "target.command",
      context: firstContext,
      target_id: acquired.target_id,
      provider: "managed",
      visibility: "hidden",
      profile_partition_id: "native-click-order-profile",
      isolated: false,
      ephemeral: true,
      command: { method: "native_click", x: 10, y: 20 },
    });
    await clickStarted.promise;
    const sibling = runtime.broker.dispatch({
      id: "native-click-order-sibling",
      action: "target.command",
      context: secondContext,
      target_id: acquired.target_id,
      provider: "managed",
      visibility: "hidden",
      profile_partition_id: "native-click-order-profile",
      isolated: false,
      ephemeral: true,
      command: { method: "evaluate", expression: "sibling" },
    });
    await Promise.resolve();
    expect(events).toEqual(["mousePressed"]);

    releaseClick.resolve();
    await expect(Promise.all([clicking, sibling])).resolves.toHaveLength(2);
    expect(events).toEqual(["mousePressed", "mouseReleased", "sibling"]);
  });

  it("isolates concurrent turns and rejects explicit cross-turn target access", async () => {
    const contexts = ["isolated-concurrent-a", "isolated-concurrent-b"].map(
      (turnId) => ({
        agent_session_id: "isolated-concurrent-agent",
        turn_id: turnId,
        transport: "mcp-http" as const,
        profile_partition_id: "isolated-concurrent-profile",
      }),
    );
    for (const context of contexts) {
      await runtime.client.requestOrThrow({
        id: `isolated-start-${context.turn_id}`,
        action: "session.start",
        context,
      });
    }
    const results = await Promise.all(
      contexts.map((context) =>
        runtime.client.requestOrThrow<BrowserTargetCommandResult>({
          id: `isolated-command-${context.turn_id}`,
          action: "target.command",
          context,
          provider: "managed",
          visibility: "hidden",
          profile_partition_id: "isolated-concurrent-profile",
          isolated: true,
          ephemeral: true,
          command: { method: "title" },
        }),
      ),
    );

    expect(runtime.provider.acquireCount).toBe(2);
    expect(results[0]?.target_id).not.toBe(results[1]?.target_id);
    await expect(
      runtime.client.requestOrThrow({
        id: "isolated-cross-turn-explicit",
        action: "target.command",
        context: contexts[1]!,
        target_id: results[0]!.target_id,
        provider: "managed",
        visibility: "hidden",
        profile_partition_id: "isolated-concurrent-profile",
        isolated: true,
        ephemeral: true,
        command: { method: "title" },
      }),
    ).rejects.toMatchObject({ code: "browser_target_owned" });

    await runtime.client.requestOrThrow({
      id: "isolated-end-first-turn",
      action: "turn.end",
      context: contexts[0]!,
    });
    expect(runtime.provider.releaseCount).toBe(1);
    expect(
      runtime.provider.pages.find(
        (page) => page.targetId === results[1]!.target_id,
      )?.closed,
    ).toBe(false);
    const reused =
      await runtime.client.requestOrThrow<BrowserTargetCommandResult>({
        id: "isolated-reuse-second-turn",
        action: "target.command",
        context: contexts[1]!,
        provider: "managed",
        visibility: "hidden",
        profile_partition_id: "isolated-concurrent-profile",
        isolated: true,
        ephemeral: true,
        command: { method: "title" },
      });
    expect(reused.target_id).toBe(results[1]!.target_id);
    expect(runtime.provider.acquireCount).toBe(2);
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

  it("coalesces overlapping idle reapers while a provider release is pending", async () => {
    await runCommand(["browser", "--session", "reaper-agent", "start"]);
    runtime.provider.releaseFailuresRemaining = 1;

    await runCommand(["browser", "session-end", "reaper-agent"]);
    let releaseProvider!: () => void;
    runtime.provider.releaseGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });

    const firstReaper = runtime.broker.reapIdleSessions();
    const secondReaper = runtime.broker.reapIdleSessions();
    await waitUntil(() => runtime.provider.releaseAttemptCount >= 2);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(runtime.provider.releaseAttemptCount).toBe(2);
    releaseProvider();
    await expect(Promise.all([firstReaper, secondReaper])).resolves.toEqual([
      [],
      [],
    ]);
    expect(runtime.provider.releaseCount).toBe(1);
  });

  it("does not reap a session reactivated after the idle scan", async () => {
    let now = 0;
    const ttlRuntime = new InMemoryBrowserRuntimeHarness({
      now: () => now,
      sessionTtlMs: 500,
    });
    const context = (agentSessionId: string) => ({
      agent_session_id: agentSessionId,
      turn_id: `${agentSessionId}-turn`,
      transport: "cli" as const,
      profile_partition_id: "default",
    });
    try {
      for (const agentSessionId of ["idle-a", "idle-b"]) {
        const invocation = context(agentSessionId);
        await expect(
          ttlRuntime.broker.dispatch({
            id: `${agentSessionId}-start`,
            action: "session.start",
            context: invocation,
          }),
        ).resolves.toMatchObject({ ok: true });
        await expect(
          ttlRuntime.broker.dispatch({
            id: `${agentSessionId}-target`,
            action: "target.command",
            context: invocation,
            provider: "managed",
            visibility: "hidden",
            profile_partition_id: "default",
            isolated: false,
            ephemeral: true,
            command: { method: "title" },
          }),
        ).resolves.toMatchObject({ ok: true });
      }
      now = 1_000;
      let releaseProvider!: () => void;
      ttlRuntime.provider.releaseGate = new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });

      const reaping = ttlRuntime.broker.reapIdleSessions();
      await waitUntil(() => ttlRuntime.provider.releaseAttemptCount === 1);
      await expect(
        ttlRuntime.broker.dispatch({
          id: "idle-b-reactivated",
          action: "target.command",
          context: context("idle-b"),
          target_id: ttlRuntime.provider.pages[1]!.targetId,
          provider: "managed",
          visibility: "hidden",
          profile_partition_id: "default",
          isolated: false,
          ephemeral: true,
          command: { method: "title" },
        }),
      ).resolves.toMatchObject({ ok: true });
      releaseProvider();

      await expect(reaping).resolves.toEqual([
        expect.objectContaining({ agent_session_id: "idle-a" }),
      ]);
      expect(
        ttlRuntime.broker
          .status()
          .sessions.sessions.map((session) => session.agent_session_id),
      ).toEqual(["idle-b"]);
    } finally {
      await ttlRuntime.cleanup();
    }
  });

  it("serializes session restart behind the only provider release", async () => {
    await runCommand(["browser", "--session", "restart-agent", "start"]);
    let releaseProvider!: () => void;
    runtime.provider.releaseGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });

    const ending = runtime.client.requestOrThrow({
      id: "restart-end",
      action: "session.end",
      agent_session_id: "restart-agent",
    });
    await waitUntil(() => runtime.provider.releaseAttemptCount === 1);
    const restartedContext = {
      agent_session_id: "restart-agent",
      turn_id: "restart-turn",
      transport: "cli" as const,
      profile_partition_id: "default",
    };
    const restarting = runtime.client.requestOrThrow({
      id: "restart-start",
      action: "session.start",
      context: restartedContext,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(runtime.provider.releaseAttemptCount).toBe(1);
    releaseProvider();
    await expect(Promise.all([ending, restarting])).resolves.toHaveLength(2);
    expect(runtime.provider.releaseAttemptCount).toBe(1);
    expect((await brokerStatus()).sessions.sessions).toEqual([
      expect.objectContaining({
        agent_session_id: "restart-agent",
        active_turn_ids: ["restart-turn"],
        target_ids: [],
      }),
    ]);
  });

  it("linearizes session end and restart behind an in-flight target acquisition", async () => {
    const firstContext = {
      agent_session_id: "acquisition-race-agent",
      turn_id: "acquisition-race-first",
      transport: "cli" as const,
      profile_partition_id: "default",
    };
    await expect(
      runtime.broker.dispatch({
        id: "acquisition-race-start-first",
        action: "session.start",
        context: firstContext,
      }),
    ).resolves.toMatchObject({ ok: true });
    let releaseAcquisition!: () => void;
    runtime.provider.acquireGate = new Promise<void>((resolve) => {
      releaseAcquisition = resolve;
    });

    const command = runtime.broker.dispatch({
      id: "acquisition-race-command",
      action: "target.command",
      context: firstContext,
      provider: "managed",
      visibility: "hidden",
      profile_partition_id: "default",
      isolated: false,
      ephemeral: true,
      command: { method: "title" },
    });
    await waitUntil(() => runtime.provider.acquireCount === 1);
    let endSettled = false;
    const ending = runtime.broker
      .dispatch({
        id: "acquisition-race-end",
        action: "session.end",
        agent_session_id: firstContext.agent_session_id,
      })
      .finally(() => {
        endSettled = true;
      });
    const secondContext = {
      ...firstContext,
      turn_id: "acquisition-race-second",
    };
    const restarting = runtime.broker.dispatch({
      id: "acquisition-race-start-second",
      action: "session.start",
      context: secondContext,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(endSettled).toBe(false);
    expect(runtime.provider.releaseAttemptCount).toBe(0);
    releaseAcquisition();

    await expect(command).resolves.toMatchObject({
      ok: false,
      error: { code: "browser_session_ending" },
    });
    await expect(ending).resolves.toMatchObject({
      ok: true,
      data: {
        released_targets: [expect.objectContaining({ provider: "managed" })],
      },
    });
    await expect(restarting).resolves.toMatchObject({ ok: true });
    expect(runtime.provider.acquireCount).toBe(1);
    expect(runtime.provider.releaseAttemptCount).toBe(1);
    expect(runtime.provider.releaseCount).toBe(1);
    expect(runtime.provider.pages[0]?.closed).toBe(true);
    expect(runtime.broker.status().sessions).toMatchObject({
      sessions: [
        {
          agent_session_id: firstContext.agent_session_id,
          active_turn_ids: [secondContext.turn_id],
          target_ids: [],
        },
      ],
      target_leases: [],
      pending_release_session_ids: [],
      pending_release_target_ids: [],
    });
  });

  it("never reuses an isolated target whose prior turn release is pending", async () => {
    runtime.provider.releaseFailuresRemaining = 1;
    const failedRelease = await runCommand([
      "browser",
      "--session",
      "isolated-retry-agent",
      "--turn",
      "isolated-retry-first",
      "--isolated",
      "start",
    ]);

    expect(failedRelease.error?.message).toContain(
      "Injected target release failure",
    );
    const replacement = await runCommand([
      "browser",
      "--session",
      "isolated-retry-agent",
      "--turn",
      "isolated-retry-second",
      "--isolated",
      "start",
    ]);

    expect(replacement.error).toBeNull();
    expect(runtime.provider.acquireCount).toBe(2);
    expect(runtime.provider.pages[0]?.closed).toBe(false);
    expect(runtime.provider.pages[1]?.closed).toBe(true);
    expect((await brokerStatus()).sessions.pending_release_target_ids).toEqual([
      runtime.provider.pages[0]?.targetId,
    ]);
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
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for the in-memory browser condition");
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
  program.option("--permission-profile <profile>", "permission profile");
  program.option("--yes", "approve this operation");
  program.option("--remember-approval", "persist this approval");
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
