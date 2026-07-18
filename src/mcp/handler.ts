/**
 * @owner       src/mcp/handler.ts
 * @does        Dispatch MCP JSON-RPC methods and durable Tasks, expose callable-surface metadata for adapter versus fixed-core discovery entries, and run each tool call inside its transport-derived browser invocation scope.
 * @needs       registry/discovery, MCP tools/tasks/dispatch/elicitation, browser invocation context/scope/runtime probe, generate permission, constants
 * @feeds       MCP stdio, simple HTTP, and Streamable HTTP transports
 * @breaks      Invalid methods/arguments return JSON-RPC errors; fixed-core unicli_run attempts return an explicit native-CLI route; tool and browser-finalization failures propagate to the owning transport.
 * @invariants  Discovery marks whether unicli_run supports each command; every tools/call receives one Agent session/turn identity before any browser-capable command runs; mutating tools require task augmentation; tasks are scoped to the transport session that created them; transport close settles tasks before ending every no-longer-referenced Agent browser session without starting an absent broker, and retains cleanup ownership until every available broker acknowledgement succeeds.
 * @side-effects Executes registered tools, adapters, elicitation resolution, browser turn finalizers, and transport-owned browser-session cleanup.
 * @perf        Tool lookup is linear in the selected MCP profile; browser scope setup is O(1).
 * @concurrency Async-local browser scopes isolate overlapping tool calls across MCP sessions and turns; transport cleanup is serialized so closeSession/closeAll cannot double-release one broker session.
 * @test        tests/unit/mcp/tools.test.ts, tests/unit/mcp-browser-invocation.test.ts, tests/unit/mcp/browser-control.test.ts
 * @stability   stable
 * @since       2026-04-01
 */

import { randomUUID } from "node:crypto";

import { getAllAdapters, listCommands, resolveCommand } from "../registry.js";
import {
  getCoreDiscoveryCommand,
  listCoreDiscoveryCommands,
} from "../discovery/core-catalog.js";
import {
  annotateIfLarge,
  runResolvedCommand,
  type McpToolResult,
} from "./dispatch.js";
import { expandedRegistry, type McpPrompt, type McpTool } from "./tools.js";
import { MCP_PROTOCOL_VERSION, VERSION } from "../constants.js";
import { resolveElicitation, type ElicitationResponse } from "./elicitation.js";
import { createBrowserInvocationContext } from "../browser/invocation-context.js";
import {
  createBrowserInvocationScope,
  runBrowserInvocation,
  type BrowserProvider,
} from "../browser/invocation-scope.js";
import type { BrowserVisibility } from "../browser/runtime-session.js";
import { probeBrowserRuntimeBroker } from "../browser/runtime-launch.js";
import { BrokerTransportError } from "../browser/runtime-transport.js";
import type {
  JsonRpcHandler,
  JsonRpcRequest,
  JsonRpcResponse,
  McpRequestContext,
} from "./jsonrpc.js";
import {
  authorizeGenerateOperation,
  resolveGenerateOperation,
} from "../commands/generate-permission.js";
import { McpTaskManager } from "./tasks.js";

export type { JsonRpcRequest, JsonRpcResponse };

export interface McpBrowserPolicyInput {
  provider?: BrowserProvider;
  visibility?: BrowserVisibility;
  profilePartitionId?: string;
  isolated?: boolean;
  ephemeral?: boolean;
  profileId?: string;
}

export interface McpBrowserPolicy {
  readonly provider: BrowserProvider;
  readonly visibility: BrowserVisibility;
  readonly profilePartitionId: string;
  readonly isolated: boolean;
  readonly ephemeral: boolean;
  readonly profileId?: string;
}

export interface McpHandlerOptions {
  browserPolicy?: McpBrowserPolicyInput;
}

export function createMcpBrowserPolicy(
  input: McpBrowserPolicyInput = {},
): McpBrowserPolicy {
  const validated = createBrowserInvocationScope({
    context: {
      agent_session_id: "mcp:startup-policy",
      turn_id: "mcp:startup-policy",
      transport: "mcp-stdio",
    },
    ...input,
    profilePartitionId: input.profilePartitionId ?? "default",
  });
  return Object.freeze({
    provider: validated.provider,
    visibility: validated.visibility,
    profilePartitionId: validated.profilePartitionId,
    isolated: validated.isolated,
    ephemeral: validated.ephemeral,
    ...(validated.profileId ? { profileId: validated.profileId } : {}),
  });
}

