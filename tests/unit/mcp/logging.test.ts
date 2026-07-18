import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHandler } from "../../../src/mcp/handler.js";
import { buildDefaultTools, type McpTool } from "../../../src/mcp/tools.js";
import { compileAll } from "../../../src/engine/invoke.js";
import { registerAdapter } from "../../../src/registry.js";
import { AdapterType, type AdapterManifest } from "../../../src/types.js";
import {
  _resetLocalEventLogForTests,
  createLocalEventStore,
  readLocalEvents,
} from "../../../src/runtime/local-event-log.js";
import { loadUsageSources } from "../../../src/runtime/usage-ledger.js";

const originalNoLog = process.env.UNICLI_NO_LOG;
const originalNoLedger = process.env.UNICLI_NO_LEDGER;
const originalLogRoot = process.env.UNICLI_LOG_ROOT;
const FIXTURE_ADAPTER: AdapterManifest = {
  name: "mcp-log-fixture",
  type: AdapterType.WEB_API,
  strategy: "public",
  commands: {
    inspect: {
      name: "inspect",
      description: "Return one local diagnostic fixture",
      adapterArgs: [],
      func: async () => [{ ok: true }],
    },
  },
};

describe("MCP local diagnostics", () => {
  let tempDir: string;
  let logRoot: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "unicli-mcp-log-"));
    logRoot = join(tempDir, "events");
    process.env.UNICLI_LOG_ROOT = logRoot;
    delete process.env.UNICLI_NO_LOG;
    delete process.env.UNICLI_NO_LEDGER;
    _resetLocalEventLogForTests();
    registerAdapter(FIXTURE_ADAPTER);
    compileAll([FIXTURE_ADAPTER]);
  });

  afterEach(() => {
    if (originalNoLog === undefined) delete process.env.UNICLI_NO_LOG;
    else process.env.UNICLI_NO_LOG = originalNoLog;
    if (originalNoLedger === undefined) delete process.env.UNICLI_NO_LEDGER;
    else process.env.UNICLI_NO_LEDGER = originalNoLedger;
    if (originalLogRoot === undefined) delete process.env.UNICLI_LOG_ROOT;
    else process.env.UNICLI_LOG_ROOT = originalLogRoot;
    _resetLocalEventLogForTests();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("records list, search, direct handlers, and sanitized protocol errors", async () => {
    const defaults = buildHandler(buildDefaultTools());
    await defaults({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "unicli_list", arguments: { site: "github" } },
    });
    await defaults({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "unicli_search", arguments: {} },
    });
    await defaults({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "unicli_run",
        arguments: { site: "mcp-log-fixture", command: "inspect" },
      },
    });

    const directTool: McpTool = {
      name: "inspect",
      description: "Inspect a local fixture",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      execution: { taskSupport: "optional" },
      handler: () => ({
        content: [{ type: "text", text: "ok" }],
        structuredContent: { type: "json", data: { ok: true } },
      }),
    };
    const direct = buildHandler([directTool]);
    await direct({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "inspect", arguments: {} },
    });
    await direct({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "secret-token-value", arguments: {} },
    });
    await direct({
      jsonrpc: "2.0",
      id: 6,
      method: "secret/method",
      params: {},
    });

    const events = readLocalEvents(createLocalEventStore());
    expect(events.map((event) => event.command)).toEqual([
      "mcp.unicli_list",
      "mcp.unicli_search",
      "mcp.unicli_run",
      "mcp.inspect",
      "mcp.unknown_tool",
      "mcp.protocol_error",
    ]);
    expect(events.map((event) => event.outcome)).toEqual([
      "success",
      "error",
      "error",
      "success",
      "error",
      "error",
    ]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          transport: "mcp",
          operation_role: "invocation",
        }),
        expect.objectContaining({
          command: "mcp.unicli_run",
          error_type: "invalid_input",
        }),
      ]),
    );
    const raw = readFileSync(
      join(logRoot, `${new Date().toISOString().slice(0, 10)}.jsonl`),
      "utf-8",
    );
    expect(raw).not.toContain("secret-token-value");
    expect(raw).not.toContain("secret/method");
  });

  it("correlates a real kernel child and projects one MCP usage record", async () => {
    const handler = buildHandler(buildDefaultTools());
    const context = {
      transport: "mcp-stdio" as const,
      mcpSessionId: "mcp-log-correlation",
    };
    const created = await handler(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "unicli_run",
          arguments: { site: "mcp-log-fixture", command: "inspect" },
          task: {},
        },
      },
      context,
    );
    const taskId = (
      created?.result as { task?: { taskId?: unknown } } | undefined
    )?.task?.taskId;
    expect(taskId).toEqual(expect.any(String));
    const completed = await handler(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tasks/result",
        params: { taskId },
      },
      context,
    );
    expect(completed?.error).toBeUndefined();
    expect(completed?.result).toMatchObject({
      structuredContent: { data: { count: 1 } },
    });

    const eventStore = createLocalEventStore();
    const events = readLocalEvents(eventStore);
    const child = events.find(
      (event) => event.command === "mcp-log-fixture.inspect",
    );
    const wrapper = events.find((event) => event.command === "mcp.unicli_run");
    expect(child).toMatchObject({
      schema_version: "2",
      transport: "mcp",
      operation_role: "direct",
      parent_invocation_id: wrapper?.invocation_id,
    });
    expect(wrapper).toMatchObject({ operation_role: "invocation" });

    const usage = loadUsageSources({
      ledgerPath: join(tempDir, "missing-legacy.jsonl"),
      eventStore,
    });
    expect(usage.event_records).toBe(1);
    expect(usage.records[0]).toMatchObject({
      site: "mcp-log-fixture",
      cmd: "inspect",
      transport: "mcp",
    });
  });

  it("preserves allowlisted structured tool error semantics", async () => {
    const tool: McpTool = {
      name: "auth_probe",
      description: "Return a typed diagnostic fixture",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      execution: { taskSupport: "optional" },
      handler: () => ({
        isError: true,
        content: [{ type: "text", text: "not persisted" }],
        structuredContent: {
          type: "json",
          data: { code: "auth_required", retryable: true },
        },
      }),
    };
    const handler = buildHandler([tool]);

    await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "auth_probe", arguments: {} },
    });

    expect(readLocalEvents(createLocalEventStore())).toEqual([
      expect.objectContaining({
        command: "mcp.auth_probe",
        outcome: "error",
        error_type: "auth_required",
        retryable: true,
      }),
    ]);
  });
});
