import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createBrowserInvocationContext } from "../../../src/browser/invocation-context.js";
import {
  createBrowserInvocationScope,
  runBrowserInvocation,
} from "../../../src/browser/invocation-scope.js";
import {
  CHROME_NATIVE_PROTOCOL_VERSION,
  chromeTargetId,
} from "../../../src/browser/chrome-native-protocol.js";
import {
  BROWSER_BROKER_PROTOCOL_VERSION,
  type BrowserBrokerRequest,
  type BrowserBrokerResponse,
  type BrowserBrokerStatus,
} from "../../../src/browser/runtime-protocol.js";
import { BrowserRuntimeBrokerServer } from "../../../src/browser/runtime-transport.js";
import { buildHandler } from "../../../src/mcp/handler.js";
import type { JsonRpcHandler } from "../../../src/mcp/jsonrpc.js";
import { selectTools } from "../../../src/mcp/tools.js";

let runtimeRoot: string | null = null;
let server: BrowserRuntimeBrokerServer | null = null;
const previousRuntimeRoot = process.env.UNICLI_BROWSER_RUNTIME_DIR;

afterEach(async () => {
  await server?.stop();
  server = null;
  if (runtimeRoot) rmSync(runtimeRoot, { recursive: true, force: true });
  runtimeRoot = null;
  if (previousRuntimeRoot === undefined) {
    delete process.env.UNICLI_BROWSER_RUNTIME_DIR;
  } else {
    process.env.UNICLI_BROWSER_RUNTIME_DIR = previousRuntimeRoot;
  }
});