function handleListAdapters(params: Record<string, unknown>): McpToolResult {
  let commands = [
    ...listCommands().map((command) => ({
      ...command,
      source_kind: "adapter" as const,
      mcp_run_supported: true,
    })),
    ...listCoreDiscoveryCommands().map((command) => ({
      site: command.site,
      command: command.command,
      description: command.description,
      category: command.category,
      type: command.type,
      auth: false,
      quarantined: false,
      source_kind: "core" as const,
      mcp_run_supported: false,
    })),
  ];

  const site = params.site as string | undefined;
  const type = params.type as string | undefined;
  const category = params.category as string | undefined;

  if (site) commands = commands.filter((c) => c.site.includes(site));
  if (type) commands = commands.filter((c) => c.type === type);
  if (category) commands = commands.filter((c) => c.category === category);
  commands = commands.sort(
    (a, b) =>
      a.site.localeCompare(b.site) || a.command.localeCompare(b.command),
  );

  const adapters = getAllAdapters();
  const siteMap = new Map<
    string,
    {
      category: string;
      type: string;
      commands: Array<{
        name: string;
        description: string;
        source_kind: "adapter" | "core";
        mcp_run_supported: boolean;
        invocation: string;
      }>;
    }
  >();

  for (const cmd of commands) {
    let entry = siteMap.get(cmd.site);
    if (!entry) {
      const adapter = adapters.find((a) => a.name === cmd.site);
      entry = {
        category: adapter?.category ?? cmd.category,
        type: adapter?.type ?? cmd.type,
        commands: [],
      };
      siteMap.set(cmd.site, entry);
    }
    entry.commands.push({
      name: cmd.command,
      description: cmd.description,
      source_kind: cmd.source_kind,
      mcp_run_supported: cmd.mcp_run_supported,
      invocation:
        cmd.source_kind === "adapter"
          ? `unicli_run(site=${JSON.stringify(cmd.site)}, command=${JSON.stringify(cmd.command)})`
          : `unicli ${cmd.site} ${cmd.command}`,
    });
  }

  const result = Array.from(siteMap.entries())
    .map(([name, info]) => ({
      site: name,
      category: info.category,
      type: info.type,
      commands: info.commands.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.site.localeCompare(b.site));

  const data = {
    total_sites: result.length,
    total_commands: commands.length,
    adapters: result,
  };

  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: { type: "json", data },
  };
}

async function handleRunCommand(
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<McpToolResult> {
  const site = params.site as string;
  const command = params.command as string;
  const args = (params.args as Record<string, unknown>) ?? {};

  if (!site || !command) {
    const errorData = { error: "site and command are required" };
    return {
      content: [{ type: "text", text: JSON.stringify(errorData) }],
      structuredContent: { type: "json", data: errorData },
      isError: true,
    };
  }

  const resolved = resolveCommand(site, command);
  if (!resolved) {
    const coreCommand = getCoreDiscoveryCommand(site, command);
    if (coreCommand) {
      const invocation = `unicli ${site} ${command}`;
      const errorData = {
        code: "unsupported_surface",
        error: `Fixed core command is not dispatched by unicli_run: ${site} ${command}`,
        source_kind: "core",
        mcp_run_supported: false,
        invocation,
        suggestion: `Run the fixed core command through native CLI: ${invocation}`,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(errorData, null, 2) }],
        structuredContent: { type: "json", data: errorData },
        isError: true,
      };
    }
    const adapters = getAllAdapters();
    const matchingSites = adapters
      .filter((a) => a.name.includes(site))
      .map((a) => ({
        site: a.name,
        commands: Object.keys(a.commands),
      }));

    const errorData = {
      error: `Unknown command: ${site} ${command}`,
      suggestion:
        matchingSites.length > 0
          ? `Did you mean one of these? ${JSON.stringify(matchingSites)}`
          : "Use list_adapters to see all available commands.",
    };
    return {
      content: [{ type: "text", text: JSON.stringify(errorData, null, 2) }],
      structuredContent: { type: "json", data: errorData },
      isError: true,
    };
  }

  return runResolvedCommand(resolved.adapter, resolved.command, {
    cmdName: command,
    args,
    signal,
  });
}

