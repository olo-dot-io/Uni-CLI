/**
 * @owner       src/mcp/handler.ts
 * @does        Dispatch dual-era MCP JSON-RPC, expose stateless 2026 discovery/results, retain legacy Tasks, and run each tool call inside its browser invocation scope.
 * @needs       registry/discovery, MCP tools/tasks/dispatch/elicitation/local observation, browser invocation context/scope/runtime probe, generate permission, constants
 * @feeds       MCP stdio, simple HTTP, and Streamable HTTP transports
 * @breaks      Invalid methods/arguments return JSON-RPC errors; fixed-core unicli_run attempts return an explicit native-CLI route; tool and browser-finalization failures propagate to the owning transport.
 * @invariants  Modern requests carry version/capabilities per call and receive resultType/server identity; legacy mutations require session-scoped Tasks; every tools/call receives browser and diagnostic identities; transport close settles retained legacy Tasks and browser sessions; raw unknown names never enter diagnostics.
 * @side-effects Executes registered tools, adapters, elicitation resolution, browser finalizers, transport cleanup, and bounded terminal diagnostic appends.
 * @perf        Tool lookup is linear in the selected profile; observation is linear in response bytes; browser scope setup is O(1).
 * @concurrency Request-local observations and async-local browser scopes isolate calls; transport cleanup is serialized.
 * @test        tests/unit/mcp/tools.test.ts, tests/unit/mcp/logging.test.ts, tests/unit/mcp-browser-invocation.test.ts, tests/unit/mcp/browser-control.test.ts
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
import {
  MCP_MODERN_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  VERSION,
} from "../constants.js";
import { resolveElicitation, type ElicitationResponse } from "./elicitation.js";
import { createBrowserInvocationContext } from "../browser/invocation-context.js";
import {
  releaseAllTransportBusNamespaces,
  releaseTransportBusNamespace,
} from "../transport/bus.js";
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
import { jsonRpcError } from "./jsonrpc.js";
import {
  authorizeGenerateOperation,
  resolveGenerateOperation,
} from "../commands/generate-permission.js";
import { McpTaskManager } from "./tasks.js";
import {
  MCP_TASKS_CAPABILITY_REQUIRED,
  MCP_TASKS_EXTENSION_ID,
  ModernMcpTaskManager,
} from "./modern-tasks.js";
import { McpSubscriptionManager } from "./subscriptions.js";
import { localLoggingDisabledChildEnv } from "../runtime/child-process-env.js";
import {
  completeMcpCallObservation,
  createMcpCallObservation,
  createMcpErrorObservation,
  recordThrownMcpCall,
} from "./local-observation.js";
import { enforceJsonRpcResultBudget } from "./result-budget.js";

export type { JsonRpcRequest, JsonRpcResponse };

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const MCP_TOOL_LIST_PAGE_SIZE = 256;
const MCP_CATALOG_DEFAULT_PAGE_SIZE = 200;
const MCP_CATALOG_MAX_PAGE_SIZE = 256;

function parseCursor(
  value: unknown,
  prefix: string,
  itemCount: number,
): number | Error {
  if (value === undefined) return 0;
  if (typeof value !== "string") return new Error("cursor must be a string");
  const match = new RegExp(`^${prefix}:(0|[1-9][0-9]*)$`).exec(value);
  if (!match) return new Error("cursor is invalid or belongs to another list");
  const offset = Number(match[1]);
  return Number.isSafeInteger(offset) && offset <= itemCount
    ? offset
    : new Error("cursor is outside the current list");
}

function toolInputError(message: string): McpToolResult {
  const data = { code: "invalid_input", error: message, retryable: false };
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: { type: "json", data },
    isError: true,
  };
}

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
  modernTaskStoreDirectory?: string;
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

  const totalCommands = commands.length;
  const totalSites = new Set(commands.map((command) => command.site)).size;
  const cursor = parseCursor(params.cursor, "catalog", totalCommands);
  if (cursor instanceof Error) return toolInputError(cursor.message);
  const requestedLimit = params.limit ?? MCP_CATALOG_DEFAULT_PAGE_SIZE;
  if (
    typeof requestedLimit !== "number" ||
    !Number.isInteger(requestedLimit) ||
    requestedLimit < 1 ||
    requestedLimit > MCP_CATALOG_MAX_PAGE_SIZE
  ) {
    return toolInputError(
      `limit must be an integer from 1 to ${MCP_CATALOG_MAX_PAGE_SIZE}`,
    );
  }
  const pageEnd = Math.min(totalCommands, cursor + requestedLimit);
  const pageCommands = commands.slice(cursor, pageEnd);

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

  for (const cmd of pageCommands) {
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
    total_sites: totalSites,
    total_commands: totalCommands,
    returned_commands: pageCommands.length,
    ...(pageEnd < totalCommands ? { next_cursor: `catalog:${pageEnd}` } : {}),
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
  parentInvocationId?: string,
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
    parentInvocationId,
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
  parentInvocationId?: string,
): Promise<McpToolResult | undefined> {
  if (!toolName.startsWith("unicli_")) return undefined;
  const entry = expandedRegistry.get(toolName);
  if (!entry) return undefined;
  return runResolvedCommand(entry.adapter, entry.cmd, {
    cmdName: entry.cmdName,
    args: expandedToolArgs(args),
    signal,
    parentInvocationId,
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
  _prompts: readonly McpPrompt[],
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: false },
        prompts: { listChanged: false },
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

const MCP_LIST_TTL_MS = 300_000;
const MCP_DISCOVERY_TTL_MS = 3_600_000;

type McpProtocolEra = "legacy" | "modern";

type McpProtocolClassification =
  | { era: McpProtocolEra }
  | { error: JsonRpcResponse };

function classifyProtocolRequest(
  req: JsonRpcRequest,
): McpProtocolClassification {
  const meta = readRecord(req.params?._meta);
  const requestedVersion = meta?.["io.modelcontextprotocol/protocolVersion"];
  const modern =
    req.method === "server/discover" || requestedVersion !== undefined;
  if (!modern) return { era: "legacy" };

  if (typeof requestedVersion !== "string") {
    return {
      error: jsonRpcError(
        req.id ?? null,
        -32_602,
        "Missing required _meta field: io.modelcontextprotocol/protocolVersion",
      ),
    };
  }
  const clientCapabilities =
    meta?.["io.modelcontextprotocol/clientCapabilities"];
  if (!readRecord(clientCapabilities)) {
    return {
      error: jsonRpcError(
        req.id ?? null,
        -32_602,
        "Missing required _meta field: io.modelcontextprotocol/clientCapabilities",
      ),
    };
  }
  if (requestedVersion !== MCP_MODERN_PROTOCOL_VERSION) {
    return {
      error: jsonRpcError(
        req.id ?? null,
        -32_022,
        "Unsupported protocol version",
        {
          supported: [...MCP_SUPPORTED_PROTOCOL_VERSIONS],
          requested: requestedVersion,
        },
      ),
    };
  }
  if (Object.hasOwn(req, "id") && req.id === null) {
    return {
      error: jsonRpcError(
        null,
        -32_600,
        "Modern MCP request ids must not be null",
      ),
    };
  }
  return { era: "modern" };
}

function serverDiscoverResponse(
  id: JsonRpcResponse["id"],
  _prompts: readonly McpPrompt[],
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      resultType: "complete",
      supportedVersions: [...MCP_SUPPORTED_PROTOCOL_VERSIONS],
      capabilities: {
        tools: {},
        prompts: {},
        extensions: {
          [MCP_TASKS_EXTENSION_ID]: {},
        },
      },
      instructions:
        "Discover an operation first; execute through its declared operator. Visual computer control requires an explicit route.",
      ttlMs: MCP_DISCOVERY_TTL_MS,
      cacheScope: "public",
    },
  };
}

function modernToolList(tools: readonly McpTool[]): object[] {
  return tools.map(({ execution: _legacyExecution, ...tool }) => tool);
}

function toolsListResponse(
  id: JsonRpcResponse["id"],
  req: JsonRpcRequest,
  tools: readonly McpTool[],
  era: McpProtocolEra,
): JsonRpcResponse {
  const visibleTools = era === "modern" ? modernToolList(tools) : tools;
  const cursor = parseCursor(req.params?.cursor, "tools", visibleTools.length);
  if (cursor instanceof Error) {
    return jsonRpcError(
      id,
      -32_602,
      `Invalid tools/list cursor: ${cursor.message}`,
    );
  }
  const pageEnd = Math.min(
    visibleTools.length,
    cursor + MCP_TOOL_LIST_PAGE_SIZE,
  );
  return {
    jsonrpc: "2.0",
    id,
    result: {
      tools: visibleTools.slice(cursor, pageEnd),
      ...(pageEnd < visibleTools.length
        ? { nextCursor: `tools:${pageEnd}` }
        : {}),
      ...(era === "modern"
        ? { ttlMs: MCP_LIST_TTL_MS, cacheScope: "public" }
        : {}),
    },
  };
}

function decorateModernResponse(
  response: JsonRpcResponse | undefined,
): JsonRpcResponse | undefined {
  if (!response?.result) return response;
  const result = readRecord(response.result);
  if (!result) return response;
  return {
    ...response,
    result: {
      resultType:
        typeof result.resultType === "string" ? result.resultType : "complete",
      ...result,
      _meta: {
        ...readRecord(result._meta),
        "io.modelcontextprotocol/serverInfo": {
          name: "unicli",
          version: VERSION,
        },
      },
    },
  };
}

function protocolMethodNotFound(
  id: JsonRpcResponse["id"],
  method: string,
): JsonRpcResponse {
  return jsonRpcError(id, -32_601, `Method not found: ${method}`);
}

function isPromiseLike(
  value: unknown,
): value is PromiseLike<JsonRpcResponse | undefined> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
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
  parentInvocationId?: string,
): Promise<JsonRpcResponse | undefined> {
  switch (name) {
    case "unicli_list":
    case "list_adapters": {
      const result = handleListAdapters(toolArgs);
      return { jsonrpc: "2.0", id, result: annotateIfLarge(result) };
    }
    case "unicli_run":
    case "run_command": {
      const result = await handleRunCommand(
        toolArgs,
        signal,
        parentInvocationId,
      );
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
  const searchOperator = toolArgs.operator as
    | import("../types.js").ExecutionOperator
    | undefined;
  const targetSurface = toolArgs.target_surface as
    | import("../types.js").TargetSurface
    | undefined;
  const searchEffect = toolArgs.effect as
    | import("../types.js").OperationEffect
    | undefined;
  const maxInteractionImpact = toolArgs.max_interaction_impact as
    | import("../discovery/feasibility.js").InteractionImpact
    | undefined;
  const searchPlatform = toolArgs.platform as NodeJS.Platform | undefined;
  if (!searchQuery) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: "Missing required parameter: query" },
    };
  }
  const { search: searchFn } = await import("../discovery/search.js");
  const requirements: import("../discovery/feasibility.js").CapabilityRequirements =
    {
      ...(searchOperator ? { operator: searchOperator } : {}),
      ...(targetSurface ? { target_surface: targetSurface } : {}),
      ...(searchEffect ? { effect: searchEffect } : {}),
      ...(maxInteractionImpact
        ? { max_interaction_impact: maxInteractionImpact }
        : {}),
      platform: searchPlatform ?? process.platform,
      allow_coordinate_actuation:
        toolArgs.allow_coordinate_actuation === true ||
        searchOperator === "visual-coordinate",
    };
  const results = searchFn(searchQuery, searchLimit, {
    category: searchCategory,
    requirements,
  });
  const data = {
    query: searchQuery,
    category: searchCategory,
    requirements,
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
        ...(r.feasibility
          ? {
              operator: r.feasibility.operator,
              effect: r.feasibility.effect,
              target_surface: r.feasibility.target_surface,
              target_scope: r.feasibility.target_scope,
              interaction_impact: r.feasibility.interaction_impact,
            }
          : {}),
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
      env: localLoggingDisabledChildEnv(),
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
  toolsByName: ReadonlyMap<string, McpTool>,
  browserPolicy: McpBrowserPolicy,
  requestContext?: McpRequestContext,
  onBrowserInvocation?: (agentSessionId: string) => void,
): Promise<JsonRpcResponse> {
  const params = req.params as
    | { name: string; arguments?: Record<string, unknown> }
    | undefined;
  const observation = createMcpCallObservation(params?.name);
  if (!params?.name) {
    return completeMcpCallObservation(observation, {
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: "Missing tool name" },
    });
  }
  const invocationContext = createBrowserInvocationContext({
    transport: requestContext?.transport ?? "mcp-stdio",
    mcpSessionId: requestContext?.mcpSessionId,
    principalId: requestContext?.principalId,
    metadata: req.params?._meta,
  });
  onBrowserInvocation?.(invocationContext.agent_session_id);
  const scope = createBrowserInvocationScope({
    context: invocationContext,
    ...browserPolicy,
    signal: requestContext?.signal,
  });
  try {
    const response = await runBrowserInvocation(scope, async () => {
      const toolArgs = params.arguments ?? {};
      const directTool = resolveAdvertisedTool(toolsByName, params.name);
      if (directTool?.handler) {
        const result = await directTool.handler(toolArgs, {
          signal: requestContext?.signal,
          task: requestContext?.task,
          principalId: requestContext?.principalId,
          mcpSessionId: requestContext?.mcpSessionId,
          agentSessionId: invocationContext.agent_session_id,
        });
        return { jsonrpc: "2.0" as const, id, result: annotateIfLarge(result) };
      }
      const builtin = await dispatchBuiltin(
        id,
        params.name,
        toolArgs,
        requestContext?.signal,
        observation.invocationId,
      );
      if (builtin) return builtin;
      const result = await handleExpandedTool(
        params.name,
        toolArgs,
        requestContext?.signal,
        observation.invocationId,
      );
      if (result) {
        return { jsonrpc: "2.0" as const, id, result: annotateIfLarge(result) };
      }
      return {
        jsonrpc: "2.0" as const,
        id,
        error: {
          code: -32602,
          message: `Unknown tool: ${params.name}. Use unicli_list to see available commands.`,
        },
      };
    });
    return completeMcpCallObservation(observation, response);
  } catch (error) {
    const warning = recordThrownMcpCall(observation);
    if (warning) {
      throw new AggregateError(
        [error, new Error(warning)],
        "MCP tool execution and local diagnostics both failed",
      );
    }
    throw error;
  }
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
  const modernTaskManager = new ModernMcpTaskManager(
    options.modernTaskStoreDirectory
      ? { directory: options.modernTaskStoreDirectory }
      : {},
  );
  const subscriptionManager = new McpSubscriptionManager(modernTaskManager);
  const modernTaskSelectors = new Map(
    tools.flatMap((tool) =>
      tool.selectModernTask
        ? [[tool.name, tool.selectModernTask] as const]
        : [],
    ),
  );
  const advertisedTools = tools.map(
    ({ selectModernTask: _internalTaskSelector, ...tool }) =>
      withDefaultTaskSupport(tool),
  );
  const advertisedToolsByName = indexAdvertisedTools(advertisedTools);
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
  function dispatchProtocolRequest(
    req: JsonRpcRequest,
    requestContext: McpRequestContext | undefined,
    era: McpProtocolEra,
  ): JsonRpcResponse | undefined | Promise<JsonRpcResponse | undefined> {
    const id = req.id ?? null;
    const sessionId = requestContext?.mcpSessionId ?? "mcp:default";
    const startedAt = Date.now();

    switch (req.method) {
      case "server/discover":
        return serverDiscoverResponse(id, prompts);
      case "initialize":
        return era === "legacy"
          ? initializeResponse(id, prompts)
          : protocolMethodNotFound(id, req.method);
      case "notifications/initialized":
        // Notifications have no response — transports already guard `if (response)`.
        return undefined;
      case "tools/list":
        return toolsListResponse(id, req, advertisedTools, era);
      case "tools/call": {
        const params = req.params;
        const tool = resolveAdvertisedTool(advertisedToolsByName, params?.name);
        if (!tool) {
          return completeMcpCallObservation(
            createMcpErrorObservation("unknown_tool", startedAt),
            {
              jsonrpc: "2.0",
              id,
              error: {
                code: -32602,
                message: `Unknown tool: ${String(params?.name ?? "")}. Use unicli_list to see available commands.`,
              },
            },
          );
        }
        if (era === "modern") {
          const taskSupport = tool.execution?.taskSupport ?? "forbidden";
          const supportsTasks = hasModernTasksCapability(req);
          if (taskSupport === "required" && !supportsTasks) {
            return completeMcpCallObservation(
              createMcpCallObservation(tool.name, startedAt),
              missingTasksCapability(id),
            );
          }
          const selector = modernTaskSelectors.get(tool.name);
          const selectedMode =
            taskSupport === "required"
              ? "task"
              : taskSupport === "optional" && supportsTasks && selector
                ? selector(readRecord(params?.arguments) ?? {}, {
                    transport: requestContext?.transport ?? "mcp-stdio",
                    ...(requestContext?.principalId
                      ? { principalId: requestContext.principalId }
                      : {}),
                  })
                : "sync";
          if (selectedMode === "task") {
            return modernTaskManager.create({
              requestId: id,
              principalId: requestContext?.principalId,
              transport: requestContext?.transport ?? "mcp-stdio",
              execute: (taskId, taskContext) =>
                handleToolsCall(
                  id,
                  withRelatedTaskRequest(req, taskId),
                  advertisedToolsByName,
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
            advertisedToolsByName,
            browserPolicy,
            requestContext,
            (agentSessionId) =>
              rememberBrowserInvocation(sessionId, agentSessionId),
          );
        }
        const requestedTask = parseTaskRequest(params);
        if (requestedTask instanceof Error) {
          return completeMcpCallObservation(
            createMcpCallObservation(tool.name, startedAt),
            {
              jsonrpc: "2.0",
              id,
              error: { code: -32602, message: requestedTask.message },
            },
          );
        }
        const taskSupport = tool.execution?.taskSupport ?? "forbidden";
        if (requestedTask === undefined && taskSupport === "required") {
          return completeMcpCallObservation(
            createMcpCallObservation(tool.name, startedAt),
            taskSupportError(id, tool.name, "requires task augmentation"),
          );
        }
        if (requestedTask !== undefined && taskSupport === "forbidden") {
          return completeMcpCallObservation(
            createMcpCallObservation(tool.name, startedAt),
            taskSupportError(id, tool.name, "forbids task augmentation"),
          );
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
                advertisedToolsByName,
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
          advertisedToolsByName,
          browserPolicy,
          requestContext,
          (agentSessionId) =>
            rememberBrowserInvocation(sessionId, agentSessionId),
        );
      }
      case "tasks/get":
        if (era === "modern") {
          if (!hasModernTasksCapability(req)) {
            return missingTasksCapability(id);
          }
          return modernTaskManager.get(
            id,
            requestContext?.principalId,
            req.params?.taskId,
          );
        }
        return taskManager.get(id, sessionId, req.params?.taskId);
      case "tasks/result":
        if (era === "modern") return protocolMethodNotFound(id, req.method);
        return taskManager.result(
          id,
          sessionId,
          req.params?.taskId,
          requestContext?.signal,
        );
      case "tasks/list":
        if (era === "modern") return protocolMethodNotFound(id, req.method);
        return taskManager.list(id, sessionId, req.params?.cursor);
      case "tasks/cancel":
        if (era === "modern") {
          if (!hasModernTasksCapability(req)) {
            return missingTasksCapability(id);
          }
          return modernTaskManager.cancel(
            id,
            requestContext?.principalId,
            req.params?.taskId,
          );
        }
        return taskManager.cancel(id, sessionId, req.params?.taskId);
      case "tasks/update":
        if (era === "legacy") return protocolMethodNotFound(id, req.method);
        if (!hasModernTasksCapability(req)) {
          return missingTasksCapability(id);
        }
        return modernTaskManager.update(
          id,
          requestContext?.principalId,
          req.params?.taskId,
          req.params?.inputResponses,
        );
      case "subscriptions/listen":
        if (era === "legacy") return protocolMethodNotFound(id, req.method);
        return subscriptionManager.listen({
          request: req,
          principalId: requestContext?.principalId,
          signal: requestContext?.signal,
          emit: requestContext?.emit,
          tasksExtensionEnabled: hasModernTasksCapability(req),
        });
      case "prompts/list":
        if (era === "legacy") return handlePromptsList(id, prompts);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            ...readRecord(handlePromptsList(id, prompts).result),
            ttlMs: MCP_LIST_TTL_MS,
            cacheScope: "public",
          },
        };
      case "prompts/get":
        return handlePromptsGet(id, req, prompts);
      case "elicitation/response":
        return era === "legacy"
          ? handleElicitationResponse(id, req)
          : protocolMethodNotFound(id, req.method);
      case "ping":
        return era === "legacy"
          ? { jsonrpc: "2.0", id, result: {} }
          : protocolMethodNotFound(id, req.method);
      default:
        if (id !== null && id !== undefined) {
          return completeMcpCallObservation(
            createMcpErrorObservation("protocol_error", startedAt),
            {
              jsonrpc: "2.0",
              id,
              error: {
                code: -32601,
                message: `Method not found: ${req.method}`,
              },
            },
          );
        }
        return undefined;
    }
  }
  const handleRequest: JsonRpcHandler = function handleRequest(
    req: JsonRpcRequest,
    requestContext?: McpRequestContext,
  ): JsonRpcResponse | undefined | Promise<JsonRpcResponse | undefined> {
    const classification = classifyProtocolRequest(req);
    if ("error" in classification) return classification.error;
    const response = dispatchProtocolRequest(
      req,
      requestContext,
      classification.era,
    );
    if (isPromiseLike(response)) {
      return Promise.resolve(response).then((settled) =>
        enforceJsonRpcResultBudget(
          classification.era === "modern"
            ? decorateModernResponse(settled)
            : settled,
        ),
      );
    }
    return enforceJsonRpcResultBudget(
      classification.era === "modern"
        ? decorateModernResponse(response)
        : response,
    );
  };
  handleRequest.closeSession = async (sessionId, reason) => {
    await taskManager.closeSession(sessionId, reason);
    await serializeBrowserCleanup(async () => {
      const agentSessionIds = browserSessionsToEndForTransport(
        browserSessionsByTransport,
        sessionId,
      );
      await endBrowserAgentSessions(agentSessionIds);
      for (const agentSessionId of agentSessionIds) {
        releaseTransportBusNamespace(agentSessionId);
      }
      browserSessionsByTransport.delete(sessionId);
    });
  };
  handleRequest.closeSubscriptions = async () => {
    await subscriptionManager.closeAll();
  };
  handleRequest.closeAll = async (reason) => {
    await subscriptionManager.closeAll();
    await Promise.all([
      taskManager.closeAll(reason),
      modernTaskManager.closeAll(reason),
    ]);
    await serializeBrowserCleanup(async () => {
      const agentSessionIds = new Set(
        [...browserSessionsByTransport.values()].flatMap((sessions) => [
          ...sessions,
        ]),
      );
      await endBrowserAgentSessions([...agentSessionIds]);
      releaseAllTransportBusNamespaces();
      browserSessionsByTransport.clear();
    });
    subscriptionManager.dispose();
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
  toolsByName: ReadonlyMap<string, McpTool>,
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
  return toolsByName.get(canonical);
}

function indexAdvertisedTools(tools: readonly McpTool[]): Map<string, McpTool> {
  const index = new Map<string, McpTool>();
  for (const tool of tools) {
    if (index.has(tool.name)) {
      throw new Error(`Duplicate MCP tool name: ${tool.name}`);
    }
    index.set(tool.name, tool);
  }
  return index;
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
    error: { code: -32602, message: `Tool ${toolName} ${reason}` },
  };
}

function hasModernTasksCapability(request: JsonRpcRequest): boolean {
  const meta = readRecord(request.params?._meta);
  const clientCapabilities = readRecord(
    meta?.["io.modelcontextprotocol/clientCapabilities"],
  );
  const extensions = readRecord(clientCapabilities?.extensions);
  return readRecord(extensions?.[MCP_TASKS_EXTENSION_ID]) !== undefined;
}

function missingTasksCapability(id: JsonRpcResponse["id"]): JsonRpcResponse {
  return jsonRpcError(
    id,
    MCP_TASKS_CAPABILITY_REQUIRED,
    "Missing required client capability",
    {
      requiredCapabilities: {
        extensions: {
          [MCP_TASKS_EXTENSION_ID]: {},
        },
      },
    },
  );
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