describe("computer-use direct browser tools", () => {
  it("returns a capability remedy before broker acquisition under the default managed policy", async () => {
    const handler = buildHandler(selectTools("computer-use"));

    const response = await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "computer-use.browser_tabs", arguments: {} },
    });

    expect(response?.result).toMatchObject({
      isError: true,
      structuredContent: {
        data: {
          ok: false,
          operation: "browser_tabs",
          error: {
            code: "browser_provider_capability_unavailable",
            retryable: false,
            exit_code: 69,
            suggestion: expect.stringContaining("--browser-provider chrome"),
          },
        },
      },
    });
  });

  it("validates bounded search input before provider or broker work", async () => {
    const handler = buildHandler(selectTools("computer-use"), [], {
      browserPolicy: { provider: "chrome", visibility: "background" },
    });

    const response = await handler({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "computer-use.browser_search",
        arguments: { query: " ", max_results: 101 },
      },
    });

    expect(response?.result).toMatchObject({
      isError: true,
      structuredContent: {
        data: {
          error: { code: "invalid_input", exit_code: 2 },
        },
      },
    });
  });

  it("keeps browser state strictly read-only and rejects implicit launch input", async () => {
    const handler = buildHandler(selectTools("computer-use"));

    const response = await handler({
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: {
        name: "computer-use.browser_state",
        arguments: { allow_launch: true },
      },
    });

    expect(response?.result).toMatchObject({
      isError: true,
      structuredContent: {
        data: {
          error: {
            code: "invalid_input",
            message: expect.stringContaining("Unrecognized key"),
          },
        },
      },
    });
  });

  it("routes provider-wide MCP search without claiming or allocating a target", async () => {
    const requests: BrowserBrokerRequest[] = [];
    await startRecordingBroker(requests);
    const handler = buildHandler(selectTools("computer-use"), [], {
      browserPolicy: {
        provider: "chrome",
        visibility: "background",
        profilePartitionId: "mcp-search-profile",
      },
    });

    const response = await handler(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "computer-use.browser_search",
          arguments: {
            query: "runtime broker",
            include_history: true,
            max_results: 3,
            max_tabs: 8,
            max_chars_per_tab: 4_096,
          },
        },
      },
      { transport: "mcp-stdio", mcpSessionId: "mcp-search-session" },
    );

    expect(response?.result).toMatchObject({
      structuredContent: {
        data: {
          ok: true,
          operation: "browser_search",
          data: {
            query: "runtime broker",
            result_count: 1,
            ui_state_unchanged: true,
          },
        },
      },
      _meta: {
        evidence: {
          evidence_type: "computer-use-browser",
          provider: "chrome",
          visibility: "background",
        },
      },
    });
    expect(
      requests.filter((request) => request.action === "chrome.content.search"),
    ).toEqual([
      expect.objectContaining({
        search: {
          query: "runtime broker",
          include_history: true,
          max_results: 3,
          max_tabs: 8,
          max_chars_per_tab: 4_096,
        },
      }),
    ]);
    expect(
      requests.filter(
        (request) =>
          request.action === "chrome.target.claim" ||
          request.action === "target.command",
      ),
    ).toHaveLength(0);
  });

  it("prepares an inactive owned Chrome tab without claiming a user tab", async () => {
    const requests: BrowserBrokerRequest[] = [];
    await startRecordingBroker(requests);
    const handler = buildHandler(selectTools("computer-use"), [], {
      browserPolicy: {
        provider: "chrome",
        visibility: "background",
        profilePartitionId: "mcp-owned-chrome-profile",
      },
    });

    const prepared = await callBrowserTask(
      handler,
      "computer-use.browser_prepare",
      {},
      4,
      "mcp-owned-chrome-session",
    );

    expect(prepared).toMatchObject({
      structuredContent: {
        data: {
          ok: true,
          data: {
            target_id: chromeTargetId(BROWSER_SESSION_ID, 42),
            provider: "chrome",
            visibility: "background",
            owned: true,
            tab_id: 42,
            window_id: 7,
          },
        },
      },
    });
    expect(
      requests.filter(
        (request) =>
          request.action === "chrome.target.claim" ||
          request.action === "target.command",
      ),
    ).toEqual([
      expect.objectContaining({
        action: "target.command",
        provider: "chrome",
        visibility: "background",
        profile_partition_id: "mcp-owned-chrome-profile",
        command: { method: "url" },
      }),
    ]);
    expect(
      requests.find((request) => request.action === "target.command"),
    ).not.toHaveProperty("target_id");
  });

  it("keeps authoritative mutation success when cancellation arrives after settlement", async () => {
    const requests: BrowserBrokerRequest[] = [];
    const cancellation = new Error("client canceled after commit");
    let providerSettled = false;
    const signal = lateCancellationSignal(() => providerSettled, cancellation);
    await startRecordingBroker(requests, (request, runtimeId) => {
      if (request.action !== "target.command") return undefined;
      const response = responseFor(request, runtimeId, requests);
      providerSettled = true;
      return response;
    });
    const tool = selectTools("computer-use").find(
      (candidate) => candidate.name === "computer-use.browser_prepare",
    );
    if (!tool?.handler) throw new Error("browser_prepare tool is missing");
    const context = createBrowserInvocationContext({
      transport: "mcp-stdio",
      agentSessionId: "late-cancel-success",
      turnId: "prepare",
    });
    const scope = createBrowserInvocationScope({
      context,
      provider: "managed",
      visibility: "hidden",
      ephemeral: true,
      signal,
    });

    const result = await runBrowserInvocation(scope, () =>
      tool.handler!({}, { signal }),
    );

    expect(result).toMatchObject({
      structuredContent: {
        data: { ok: true, data: { target_id: MANAGED_TARGET_ID } },
      },
    });
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(cancellation);
  });

  it("ends the Agent browser session when its MCP transport closes", async () => {
    const requests: BrowserBrokerRequest[] = [];
    await startRecordingBroker(requests);
    const handler = buildHandler(selectTools("computer-use"), [], {
      browserPolicy: {
        provider: "managed",
        visibility: "hidden",
        profilePartitionId: "mcp-close-profile",
      },
    });
    const sessionId = "mcp-close-session";

    await callBrowserTask(
      handler,
      "computer-use.browser_prepare",
      {},
      12,
      sessionId,
    );
    const browserSessionId = requests.find(
      (request) => request.action === "session.start",
    )?.context.agent_session_id;
    expect(browserSessionId).toMatch(/^mcp:[a-f0-9]{64}$/);
    await handler.closeSession?.(sessionId, "stdio EOF");

    expect(requests.at(-1)).toMatchObject({
      action: "session.end",
      agent_session_id: browserSessionId,
    });
  });

  it.each(["closeSession", "closeAll"] as const)(
    "retains transport cleanup ownership until session.end succeeds through %s",
    async (cleanupMode) => {
      const requests: BrowserBrokerRequest[] = [];
      let cleanupAttempts = 0;
      await startRecordingBroker(requests, (request) => {
        if (request.action !== "session.end") return undefined;
        cleanupAttempts += 1;
        if (cleanupAttempts > 1) return undefined;
        return {
          id: request.id,
          ok: false,
          error: {
            code: "browser_cleanup_transient",
            message: "provider cleanup acknowledgement was unavailable",
            suggestion: "Retry transport cleanup.",
            retryable: true,
          },
        };
      });
      const handler = buildHandler(selectTools("computer-use"), [], {
        browserPolicy: {
          provider: "managed",
          visibility: "hidden",
          profilePartitionId: "mcp-retry-close-profile",
        },
      });
      const sessionId = "mcp-retry-close-session";
      if (!handler.closeSession || !handler.closeAll) {
        throw new Error("MCP cleanup hooks are missing");
      }
      const closeTransport = (reason: string) =>
        cleanupMode === "closeSession"
          ? handler.closeSession!(sessionId, reason)
          : handler.closeAll!(reason);

      await callBrowserTask(
        handler,
        "computer-use.browser_prepare",
        {},
        16,
        sessionId,
      );
      await expect(closeTransport("first EOF")).rejects.toMatchObject({
        code: "browser_cleanup_transient",
      });
      expect(cleanupAttempts).toBe(1);

      await expect(closeTransport("retry EOF")).resolves.toBeUndefined();
      expect(cleanupAttempts).toBe(2);
      expect(
        requests.filter((request) => request.action === "session.end"),
      ).toHaveLength(2);
    },
  );

  it("keeps authoritative mutation ambiguity when cancellation arrives with it", async () => {
    const requests: BrowserBrokerRequest[] = [];
    const cancellation = new Error("client canceled after ambiguous commit");
    let providerSettled = false;
    const signal = lateCancellationSignal(() => providerSettled, cancellation);
    await startRecordingBroker(requests, (request) => {
      if (request.action !== "target.command") return undefined;
      providerSettled = true;
      return {
        id: request.id,
        ok: false,
        error: {
          code: "browser_command_outcome_ambiguous",
          message: "broker lost acknowledgement after dispatch",
          suggestion: "Inspect target state before retrying.",
          retryable: false,
          outcome_ambiguous: true,
        },
      };
    });
    const tool = selectTools("computer-use").find(
      (candidate) => candidate.name === "computer-use.browser_prepare",
    );
    if (!tool?.handler) throw new Error("browser_prepare tool is missing");
    const context = createBrowserInvocationContext({
      transport: "mcp-stdio",
      agentSessionId: "late-cancel-ambiguous",
      turnId: "prepare",
    });
    const scope = createBrowserInvocationScope({
      context,
      provider: "managed",
      visibility: "hidden",
      ephemeral: true,
      signal,
    });

    const result = await runBrowserInvocation(scope, () =>
      tool.handler!({}, { signal }),
    );

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        data: {
          ok: false,
          error: {
            code: "browser_command_outcome_ambiguous",
            outcome_ambiguous: true,
          },
        },
      },
    });
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(cancellation);
  });

  it("claims the explicit tab before foreground presence and preserves the tab identity", async () => {
    const requests: BrowserBrokerRequest[] = [];
    await startRecordingBroker(requests);
    const tool = selectTools("computer-use").find(
      (candidate) => candidate.name === "computer-use.browser_presence",
    );
    if (!tool?.handler) throw new Error("browser_presence tool is missing");
    const context = createBrowserInvocationContext({
      transport: "mcp-stdio",
      agentSessionId: "mcp-presence-session",
      turnId: "mcp-presence-turn",
      profilePartitionId: "mcp-presence-profile",
    });
    const scope = createBrowserInvocationScope({
      context,
      provider: "chrome",
      visibility: "foreground",
      profilePartitionId: "mcp-presence-profile",
    });

    const result = await runBrowserInvocation(scope, () =>
      tool.handler!({
        tab_id: 42,
        visible: true,
        label: "Uni-CLI working",
      }),
    );

    expect(result).toMatchObject({
      structuredContent: {
        data: {
          ok: true,
          data: { status: "visible", cursor_visible: false },
        },
      },
    });
    expect(
      requests.filter(
        (request) =>
          request.action === "chrome.target.claim" ||
          request.action === "target.command",
      ),
    ).toEqual([
      expect.objectContaining({
        action: "chrome.target.claim",
        tab_id: 42,
        visibility: "foreground",
      }),
      expect.objectContaining({
        action: "target.command",
        target_id: chromeTargetId(BROWSER_SESSION_ID, 42),
        command: {
          method: "agent_presence",
          visible: true,
          label: "Uni-CLI working",
        },
      }),
    ]);
  });

  it("refuses implicit managed target acquisition before explicit preparation", async () => {
    const requests: BrowserBrokerRequest[] = [];
    await startRecordingBroker(requests);
    const handler = buildHandler(selectTools("computer-use"), [], {
      browserPolicy: {
        provider: "managed",
        visibility: "hidden",
        profilePartitionId: "mcp-managed-profile",
      },
    });

    const state = await callBrowserTask(
      handler,
      "computer-use.browser_state",
      {},
      10,
      "mcp-managed-session",
    );
    const navigate = await callBrowserTask(
      handler,
      "computer-use.browser_navigate",
      { url: "https://example.com/next" },
      20,
      "mcp-managed-session",
    );

    expect(state).toMatchObject({
      isError: true,
      structuredContent: {
        data: { error: { code: "browser_requires_setup", exit_code: 69 } },
      },
    });
    expect(navigate).toMatchObject({
      isError: true,
      structuredContent: {
        data: { error: { code: "browser_requires_setup", exit_code: 69 } },
      },
    });
    expect(
      requests.filter((request) => request.action === "target.command"),
    ).toHaveLength(0);
  });

  it("reuses one prepared target across state, trusted ref actions, and navigation", async () => {
    const requests: BrowserBrokerRequest[] = [];
    await startRecordingBroker(requests);
    const handler = buildHandler(selectTools("computer-use"), [], {
      browserPolicy: {
        provider: "managed",
        visibility: "hidden",
        profilePartitionId: "mcp-managed-profile",
      },
    });
    const sessionId = "mcp-managed-session";

    const prepared = await callBrowserTask(
      handler,
      "computer-use.browser_prepare",
      {},
      30,
      sessionId,
    );
    const state = await callBrowserTask(
      handler,
      "computer-use.browser_state",
      { max_refs: 2, max_depth: 20 },
      40,
      sessionId,
    );
    const stateData = readToolData(state);
    const refs = stateData.refs as Array<Record<string, unknown>>;
    const ref = refs[0]?.ref;
    expect(ref).toBe(`p${SNAPSHOT_ID}:1`);
    const clicked = await callBrowserTask(
      handler,
      "computer-use.browser_click",
      { ref },
      50,
      sessionId,
    );
    const typed = await callBrowserTask(
      handler,
      "computer-use.browser_type",
      { ref, text: "Agent input", mode: "keystrokes" },
      60,
      sessionId,
    );
    const navigated = await callBrowserTask(
      handler,
      "computer-use.browser_navigate",
      { url: "https://example.com/next", settle_ms: 25 },
      70,
      sessionId,
    );

    expect(prepared).toMatchObject({
      structuredContent: {
        data: { ok: true, data: { target_id: MANAGED_TARGET_ID } },
      },
    });
    expect(stateData).toMatchObject({
      target: { target_id: MANAGED_TARGET_ID },
      snapshot_id: SNAPSHOT_ID,
      refs: [
        {
          ref: `p${SNAPSHOT_ID}:1`,
          node: "button",
          label: "Continue",
          frame: "main",
        },
      ],
      limitations: { inaccessible_frames: 0, unsupported: [] },
    });
    expect(clicked).toMatchObject({
      structuredContent: {
        data: { ok: true, data: { target: { target_id: MANAGED_TARGET_ID } } },
      },
    });
    expect(typed).toMatchObject({
      structuredContent: {
        data: {
          ok: true,
          data: { mode: "keystrokes", chars: 11 },
        },
      },
    });
    expect(navigated).toMatchObject({
      structuredContent: {
        data: {
          ok: true,
          data: {
            target_id: MANAGED_TARGET_ID,
            url: "https://example.com/next",
          },
        },
      },
    });

    const commands = requests.filter(
      (
        request,
      ): request is Extract<
        BrowserBrokerRequest,
        { action: "target.command" }
      > => request.action === "target.command",
    );
    expect(
      commands
        .slice(1)
        .every((request) => request.target_id === MANAGED_TARGET_ID),
    ).toBe(true);
    expect(commands.map((request) => request.command.method)).toEqual([
      "url",
      "evaluate",
      "click",
      "type",
      "navigate",
      "url",
    ]);
    expect(
      commands.find((request) => request.command.method === "type")?.command,
    ).toMatchObject({
      mode: "keystrokes",
      text: "Agent input",
      snapshot_id: SNAPSHOT_ID,
    });
    expect(
      commands.find((request) => request.command.method === "click")?.command,
    ).toMatchObject({ snapshot_id: SNAPSHOT_ID });
  });

  it("returns screenshot bytes only in MCP image content and reuses the prepared target for direct input", async () => {
    const requests: BrowserBrokerRequest[] = [];
    await startRecordingBroker(requests);
    const handler = buildHandler(selectTools("computer-use"), [], {
      browserPolicy: {
        provider: "managed",
        visibility: "hidden",
        profilePartitionId: "mcp-media-profile",
      },
    });
    const sessionId = "mcp-media-session";

    await callBrowserTask(
      handler,
      "computer-use.browser_prepare",
      {},
      80,
      sessionId,
    );
    const pointed = await callBrowserTask(
      handler,
      "computer-use.browser_click",
      { x: 120, y: 80 },
      85,
      sessionId,
    );
    const screenshot = await callBrowserTask(
      handler,
      "computer-use.browser_screenshot",
      { format: "png", full_page: false },
      90,
      sessionId,
    );
    const pressed = await callBrowserTask(
      handler,
      "computer-use.browser_press",
      { key: "Enter", modifiers: ["meta"] },
      100,
      sessionId,
    );
    const scrolled = await callBrowserTask(
      handler,
      "computer-use.browser_scroll",
      { direction: "bottom" },
      110,
      sessionId,
    );

    expect(screenshot).toMatchObject({
      content: [
        { type: "image", data: PNG_BASE64, mimeType: "image/png" },
        { type: "text" },
      ],
      structuredContent: {
        data: {
          ok: true,
          operation: "browser_screenshot",
          data: {
            target: { target_id: MANAGED_TARGET_ID },
            format: "png",
            bytes: expect.any(Number),
          },
        },
      },
    });
    expect(JSON.stringify(screenshot.structuredContent)).not.toContain(
      PNG_BASE64,
    );
    expect(pointed).toMatchObject({
      structuredContent: {
        data: {
          ok: true,
          data: {
            target: { target_id: MANAGED_TARGET_ID },
            point: { x: 120, y: 80 },
            input_route: "trusted_pointer",
          },
        },
      },
    });
    expect(
      (screenshot.content as Array<{ type?: string; text?: string }>).find(
        (entry) => entry.type === "text",
      )?.text,
    ).not.toContain(PNG_BASE64);
    expect(pressed).toMatchObject({
      structuredContent: {
        data: {
          ok: true,
          data: {
            target: { target_id: MANAGED_TARGET_ID },
            key: "Enter",
            modifiers: ["meta"],
            input_route: "trusted_key_events",
          },
        },
      },
    });
    expect(scrolled).toMatchObject({
      structuredContent: {
        data: {
          ok: true,
          data: {
            target: { target_id: MANAGED_TARGET_ID },
            direction: "bottom",
          },
        },
      },
    });
    expect(
      requests
        .filter(
          (
            request,
          ): request is Extract<
            BrowserBrokerRequest,
            { action: "target.command" }
          > => request.action === "target.command",
        )
        .map((request) => request.command.method),
    ).toEqual(["url", "native_click", "screenshot", "press", "scroll"]);
  });

  it("claims one explicit Chrome tab for bounded dialog and download supervision", async () => {
    const requests: BrowserBrokerRequest[] = [];
    await startRecordingBroker(requests);
    const handler = buildHandler(selectTools("computer-use"), [], {
      browserPolicy: {
        provider: "chrome",
        visibility: "background",
        profilePartitionId: "mcp-supervision-profile",
      },
    });
    const sessionId = "mcp-supervision-session";

    const dialogs = await callBrowserTask(
      handler,
      "computer-use.browser_dialogs",
      { tab_id: 42 },
      120,
      sessionId,
    );
    const responded = await callBrowserTask(
      handler,
      "computer-use.browser_dialog",
      { tab_id: 42, action: "accept", dialog_id: "dialog-1" },
      130,
      sessionId,
    );
    const downloads = await callBrowserTask(
      handler,
      "computer-use.browser_downloads",
      { tab_id: 42, limit: 3 },
      140,
      sessionId,
    );

    for (const result of [dialogs, responded, downloads]) {
      expect(readToolData(result)).toMatchObject({
        target: { tab_id: 42, owned: false },
      });
    }
    expect(readToolData(responded)).toMatchObject({
      responded_dialog: { id: "dialog-1", action: "accept" },
    });
    expect(readToolData(downloads)).toMatchObject({
      limit: 3,
      count: 1,
      downloads: [{ filename_basename: "report.pdf" }],
    });
    expect(
      requests
        .filter(
          (request) =>
            request.action === "chrome.target.claim" ||
            request.action === "target.command",
        )
        .map((request) =>
          request.action === "chrome.target.claim"
            ? `claim:${String(request.tab_id)}`
            : request.command.method,
        ),
    ).toEqual([
      "claim:42",
      "dialog_read",
      "claim:42",
      "dialog_respond",
      "claim:42",
      "downloads_read",
    ]);
  });

  it("rejects incompatible screenshot and dialog options before broker work", async () => {
    const requests: BrowserBrokerRequest[] = [];
    await startRecordingBroker(requests);
    const handler = buildHandler(selectTools("computer-use"), [], {
      browserPolicy: { provider: "chrome", visibility: "background" },
    });

    const screenshot = await handler({
      jsonrpc: "2.0",
      id: 150,
      method: "tools/call",
      params: {
        name: "computer-use.browser_screenshot",
        arguments: { tab_id: 42, format: "png", quality: 80 },
      },
    });
    const dialog = await callBrowserTask(
      handler,
      "computer-use.browser_dialog",
      {
        tab_id: 42,
        action: "dismiss",
        prompt_text: "must not be sent",
      },
      151,
      "mcp-invalid-dialog-session",
    );
    const click = await callBrowserTask(
      handler,
      "computer-use.browser_click",
      {
        tab_id: 42,
        ref: `p${SNAPSHOT_ID}:1`,
        x: 10,
        y: 20,
      },
      152,
      "mcp-invalid-click-session",
    );

    expect(screenshot?.result).toMatchObject({
      isError: true,
      structuredContent: { data: { error: { code: "invalid_input" } } },
    });
    expect(dialog).toMatchObject({
      isError: true,
      structuredContent: { data: { error: { code: "invalid_input" } } },
    });
    expect(click).toMatchObject({
      isError: true,
      structuredContent: { data: { error: { code: "invalid_input" } } },
    });
    expect(
      requests.filter(
        (request) =>
          request.action === "chrome.target.claim" ||
          request.action === "target.command",
      ),
    ).toHaveLength(0);
  });
});