/**
 * Expanded-tool dispatcher — look up `unicli_<site>_<command>` in the
 * registry populated by buildExpandedTools / buildDeferredTools.
 */
async function handleExpandedTool(
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<McpToolResult | undefined> {
  if (!toolName.startsWith("unicli_")) return undefined;
  const entry = expandedRegistry.get(toolName);
  if (!entry) return undefined;
  return runResolvedCommand(entry.adapter, entry.cmd, {
    cmdName: entry.cmdName,
    args: expandedToolArgs(args),
    signal,
  });
}

function expandedToolArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const deferredArgs = args._args;
  if (
    deferredArgs === null ||
    typeof deferredArgs !== "object" ||
    Array.isArray(deferredArgs)
  ) {
    return args;
  }
  const directArgs = Object.fromEntries(
    Object.entries(args).filter(([key]) => key !== "_args"),
  );
  return { ...(deferredArgs as Record<string, unknown>), ...directArgs };
}

function initializeResponse(
  id: JsonRpcResponse["id"],
  prompts: readonly McpPrompt[],
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: false },
        ...(prompts.length > 0 ? { prompts: { listChanged: false } } : {}),
        elicitation: { supported: true },
        tasks: {
          list: {},
          cancel: {},
          requests: { tools: { call: {} } },
        },
      },
      serverInfo: { name: "unicli", version: VERSION },
    },
  };
}

function handlePromptsList(
  id: JsonRpcResponse["id"],
  prompts: readonly McpPrompt[],
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      prompts: prompts.map((prompt) => ({
        name: prompt.name,
        description: prompt.description,
      })),
    },
  };
}

function handlePromptsGet(
  id: JsonRpcResponse["id"],
  req: JsonRpcRequest,
  prompts: readonly McpPrompt[],
): JsonRpcResponse {
  const params = req.params as { name?: unknown } | undefined;
  const name = typeof params?.name === "string" ? params.name : undefined;
  const prompt = name
    ? prompts.find((candidate) => candidate.name === name)
    : undefined;
  if (!prompt) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32602,
        message: name
          ? `Unknown prompt: ${name}`
          : "Missing required prompt name",
      },
    };
  }
  return {
    jsonrpc: "2.0",
    id,
    result: {
      description: prompt.description,
      messages: [
        {
          role: "user",
          content: { type: "text", text: prompt.text },
        },
      ],
    },
  };
}

async function dispatchBuiltin(
  id: JsonRpcResponse["id"],
  name: string,
  toolArgs: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<JsonRpcResponse | undefined> {
  switch (name) {
    case "unicli_list":
    case "list_adapters": {
      const result = handleListAdapters(toolArgs);
      return { jsonrpc: "2.0", id, result: annotateIfLarge(result) };
    }
    case "unicli_run":
    case "run_command": {
      const result = await handleRunCommand(toolArgs, signal);
      return { jsonrpc: "2.0", id, result: annotateIfLarge(result) };
    }
    case "unicli_search":
      return dispatchSearch(id, toolArgs);
    case "unicli_explore":
    case "unicli_discover":
      return dispatchExplore(id, toolArgs, signal);
  }
  return undefined;
}

async function dispatchSearch(
  id: JsonRpcResponse["id"],
  toolArgs: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  const searchQuery = toolArgs.query as string;
  const searchLimit = (toolArgs.limit as number) || 5;
  const searchCategory = toolArgs.category as string | undefined;
  if (!searchQuery) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: "Missing required parameter: query" },
    };
  }
  const { search: searchFn } = await import("../discovery/search.js");
  const results = searchFn(searchQuery, searchLimit, {
    category: searchCategory,
  });
  const data = {
    query: searchQuery,
    category: searchCategory,
    count: results.length,
    results: results.map((r) => {
      const isCore =
        resolveCommand(r.site, r.command) === undefined &&
        getCoreDiscoveryCommand(r.site, r.command) !== undefined;
      return {
        command: `unicli ${r.site} ${r.command}`,
        site: r.site,
        name: r.command,
        description: r.description,
        score: r.score,
        category: r.category,
        usage: r.usage,
        source_kind: isCore ? "core" : "adapter",
        mcp_run_supported: !isCore,
      };
    }),
  };
  return {
    jsonrpc: "2.0",
    id,
    result: annotateIfLarge({
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      structuredContent: { type: "json", data },
    }),
  };
}

