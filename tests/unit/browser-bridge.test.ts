import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BrowserBridge, BrowserBrokerPage } from "../../src/browser/bridge.js";
import { createBrowserInvocationContext } from "../../src/browser/invocation-context.js";
import {
  createBrowserInvocationScope,
  runBrowserInvocation,
} from "../../src/browser/invocation-scope.js";
import { BROWSER_BROKER_PROTOCOL_VERSION } from "../../src/browser/runtime-protocol.js";
import type {
  BrowserBrokerRequest,
  BrowserBrokerResponse,
  BrowserBrokerStatus,
  BrowserTargetCommandResult,
} from "../../src/browser/runtime-protocol.js";
import { BrowserRuntimeBrokerServer } from "../../src/browser/runtime-transport.js";
import { InMemoryBrowserRuntimeHarness } from "../helpers/in-memory-browser-runtime.js";

let runtimeRoot: string | null = null;
let server: BrowserRuntimeBrokerServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
  if (runtimeRoot) rmSync(runtimeRoot, { recursive: true, force: true });
  runtimeRoot = null;
});

describe("broker-backed browser bridge", () => {
  it("coalesces concurrent connects on one bridge without duplicating session start", async () => {
    const requests: BrowserBrokerRequest[] = [];
    await startRecordingBroker(requests);
    const bridge = new BrowserBridge();
    const options = {
      runtimeRoot: runtimeRoot!,
      sessionId: "coalesced-agent",
      turnId: "coalesced-turn",
      workspace: "coalesced-login",
    };

    const [left, right] = await Promise.all([
      bridge.connect(options),
      bridge.connect({ ...options }),
    ]);

    expect(left).toBe(right);
    expect(
      requests.filter((request) => request.action === "session.start"),
    ).toHaveLength(1);
    await bridge.close();
  });

  it("rejects conflicting options while a bridge connection is in flight", async () => {
    const requests: BrowserBrokerRequest[] = [];
    await startRecordingBroker(requests);
    const bridge = new BrowserBridge();
    const pending = bridge.connect({
      runtimeRoot: runtimeRoot!,
      sessionId: "left-agent",
      turnId: "shared-turn",
    });

    await expect(
      bridge.connect({
        runtimeRoot: runtimeRoot!,
        sessionId: "right-agent",
        turnId: "shared-turn",
      }),
    ).rejects.toThrow("conflicting invocation options");
    await pending;
    await bridge.close();
  });

  it("rejects a sequential reconnect that changes the connected Agent identity", async () => {
    const requests: BrowserBrokerRequest[] = [];
    await startRecordingBroker(requests);
    const bridge = new BrowserBridge();
    const first = await bridge.connect({
      runtimeRoot: runtimeRoot!,
      sessionId: "first-agent",
      turnId: "first-turn",
      profilePartitionId: "first-profile",
    });

    await expect(
      bridge.connect({
        runtimeRoot: runtimeRoot!,
        sessionId: "second-agent",
        turnId: "second-turn",
        profilePartitionId: "second-profile",
      }),
    ).rejects.toThrow("cannot change Agent identity");
    expect(
      (first as { scope?: { context: { agent_session_id: string } } }).scope,
    ).toMatchObject({ context: { agent_session_id: "first-agent" } });
    await bridge.close();
  });

  it("retries turn cleanup after a response-level transport failure", async () => {
    const requests: BrowserBrokerRequest[] = [];
    let turnEndAttempts = 0;
    await startRecordingBroker(requests, (request, runtimeId) => {
      if (request.action === "turn.end" && ++turnEndAttempts === 1) {
        return {
          id: request.id,
          ok: false,
          error: {
            code: "browser_broker_unavailable",
            message: "injected response loss",
            suggestion: "Retry the idempotent lifecycle request.",
            retryable: true,
          },
        };
      }
      return responseFor(request, runtimeId);
    });
    const bridge = new BrowserBridge();
    await bridge.connect({
      runtimeRoot: runtimeRoot!,
      sessionId: "cleanup-agent",
      turnId: "cleanup-turn",
    });

    await expect(bridge.close()).rejects.toMatchObject({
      code: "browser_broker_unavailable",
    });
    await expect(bridge.close()).resolves.toBeUndefined();
    expect(turnEndAttempts).toBe(2);
  });

  it("carries explicit CLI identity and reuses its owned target without a provider fallback", async () => {
    const requests: BrowserBrokerRequest[] = [];
    await startRecordingBroker(requests);
    const bridge = new BrowserBridge();
    const page = await bridge.connect({
      runtimeRoot: runtimeRoot!,
      sessionId: "cli-agent",
      turnId: "cli-turn",
      workspace: "shared-login",
      ephemeral: true,
    });

    await page.goto("https://example.com", { settleMs: 25 });
    expect(await page.title()).toBe("Example title");
    expect(await page.cookies()).toEqual({ sid: "cookie-value" });
    await bridge.close();

    expect(requests.map((request) => request.action)).toEqual([
      "broker.status",
      "session.start",
      "target.command",
      "target.command",
      "target.command",
      "turn.end",
    ]);
    const commands = requests.filter(
      (request) => request.action === "target.command",
    );
    expect(commands[0]).toMatchObject({
      context: {
        agent_session_id: "cli-agent",
        turn_id: "cli-turn",
        transport: "cli",
        profile_partition_id: "shared-login",
      },
      provider: "managed",
      visibility: "hidden",
      profile_partition_id: "shared-login",
      isolated: false,
      ephemeral: true,
      command: {
        method: "navigate",
        url: "https://example.com",
        settle_ms: 25,
      },
    });
    expect(commands[0]).not.toHaveProperty("target_id");
    expect(commands[1]).toMatchObject({ target_id: "target-owned" });
  });

  it("preserves exact ownership metadata when Chrome allocates a background target", async () => {
    const requests: BrowserBrokerRequest[] = [];
    await startRecordingBroker(requests, (request, runtimeId) => {
      if (request.action !== "target.command") {
        return responseFor(request, runtimeId);
      }
      return {
        id: request.id,
        ok: true,
        data: {
          target_id: "chrome-target-owned",
          runtime_id: runtimeId,
          provider: "chrome",
          visibility: "background",
          owned: true,
          tab_id: 42,
          window_id: 7,
          data: "https://example.com/",
        },
      };
    });
    const bridge = new BrowserBridge();
    const page = await bridge.connect({
      runtimeRoot: runtimeRoot!,
      sessionId: "chrome-owned-agent",
      turnId: "chrome-owned-turn",
      provider: "chrome",
      visibility: "background",
      profilePartitionId: "chrome-owned-profile",
    });

    await expect(page.url()).resolves.toBe("https://example.com/");
    expect(page.browserTargetIdentity()).toMatchObject({
      target_id: "chrome-target-owned",
      provider: "chrome",
      visibility: "background",
      owned: true,
      tab_id: 42,
      window_id: 7,
    });
    expect(
      requests.find((request) => request.action === "target.command"),
    ).not.toHaveProperty("target_id");
    await bridge.close();
  });

  it("sends a coordinate click as one broker mutation", async () => {
    const requests: BrowserBrokerRequest[] = [];
    await startRecordingBroker(requests);
    const bridge = new BrowserBridge();
    const page = await bridge.connect({
      runtimeRoot: runtimeRoot!,
      sessionId: "native-click-agent",
      turnId: "native-click-turn",
    });

    await page.nativeClick(23, 47);
    await bridge.close();

    expect(
      requests.filter((request) => request.action === "target.command"),
    ).toEqual([
      expect.objectContaining({
        command: { method: "native_click", x: 23, y: 47 },
      }),
    ]);
  });

  it.each([
    { code: "browser_target_discarded", retryable: true },
    { code: "browser_target_unusable", retryable: true },
    { code: "browser_command_outcome_ambiguous", retryable: false },
    { code: "browser_command_canceled", retryable: false },
  ])(
    "clears a cached target after $code without replaying the failed command",
    async ({ code, retryable }) => {
      const requests: BrowserBrokerRequest[] = [];
      let rejectedCachedTarget = false;
      await startRecordingBroker(requests, (request, runtimeId) => {
        if (
          request.action === "target.command" &&
          request.target_id &&
          !rejectedCachedTarget
        ) {
          rejectedCachedTarget = true;
          return {
            id: request.id,
            ok: false,
            error: {
              code,
              message: "cached target lease was invalidated",
              suggestion: "Issue the next command without the old target id.",
              retryable,
            },
          };
        }
        return responseFor(request, runtimeId);
      });
      const bridge = new BrowserBridge();
      const page = await bridge.connect({
        runtimeRoot: runtimeRoot!,
        sessionId: "stale-target-agent",
        turnId: "stale-target-turn",
      });

      await expect(page.title()).resolves.toBe("Example title");
      await expect(page.title()).rejects.toMatchObject({ code, retryable });
      expect(
        requests.filter((request) => request.action === "target.command"),
      ).toHaveLength(2);

      await expect(page.title()).resolves.toBe("Example title");
      const commands = requests.filter(
        (request) => request.action === "target.command",
      );
      expect(commands).toHaveLength(3);
      expect(commands[1]).toMatchObject({ target_id: "target-owned" });
      expect(commands[2]).not.toHaveProperty("target_id");
      await bridge.close();
    },
  );

  it("finalizes an MCP turn once after all page work and retains its session target", async () => {
    const requests: BrowserBrokerRequest[] = [];
    await startRecordingBroker(requests, (request, runtimeId) => {
      if (request.action === "session.start") {
        return {
          id: request.id,
          ok: true,
          data: {
            agent_session_id: request.context.agent_session_id,
            turn_id: request.context.turn_id,
            session_ttl_ms: 30,
          },
        };
      }
      return responseFor(request, runtimeId);
    });
    const context = createBrowserInvocationContext({
      transport: "mcp-http",
      agentSessionId: "mcp-session",
      turnId: "mcp-turn",
    });
    const scope = createBrowserInvocationScope({
      context,
      profilePartitionId: "login-partition",
    });

    await runBrowserInvocation(scope, async () => {
      const first = new BrowserBridge();
      const second = new BrowserBridge();
      const [left, right] = await Promise.all([
        first.connect({ runtimeRoot: runtimeRoot! }),
        second.connect({ runtimeRoot: runtimeRoot! }),
      ]);
      await Promise.all([left.url(), right.title()]);
      await expect
        .poll(
          () =>
            requests.filter((request) => request.action === "turn.touch")
              .length,
          { timeout: 500, interval: 5 },
        )
        .toBeGreaterThanOrEqual(2);
    });

    const touchCount = requests.filter(
      (request) => request.action === "turn.touch",
    ).length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(
      requests.filter((request) => request.action === "turn.end"),
    ).toHaveLength(1);
    expect(
      requests.filter((request) => request.action === "turn.touch"),
    ).toHaveLength(touchCount);
    expect(
      requests.filter((request) => request.action === "session.end"),
    ).toHaveLength(0);
    expect(
      requests
        .filter((request) => request.action === "target.command")
        .every(
          (request) =>
            request.context.agent_session_id === context.agent_session_id &&
            request.context.turn_id === "mcp-turn",
        ),
    ).toBe(true);
    expect(context.agent_session_id).toMatch(/^mcp:[a-f0-9]{64}$/);
  });

  it("cancels a browser wait immediately and finalizes its turn", async () => {
    const requests: BrowserBrokerRequest[] = [];
    await startRecordingBroker(requests);
    const controller = new AbortController();
    const scope = createBrowserInvocationScope({
      context: createBrowserInvocationContext({
        transport: "mcp-http",
        agentSessionId: "cancelled-wait-session",
        turnId: "cancelled-wait-turn",
      }),
      signal: controller.signal,
    });
    const startedAt = Date.now();

    await expect(
      runBrowserInvocation(scope, async () => {
        const page = await new BrowserBridge().connect({
          runtimeRoot: runtimeRoot!,
        });
        const waiting = page.wait(60);
        controller.abort(new Error("cancelled browser wait"));
        await waiting;
      }),
    ).rejects.toThrow("cancelled browser wait");

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(
      requests.filter((request) => request.action === "turn.end"),
    ).toHaveLength(1);
  });

  it("keeps an active Agent turn and target leased during a local wait longer than the broker TTL", async () => {
    let now = 0;
    const runtime = new InMemoryBrowserRuntimeHarness({
      now: () => now,
      sessionTtlMs: 90,
    });
    const bridge = new BrowserBridge();
    await runtime.start();
    try {
      const page = await bridge.connect({
        runtimeRoot: runtime.runtimeRoot,
        sessionId: "long-wait-agent",
        turnId: "long-wait-turn",
      });
      await expect(page.title()).resolves.toBe("Blank");
      const targetId =
        runtime.broker.status().sessions.target_leases[0]!.target_id;
      const waiting = page.wait(0.2);

      await new Promise((resolve) => setTimeout(resolve, 40));
      now = 1_000;
      await expect
        .poll(
          () => runtime.broker.status().sessions.sessions[0]?.last_activity_ms,
          { timeout: 1_000, interval: 10 },
        )
        .toBe(1_000);
      now = 1_050;

      await expect(runtime.broker.reapIdleSessions()).resolves.toEqual([]);
      expect(runtime.broker.status().sessions.target_leases).toEqual([
        expect.objectContaining({ target_id: targetId }),
      ]);
      await waiting;
      await expect(page.title()).resolves.toBe("Blank");
      expect(runtime.broker.status().sessions.target_leases[0]?.target_id).toBe(
        targetId,
      );
    } finally {
      await bridge.close().catch(() => undefined);
      await runtime.cleanup();
    }
  });

  it("accepts a value-equivalent explicit context inside its trusted invocation scope", async () => {
    const requests: BrowserBrokerRequest[] = [];
    await startRecordingBroker(requests);
    const context = createBrowserInvocationContext({
      transport: "plugin",
      agentSessionId: "plugin-session",
      turnId: "plugin-turn",
      profilePartitionId: "plugin-login",
    });
    const scope = createBrowserInvocationScope({ context });

    await runBrowserInvocation(scope, async () => {
      const page = await new BrowserBridge().connect({
        runtimeRoot: runtimeRoot!,
        context: { ...context },
      });
      expect(await page.title()).toBe("Example title");
    });

    expect(
      requests.find((request) => request.action === "target.command"),
    ).toMatchObject({ context });
  });

  it("keeps Chrome background explicit and ends only the owning session on closeWindow", async () => {
    const requests: BrowserBrokerRequest[] = [];
    await startRecordingBroker(requests);
    const bridge = new BrowserBridge();
    const page = await bridge.connect({
      runtimeRoot: runtimeRoot!,
      sessionId: "chrome-agent",
      turnId: "chrome-turn",
      provider: "chrome",
      visibility: "background",
    });

    await page.click("button.submit");
    await page.closeWindow();
    await bridge.close();

    const command = requests.find(
      (request) => request.action === "target.command",
    );
    expect(command).toMatchObject({
      provider: "chrome",
      visibility: "background",
      command: { method: "click", selector: "button.submit" },
    });
    expect(requests.at(-1)).toMatchObject({
      action: "session.end",
      agent_session_id: "chrome-agent",
    });
    expect(
      requests.filter((request) => request.action === "turn.end"),
    ).toHaveLength(0);
  });

  it("searches Chrome tabs and history without allocating or caching a target", async () => {
    const requests: BrowserBrokerRequest[] = [];
    await startRecordingBroker(requests);
    const bridge = new BrowserBridge();
    const page = (await bridge.connect({
      runtimeRoot: runtimeRoot!,
      sessionId: "chrome-search-agent",
      turnId: "chrome-search-turn",
      provider: "chrome",
      visibility: "background",
    })) as BrowserBrokerPage;

    await expect(
      page.searchChromeContent({
        query: "runtime broker",
        include_history: true,
        max_results: 3,
      }),
    ).resolves.toMatchObject({
      query: "runtime broker",
      result_count: 1,
      ui_state_unchanged: true,
    });
    await bridge.close();

    expect(
      requests.filter((request) => request.action === "chrome.content.search"),
    ).toEqual([
      expect.objectContaining({
        search: {
          query: "runtime broker",
          include_history: true,
          max_results: 3,
        },
      }),
    ]);
    expect(
      requests.filter((request) => request.action === "target.command"),
    ).toHaveLength(0);
  });

  it("projects foreground agent presence and cursor movement as target-scoped commands", async () => {
    const requests: BrowserBrokerRequest[] = [];
    await startRecordingBroker(requests);
    const bridge = new BrowserBridge();
    const page = (await bridge.connect({
      runtimeRoot: runtimeRoot!,
      sessionId: "chrome-presence-agent",
      turnId: "chrome-presence-turn",
      provider: "chrome",
      visibility: "foreground",
    })) as BrowserBrokerPage;

    await expect(page.setAgentPresence(true, "Uni-CLI")).resolves.toMatchObject(
      {
        status: "visible",
        cursor_visible: false,
      },
    );
    await expect(page.moveAgentCursor(120, 80)).resolves.toMatchObject({
      status: "visible",
      cursor_visible: true,
      x: 120,
      y: 80,
    });
    await expect(page.setAgentPresence(false)).resolves.toMatchObject({
      status: "hidden",
      cursor_visible: false,
    });
    await bridge.close();

    expect(
      requests
        .filter((request) => request.action === "target.command")
        .map((request) => request.command),
    ).toEqual([
      { method: "agent_presence", visible: true, label: "Uni-CLI" },
      { method: "agent_cursor", x: 120, y: 80, visible: true },
      { method: "agent_presence", visible: false },
    ]);
  });

  it("preserves screenshot files and validated network evidence across broker IPC", async () => {
    const requests: BrowserBrokerRequest[] = [];
    await startRecordingBroker(requests);
    const outputPath = join(runtimeRoot!, "capture.png");
    const bridge = new BrowserBridge();
    const page = await bridge.connect({
      runtimeRoot: runtimeRoot!,
      sessionId: "evidence-agent",
      turnId: "evidence-turn",
      ephemeral: true,
    });
    const capturePage = page as typeof page & {
      startNetworkCapture(pattern?: string): Promise<boolean>;
      readNetworkCapture(): Promise<unknown[]>;
    };

    expect(await capturePage.startNetworkCapture("/api/")).toBe(true);
    expect(await page.networkRequests()).toEqual([
      {
        url: "https://example.com/api/data",
        method: "POST",
        status: 201,
        type: "application/json",
        size: 18,
        timestamp: 123,
        remoteIPAddress: "127.0.0.1",
        remotePort: 443,
      },
    ]);
    const bytes = await page.screenshot({
      format: "png",
      clip: { x: 1, y: 2, width: 3, height: 4 },
      path: outputPath,
    });

    expect(bytes.toString("utf8")).toBe("image-bytes");
    expect(readFileSync(outputPath, "utf8")).toBe("image-bytes");
    expect(
      requests.find(
        (request) =>
          request.action === "target.command" &&
          request.command.method === "screenshot",
      ),
    ).toMatchObject({
      command: {
        method: "screenshot",
        format: "png",
        clip: { x: 1, y: 2, width: 3, height: 4 },
      },
    });
  });

  it("preserves an existing screenshot when cancellation wins before artifact commit", async () => {
    runtimeRoot = mkdtempSync(join(tmpdir(), "unicli-bridge-screenshot-"));
    const outputPath = join(runtimeRoot, "capture.png");
    writeFileSync(outputPath, "previous-capture");
    const controller = new AbortController();
    const cancellation = new Error("cancel screenshot artifact");
    // REASON: this client is the external broker-response boundary; screenshot decoding, cancellation, and filesystem publication remain real.
    const client = {
      async requestOrThrow(): Promise<BrowserTargetCommandResult> {
        queueMicrotask(() => controller.abort(cancellation));
        return {
          target_id: "target-owned",
          runtime_id: "runtime-owned",
          provider: "managed",
          visibility: "hidden",
          owned: true,
          data: Buffer.from("replacement-capture").toString("base64"),
        };
      },
    };
    const scope = createBrowserInvocationScope({
      context: createBrowserInvocationContext({
        transport: "cli",
        agentSessionId: "screenshot-agent",
        turnId: "screenshot-turn",
      }),
      signal: controller.signal,
    });
    const page = new BrowserBrokerPage(client as never, scope, 0);

    await expect(page.screenshot({ path: outputPath })).rejects.toBe(
      cancellation,
    );
    expect(readFileSync(outputPath, "utf8")).toBe("previous-capture");
    expect(readdirSync(runtimeRoot)).toEqual(["capture.png"]);
  });
});