const BROWSER_SESSION_ID = "018f4f68-6f5b-7b01-8c02-123456789abc";
const SNAPSHOT_ID = "018f4f68-6f5b-4b01-8c02-123456789abc";
const MANAGED_TARGET_ID = "managed-target-1";
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n8sAAAAASUVORK5CYII=";

function lateCancellationSignal(
  providerSettled: () => boolean,
  reason: unknown,
): AbortSignal {
  const passiveSignal = new AbortController().signal;
  // REASON: This Web-platform boundary double makes a post-settlement abort
  // observable without racing the broker socket that establishes settlement.
  return new Proxy(passiveSignal, {
    get(target, property) {
      if (property === "aborted") return providerSettled();
      if (property === "reason") {
        return providerSettled() ? reason : undefined;
      }
      if (property === "throwIfAborted") {
        return () => {
          if (providerSettled()) throw reason;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function callBrowserTask(
  handler: JsonRpcHandler,
  name: string,
  args: Record<string, unknown>,
  requestId: number,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const context = { transport: "mcp-stdio" as const, mcpSessionId: sessionId };
  const created = await handler(
    {
      jsonrpc: "2.0",
      id: requestId,
      method: "tools/call",
      params: { name, arguments: args, task: {} },
    },
    context,
  );
  const taskId = (
    created?.result as { task?: { taskId?: unknown } } | undefined
  )?.task?.taskId;
  if (typeof taskId !== "string") {
    throw new Error(`${name} did not create an MCP task`);
  }
  const completed = await handler(
    {
      jsonrpc: "2.0",
      id: requestId + 1,
      method: "tasks/result",
      params: { taskId },
    },
    context,
  );
  if (!completed?.result || typeof completed.result !== "object") {
    throw new Error(`${name} did not return an MCP task result`);
  }
  return completed.result as Record<string, unknown>;
}

function readToolData(
  result: Record<string, unknown>,
): Record<string, unknown> {
  const structured = result.structuredContent as
    | { data?: { data?: unknown } }
    | undefined;
  const data = structured?.data?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("MCP browser tool returned no structured data");
  }
  return data as Record<string, unknown>;
}

async function startRecordingBroker(
  requests: BrowserBrokerRequest[],
  override?: (
    request: BrowserBrokerRequest,
    runtimeId: string,
  ) =>
    | BrowserBrokerResponse
    | undefined
    | Promise<BrowserBrokerResponse | undefined>,
): Promise<void> {
  runtimeRoot = mkdtempSync(join(tmpdir(), "unicli-mcp-browser-unit-"));
  process.env.UNICLI_BROWSER_RUNTIME_DIR = runtimeRoot;
  const runtimeId = randomUUID();
  server = new BrowserRuntimeBrokerServer({
    runtimeRoot,
    runtimeId,
    handler: async (request) => {
      requests.push(request);
      return (
        (await override?.(request, runtimeId)) ??
        responseFor(request, runtimeId, requests)
      );
    },
  });
  await server.start();
}

function responseFor(
  request: BrowserBrokerRequest,
  runtimeId: string,
  requests: readonly BrowserBrokerRequest[],
): BrowserBrokerResponse {
  if (request.action === "broker.status") {
    return { id: request.id, ok: true, data: status(runtimeId, requests) };
  }
  if (request.action === "session.start") {
    return {
      id: request.id,
      ok: true,
      data: {
        agent_session_id: request.context.agent_session_id,
        turn_id: request.context.turn_id,
        session_ttl_ms: 300_000,
      },
    };
  }
  if (request.action === "chrome.content.search") {
    return {
      id: request.id,
      ok: true,
      data: {
        query: request.search.query,
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
            score: 12,
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
  if (request.action === "chrome.target.claim") {
    return {
      id: request.id,
      ok: true,
      data: {
        target_id: chromeTargetId(BROWSER_SESSION_ID, request.tab_id),
        tab_id: request.tab_id,
        window_id: 7,
        owned: false,
        visibility: request.visibility,
        url: "https://example.com/",
        title: "Example",
      },
    };
  }
  if (request.action === "target.command") {
    const provider = request.provider;
    const targetId =
      request.target_id ??
      (provider === "chrome"
        ? chromeTargetId(BROWSER_SESSION_ID, 42)
        : MANAGED_TARGET_ID);
    const chromeOwned =
      provider === "chrome" &&
      requests.some(
        (candidate) =>
          candidate.action === "target.command" &&
          candidate.provider === "chrome" &&
          candidate.target_id === undefined,
      );
    return {
      id: request.id,
      ok: true,
      data: {
        target_id: targetId,
        runtime_id: runtimeId,
        provider,
        visibility: request.visibility,
        owned: provider !== "chrome" || chromeOwned,
        ...(provider === "chrome" ? { tab_id: 42, window_id: 7 } : {}),
        data: commandData(request, requests),
      },
    };
  }
  return { id: request.id, ok: true, data: { accepted: true } };
}

function commandData(
  request: Extract<BrowserBrokerRequest, { action: "target.command" }>,
  requests: readonly BrowserBrokerRequest[],
): unknown {
  const command = request.command;
  if (command.method === "url") return currentUrl(requests);
  if (command.method === "title") return "Example";
  if (command.method === "screenshot") return PNG_BASE64;
  if (command.method === "dialog_read") {
    return {
      evidence_type: "browser-dialog-supervision",
      pending_dialogs: [{ id: "dialog-1", type: "confirm" }],
      recent_dialogs: [],
    };
  }
  if (command.method === "dialog_respond") {
    return {
      evidence_type: "browser-dialog-supervision",
      pending_dialogs: [],
      recent_dialogs: [],
      responded_dialog: {
        id: command.dialog_id ?? "dialog-1",
        action: command.action,
      },
    };
  }
  if (command.method === "downloads_read") {
    return {
      evidence_type: "browser-downloads",
      limit: command.limit ?? 20,
      count: 1,
      downloads: [{ id: 1, filename_basename: "report.pdf" }],
    };
  }
  if (command.method === "evaluate") {
    if (command.expression.includes("const SNAPSHOT_ID =")) {
      return JSON.stringify({
        snapshot_id: SNAPSHOT_ID,
        url: currentUrl(requests),
        url_truncated: false,
        title: "Example",
        tree: "[1]<button>Continue</button>",
        refs: [
          {
            ref: 1,
            tag: "button",
            text: "Continue",
            attrs: {},
            frame: "main",
          },
        ],
        limitations: { inaccessible_frames: 0 },
        truncated: false,
      });
    }
    if (command.expression.includes("typeof window.__unicli_ref_snapshot_id")) {
      return SNAPSHOT_ID;
    }
    if (command.expression.includes("window.__unicli_ref_identity")) {
      return { role: "button", name: "Continue", taken_at: Date.now() };
    }
    if (command.expression.includes("window.__unicli_ref_nodes")) {
      return {
        status: "found",
        ref: "1",
        x: 120,
        y: 80,
        width: 100,
        height: 40,
        frame_depth: 0,
      };
    }
    throw new Error(`Unexpected evaluate expression: ${command.expression}`);
  }
  if (
    command.method === "agent_presence" ||
    command.method === "agent_cursor"
  ) {
    return {
      status:
        command.method === "agent_presence" && !command.visible
          ? "hidden"
          : "visible",
      cursor_visible: command.method === "agent_cursor",
      viewport_width: 1_440,
      viewport_height: 900,
      ...(command.method === "agent_cursor"
        ? { x: command.x, y: command.y }
        : {}),
    };
  }
  return undefined;
}

function currentUrl(requests: readonly BrowserBrokerRequest[]): string {
  return (
    requests
      .filter(
        (
          request,
        ): request is Extract<
          BrowserBrokerRequest,
          { action: "target.command" }
        > =>
          request.action === "target.command" &&
          request.command.method === "navigate",
      )
      .at(-1)?.command.url ?? "https://example.com/"
  );
}

function status(
  runtimeId: string,
  requests: readonly BrowserBrokerRequest[],
): BrowserBrokerStatus {
  const prepared = requests.find(
    (
      request,
    ): request is Extract<BrowserBrokerRequest, { action: "target.command" }> =>
      request.action === "target.command" &&
      request.provider !== "chrome" &&
      request.target_id === undefined,
  );
  const lease = prepared
    ? {
        target_id: MANAGED_TARGET_ID,
        provider: prepared.provider,
        profile_partition_id: prepared.profile_partition_id,
        visibility: prepared.visibility,
        lifetime: "session" as const,
        owner_session_id: prepared.context.agent_session_id,
        owner_turn_id: prepared.context.turn_id,
        claimed_at: new Date().toISOString(),
      }
    : undefined;
  return {
    ok: true,
    product: "unicli",
    protocol: "unicli-browser-runtime",
    version: BROWSER_BROKER_PROTOCOL_VERSION,
    runtime_id: runtimeId,
    broker_pid: process.pid,
    uptime_ms: 1,
    session_ttl_ms: 300_000,
    lifecycle: "running",
    sessions: {
      sessions: lease
        ? [
            {
              agent_session_id: lease.owner_session_id,
              active_turn_ids: [],
              target_ids: [lease.target_id],
              active_target_id: lease.target_id,
              last_activity_ms: Date.now(),
            },
          ]
        : [],
      tombstoned_session_ids: [],
      target_leases: lease ? [lease] : [],
    },
    providers: {
      managed: [],
      chrome: {
        connected: true,
        protocol_version: CHROME_NATIVE_PROTOCOL_VERSION,
        queued_commands: 0,
        in_flight_commands: 0,
        target_count: 0,
        stale_target_count: 0,
      },
      remote: {
        configured: false,
        target_count: 0,
        visibility: "hidden",
      },
    },
  };
}
