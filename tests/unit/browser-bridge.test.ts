import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BrowserBridge } from "../../src/browser/bridge.js";
import { createBrowserInvocationContext } from "../../src/browser/invocation-context.js";
import {
  createBrowserInvocationScope,
  runBrowserInvocation,
} from "../../src/browser/invocation-scope.js";
import type {
  BrowserBrokerRequest,
  BrowserBrokerResponse,
  BrowserBrokerStatus,
  BrowserTargetCommandResult,
} from "../../src/browser/runtime-protocol.js";
import { BrowserRuntimeBrokerServer } from "../../src/browser/runtime-transport.js";

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

  it("finalizes an MCP turn once after all page work and retains its session target", async () => {
    const requests: BrowserBrokerRequest[] = [];
    await startRecordingBroker(requests);
    const scope = createBrowserInvocationScope({
      context: createBrowserInvocationContext({
        transport: "mcp-http",
        agentSessionId: "mcp-session",
        turnId: "mcp-turn",
      }),
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
    });

    expect(
      requests.filter((request) => request.action === "turn.end"),
    ).toHaveLength(1);
    expect(
      requests.filter((request) => request.action === "session.end"),
    ).toHaveLength(0);
    expect(
      requests
        .filter((request) => request.action === "target.command")
        .every(
          (request) =>
            request.context.agent_session_id === "mcp-session" &&
            request.context.turn_id === "mcp-turn",
        ),
    ).toBe(true);
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
});

async function startRecordingBroker(
  requests: BrowserBrokerRequest[],
): Promise<void> {
  runtimeRoot = mkdtempSync(join(tmpdir(), "unicli-bridge-unit-"));
  const runtimeId = randomUUID();
  server = new BrowserRuntimeBrokerServer({
    runtimeRoot,
    runtimeId,
    handler: async (request) => {
      requests.push(request);
      return responseFor(request, runtimeId);
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
  }
  const result: BrowserTargetCommandResult = {
    target_id: request.target_id ?? "target-owned",
    runtime_id: runtimeId,
    provider: request.provider,
    visibility: request.visibility,
    ...(data === undefined ? {} : { data }),
  };
  return { id: request.id, ok: true, data: result };
}

function status(runtimeId: string): BrowserBrokerStatus {
  return {
    ok: true,
    product: "unicli",
    protocol: "unicli-browser-runtime",
    version: 1,
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