async function dispatchExplore(
  id: JsonRpcResponse["id"],
  toolArgs: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<JsonRpcResponse> {
  const discoverUrl = toolArgs.url as string;
  const discoverGoal = toolArgs.goal as string | undefined;
  if (!discoverUrl) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: "Missing required parameter: url" },
    };
  }
  if (
    !discoverUrl.startsWith("http://") &&
    !discoverUrl.startsWith("https://")
  ) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32602,
        message: "URL must start with http:// or https://",
      },
    };
  }
  try {
    signal?.throwIfAborted();
    const operation = resolveGenerateOperation({
      url: discoverUrl,
      goal: discoverGoal,
    });
    await authorizeGenerateOperation(operation);
    signal?.throwIfAborted();
    const [{ execFile: ef }, { promisify: prom }] = await Promise.all([
      import("node:child_process"),
      import("node:util"),
    ]);
    const execFileP = prom(ef);
    const discoverArgs = ["generate", discoverUrl, "--json"];
    if (discoverGoal) discoverArgs.push("--goal", discoverGoal);
    const { stdout } = await execFileP("unicli", discoverArgs, {
      timeout: 120_000,
      encoding: "utf-8",
      signal,
    });
    return {
      jsonrpc: "2.0",
      id,
      result: annotateIfLarge({
        content: [{ type: "text", text: stdout }],
      }),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const tagged = err as Partial<{
      code: string;
      suggestion: string;
      retryable: boolean;
    }>;
    const data = {
      error: message,
      ...(tagged.code ? { code: tagged.code } : {}),
      ...(tagged.suggestion ? { suggestion: tagged.suggestion } : {}),
      retryable: tagged.retryable ?? false,
    };
    return {
      jsonrpc: "2.0",
      id,
      result: annotateIfLarge({
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        structuredContent: { type: "json", data },
        isError: true,
      }),
    };
  }
}

async function handleToolsCall(
  id: JsonRpcResponse["id"],
  req: JsonRpcRequest,
  tools: McpTool[],
  browserPolicy: McpBrowserPolicy,
  requestContext?: McpRequestContext,
  onBrowserInvocation?: (agentSessionId: string) => void,
): Promise<JsonRpcResponse> {
  const params = req.params as
    | { name: string; arguments?: Record<string, unknown> }
    | undefined;
  if (!params?.name) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: "Missing tool name" },
    };
  }
  const invocationContext = createBrowserInvocationContext({
    transport: requestContext?.transport ?? "mcp-stdio",
    mcpSessionId: requestContext?.mcpSessionId,
    metadata: req.params?._meta,
  });
  onBrowserInvocation?.(invocationContext.agent_session_id);
  const scope = createBrowserInvocationScope({
    context: invocationContext,
    ...browserPolicy,
    signal: requestContext?.signal,
  });
  return runBrowserInvocation(scope, async () => {
    const toolArgs = params.arguments ?? {};
    const directTool = tools.find((tool) => tool.name === params.name);
    if (directTool?.handler) {
      const result = await directTool.handler(toolArgs, {
        signal: requestContext?.signal,
      });
      return { jsonrpc: "2.0", id, result: annotateIfLarge(result) };
    }
    const builtin = await dispatchBuiltin(
      id,
      params.name,
      toolArgs,
      requestContext?.signal,
    );
    if (builtin) return builtin;
    const result = await handleExpandedTool(
      params.name,
      toolArgs,
      requestContext?.signal,
    );
    if (result) {
      return { jsonrpc: "2.0", id, result: annotateIfLarge(result) };
    }
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32602,
        message: `Unknown tool: ${params.name}. Use unicli_list to see available commands.`,
      },
    };
  });
}