async function startRecordingBroker(
  requests: BrowserBrokerRequest[],
  responder: (
    request: BrowserBrokerRequest,
    runtimeId: string,
  ) => BrowserBrokerResponse = responseFor,
): Promise<void> {
  runtimeRoot = mkdtempSync(join(tmpdir(), "unicli-bridge-unit-"));
  const runtimeId = randomUUID();
  server = new BrowserRuntimeBrokerServer({
    runtimeRoot,
    runtimeId,
    handler: async (request) => {
      requests.push(request);
      return responder(request, runtimeId);
    },
  });
  await server.start();
}

function responseFor(
  request: BrowserBrokerRequest,
  runtimeId: string,
): BrowserBrokerResponse {
  if (request.action === "broker.status") {
    return { id: request.id, ok: true, data: status(runtimeId) };
  }
  if (request.action === "chrome.content.search") {
    return {
      id: request.id,
      ok: true,
      data: {
        query: request.search.query.trim(),
        result_count: 1,
        eligible_open_tabs: 1,
        scanned_open_tabs: 1,
        matched_open_tabs: 1,
        failed_open_tabs: 0,
        scanned_history_items: 1,
        matched_history_items: 1,
        ui_state_unchanged: true,
        truncated: false,
        limits: {
          max_results: request.search.max_results ?? 20,
          max_tabs: request.search.max_tabs ?? 50,
          max_chars_per_tab: request.search.max_chars_per_tab ?? 120_000,
          tab_concurrency: 4,
          max_frames_per_tab: 32,
        },
        results: [
          {
            sources: ["open_tab", "history"],
            url: "https://example.com/runtime",
            title: "Runtime broker",
            score: 9,
            match_fields: ["title", "content"],
            snippets: ["Shared runtime broker"],
            tab_id: 42,
            window_id: 7,
          },
        ],
        failures: [],
      },
    };
  }
  if (request.action !== "target.command") {
    return { id: request.id, ok: true, data: { accepted: true } };
  }
  let data: unknown;
  switch (request.command.method) {
    case "title":
      data = "Example title";
      break;
    case "url":
      data = "https://example.com/";
      break;
    case "cookies":
      data = { sid: "cookie-value" };
      break;
    case "network_capture_start":
      data = true;
      break;
    case "network_capture_read":
      data = [
        {
          url: "https://example.com/api/data",
          method: "POST",
          status: 201,
          contentType: "application/json",
          size: 18,
          timestamp: 123,
          remoteIPAddress: "127.0.0.1",
          remotePort: 443,
        },
      ];
      break;
    case "screenshot":
      data = Buffer.from("image-bytes").toString("base64");
      break;
    case "agent_presence":
      data = {
        status: request.command.visible ? "visible" : "hidden",
        cursor_visible: false,
        viewport_width: 1_440,
        viewport_height: 900,
      };
      break;
    case "agent_cursor":
      data = {
        status: request.command.visible === false ? "hidden" : "visible",
        cursor_visible: request.command.visible !== false,
        viewport_width: 1_440,
        viewport_height: 900,
        x: request.command.x,
        y: request.command.y,
      };
      break;
  }
  const result: BrowserTargetCommandResult = {
    target_id: request.target_id ?? "target-owned",
    runtime_id: runtimeId,
    provider: request.provider,
    visibility: request.visibility,
    owned: request.provider !== "chrome",
    ...(data === undefined ? {} : { data }),
  };
  return { id: request.id, ok: true, data: result };
}

function status(runtimeId: string): BrowserBrokerStatus {
  return {
    ok: true,
    product: "unicli",
    protocol: "unicli-browser-runtime",
    version: BROWSER_BROKER_PROTOCOL_VERSION,
    runtime_id: runtimeId,
    broker_pid: process.pid,
    uptime_ms: 1,
    session_ttl_ms: 300_000,
    sessions: {
      sessions: [],
      tombstoned_session_ids: [],
      target_leases: [],
    },
    providers: {
      managed: [],
      chrome: {
        connected: false,
        protocol_version: 1,
        queued_commands: 0,
        in_flight_commands: 0,
        target_count: 0,
        stale_target_count: 0,
      },
    },
  };
}