function handleElicitationResponse(
  id: JsonRpcResponse["id"],
  req: JsonRpcRequest,
): JsonRpcResponse {
  const elicitParams = req.params as
    | { id: string | number; response: ElicitationResponse }
    | undefined;
  if (elicitParams?.id == null || !elicitParams?.response) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32602,
        message: "Missing id or response in elicitation/response",
      },
    };
  }
  const resolved = resolveElicitation(elicitParams.id, elicitParams.response);
  return { jsonrpc: "2.0", id, result: { resolved } };
}

export function buildHandler(
  tools: McpTool[],
  prompts: McpPrompt[] = [],
  options: McpHandlerOptions = {},
): JsonRpcHandler {
  const browserPolicy = createMcpBrowserPolicy(options.browserPolicy);
  const taskManager = new McpTaskManager();
  const advertisedTools = tools.map(withDefaultTaskSupport);
  const browserSessionsByTransport = new Map<string, Set<string>>();
  let browserCleanupTail = Promise.resolve();
  const serializeBrowserCleanup = (
    cleanup: () => Promise<void>,
  ): Promise<void> => {
    const result = browserCleanupTail.then(cleanup, cleanup);
    browserCleanupTail = result.catch(() => undefined);
    return result;
  };
  const rememberBrowserInvocation = (
    transportSessionId: string,
    agentSessionId: string,
  ): void => {
    let sessions = browserSessionsByTransport.get(transportSessionId);
    if (!sessions) {
      sessions = new Set();
      browserSessionsByTransport.set(transportSessionId, sessions);
    }
    sessions.add(agentSessionId);
  };
  const handleRequest: JsonRpcHandler = function handleRequest(
    req: JsonRpcRequest,
    requestContext?: McpRequestContext,
  ): JsonRpcResponse | undefined | Promise<JsonRpcResponse | undefined> {
    const id = req.id ?? null;
    const sessionId = requestContext?.mcpSessionId ?? "mcp:default";

    switch (req.method) {
      case "initialize":
        return initializeResponse(id, prompts);
      case "notifications/initialized":
        // Notifications have no response — transports already guard `if (response)`.
        return undefined;
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: advertisedTools } };
      case "tools/call": {
        const params = req.params;
        const tool = resolveAdvertisedTool(advertisedTools, params?.name);
        if (!tool) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32602,
              message: `Unknown tool: ${String(params?.name ?? "")}. Use unicli_list to see available commands.`,
            },
          };
        }
        const requestedTask = parseTaskRequest(params);
        if (requestedTask instanceof Error) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: requestedTask.message },
          };
        }
        const taskSupport = tool.execution?.taskSupport ?? "forbidden";
        if (requestedTask === undefined && taskSupport === "required") {
          return taskSupportError(id, tool.name, "requires task augmentation");
        }
        if (requestedTask !== undefined && taskSupport === "forbidden") {
          return taskSupportError(id, tool.name, "forbids task augmentation");
        }
        if (requestedTask !== undefined) {
          return taskManager.create({
            requestId: id,
            sessionId,
            requestedTtl: requestedTask.ttl,
            transport: requestContext?.transport ?? "mcp-stdio",
            execute: (taskId, taskContext) =>
              handleToolsCall(
                id,
                withRelatedTaskRequest(req, taskId),
                advertisedTools,
                browserPolicy,
                taskContext,
                (agentSessionId) =>
                  rememberBrowserInvocation(sessionId, agentSessionId),
              ),
          });
        }
        return handleToolsCall(
          id,
          req,
          advertisedTools,
          browserPolicy,
          requestContext,
          (agentSessionId) =>
            rememberBrowserInvocation(sessionId, agentSessionId),
        );
      }
      case "tasks/get":
        return taskManager.get(id, sessionId, req.params?.taskId);
      case "tasks/result":
        return taskManager.result(
          id,
          sessionId,
          req.params?.taskId,
          requestContext?.signal,
        );
      case "tasks/list":
        return taskManager.list(id, sessionId, req.params?.cursor);
      case "tasks/cancel":
        return taskManager.cancel(id, sessionId, req.params?.taskId);
      case "prompts/list":
        return handlePromptsList(id, prompts);
      case "prompts/get":
        return handlePromptsGet(id, req, prompts);
      case "elicitation/response":
        return handleElicitationResponse(id, req);
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      default:
        if (id !== null && id !== undefined) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: `Method not found: ${req.method}`,
            },
          };
        }
        return undefined;
    }
  };
  handleRequest.closeSession = async (sessionId, reason) => {
    await taskManager.closeSession(sessionId, reason);
    await serializeBrowserCleanup(async () => {
      const agentSessionIds = browserSessionsToEndForTransport(
        browserSessionsByTransport,
        sessionId,
      );
      await endBrowserAgentSessions(agentSessionIds);
      browserSessionsByTransport.delete(sessionId);
    });
  };
  handleRequest.closeAll = async (reason) => {
    await taskManager.closeAll(reason);
    await serializeBrowserCleanup(async () => {
      const agentSessionIds = new Set(
        [...browserSessionsByTransport.values()].flatMap((sessions) => [
          ...sessions,
        ]),
      );
      await endBrowserAgentSessions([...agentSessionIds]);
      browserSessionsByTransport.clear();
    });
  };
  return handleRequest;
}

function browserSessionsToEndForTransport(
  sessionsByTransport: Map<string, Set<string>>,
  transportSessionId: string,
): string[] {
  const closing = sessionsByTransport.get(transportSessionId);
  if (!closing) return [];
  const retained = new Set(
    [...sessionsByTransport.entries()].flatMap(([sessionId, sessions]) =>
      sessionId === transportSessionId ? [] : [...sessions],
    ),
  );
  return [...closing].filter((agentSessionId) => !retained.has(agentSessionId));
}

async function endBrowserAgentSessions(
  agentSessionIds: readonly string[],
): Promise<void> {
  const results = await Promise.allSettled(
    agentSessionIds.map(endBrowserAgentSession),
  );
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Browser Agent session cleanup failed");
  }
}

async function endBrowserAgentSession(agentSessionId: string): Promise<void> {
  try {
    const { client } = await probeBrowserRuntimeBroker();
    await client.requestOrThrow({
      id: randomUUID(),
      action: "session.end",
      agent_session_id: agentSessionId,
    });
  } catch (error) {
    if (
      error instanceof BrokerTransportError &&
      error.code === "browser_broker_unavailable"
    ) {
      return;
    }
    throw error;
  }
}

function withDefaultTaskSupport(tool: McpTool): McpTool {
  if (tool.execution) return tool;
  return {
    ...tool,
    execution: {
      taskSupport:
        tool.annotations?.readOnlyHint === true ? "optional" : "required",
    },
  };
}

function resolveAdvertisedTool(
  tools: readonly McpTool[],
  name: unknown,
): McpTool | undefined {
  if (typeof name !== "string") return undefined;
  const canonical =
    name === "run_command"
      ? "unicli_run"
      : name === "list_adapters"
        ? "unicli_list"
        : name === "unicli_discover"
          ? "unicli_explore"
          : name;
  return tools.find((tool) => tool.name === canonical);
}

function parseTaskRequest(
  params: Record<string, unknown> | undefined,
): { ttl?: number } | undefined | Error {
  if (!params || !Object.hasOwn(params, "task")) return undefined;
  const task = params.task;
  if (typeof task !== "object" || task === null || Array.isArray(task)) {
    return new Error("Task metadata must be an object");
  }
  const ttl = (task as Record<string, unknown>).ttl;
  if (ttl !== undefined && typeof ttl !== "number") {
    return new Error("Task ttl must be a number in milliseconds");
  }
  return ttl === undefined ? {} : { ttl };
}

function taskSupportError(
  id: JsonRpcResponse["id"],
  toolName: string,
  reason: string,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Tool ${toolName} ${reason}` },
  };
}

function withRelatedTaskRequest(
  request: JsonRpcRequest,
  taskId: string,
): JsonRpcRequest {
  const params = request.params ?? {};
  const meta =
    typeof params._meta === "object" &&
    params._meta !== null &&
    !Array.isArray(params._meta)
      ? (params._meta as Record<string, unknown>)
      : {};
  const { task: _task, ...withoutTask } = params;
  return {
    ...request,
    params: {
      ...withoutTask,
      _meta: {
        ...meta,
        "io.modelcontextprotocol/related-task": { taskId },
      },
    },
  };
}
