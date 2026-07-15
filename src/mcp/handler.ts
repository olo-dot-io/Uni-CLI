/**
 * @owner       src/mcp/handler.ts
 * @does        Dispatch MCP JSON-RPC methods and run each tool call inside its transport-derived browser invocation scope.
 * @needs       registry/discovery, MCP tools/dispatch/elicitation, browser invocation context/scope, constants
 * @feeds       MCP stdio, simple HTTP, and Streamable HTTP transports
 * @breaks      Invalid methods/arguments return JSON-RPC errors; tool and browser-finalization failures propagate to the owning transport.
 * @invariants  Every tools/call receives one Agent session/turn identity before any browser-capable command runs.
 * @side-effects Executes registered tools, adapters, elicitation resolution, and browser turn finalizers.
 * @perf        Tool lookup is linear in the selected MCP profile; browser scope setup is O(1).
 * @concurrency Async-local browser scopes isolate overlapping tool calls across MCP sessions and turns.
 * @test        tests/unit/mcp/tools.test.ts, tests/unit/mcp-browser-invocation.test.ts
 * @stability   stable
 * @since       2026-04-01
 */

import { getAllAdapters, listCommands, resolveCommand } from "../registry.js";
import { listCoreDiscoveryCommands } from "../discovery/core-catalog.js";
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
} from "../browser/invocation-scope.js";
import type {
  JsonRpcHandler,
  JsonRpcRequest,
  JsonRpcResponse,
  McpRequestContext,
} from "./jsonrpc.js";

export type { JsonRpcRequest, JsonRpcResponse };

function handleListAdapters(params: Record<string, unknown>): McpToolResult {
  let commands = [
    ...listCommands(),
    ...listCoreDiscoveryCommands().map((command) => ({
      site: command.site,
      command: command.command,
      description: command.description,
      category: command.category,
      type: command.type,
      auth: false,
      quarantined: false,
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
      commands: Array<{ name: string; description: string }>;
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
    entry.commands.push({ name: cmd.command, description: cmd.description });
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

  return runResolvedCommand(resolved.adapter, resolved.command, command, args);
}

/**
 * Expanded-tool dispatcher — look up `unicli_<site>_<command>` in the
 * registry populated by buildExpandedTools / buildDeferredTools.
 */
async function handleExpandedTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpToolResult | undefined> {
  if (!toolName.startsWith("unicli_")) return undefined;
  const entry = expandedRegistry.get(toolName);
  if (!entry) return undefined;
  return runResolvedCommand(
    entry.adapter,
    entry.cmd,
    entry.cmdName,
    expandedToolArgs(args),
  );
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
): Promise<JsonRpcResponse | undefined> {
  switch (name) {
    case "unicli_list":
    case "list_adapters": {
      const result = handleListAdapters(toolArgs);
      return { jsonrpc: "2.0", id, result: annotateIfLarge(result) };
    }
    case "unicli_run":
    case "run_command": {
      const result = await handleRunCommand(toolArgs);
      return { jsonrpc: "2.0", id, result: annotateIfLarge(result) };
    }
    case "unicli_search":
      return dispatchSearch(id, toolArgs);
    case "unicli_explore":
    case "unicli_discover":
      return dispatchExplore(id, toolArgs);
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
    results: results.map((r) => ({
      command: `unicli ${r.site} ${r.command}`,
      site: r.site,
      name: r.command,
      description: r.description,
      score: r.score,
      category: r.category,
      usage: r.usage,
    })),
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
  const [{ execFile: ef }, { promisify: prom }] = await Promise.all([
    import("node:child_process"),
    import("node:util"),
  ]);
  const execFileP = prom(ef);
  const discoverArgs = ["generate", discoverUrl, "--json"];
  if (discoverGoal) discoverArgs.push("--goal", discoverGoal);
  try {
    const { stdout } = await execFileP("unicli", discoverArgs, {
      timeout: 120_000,
      encoding: "utf-8",
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
    return {
      jsonrpc: "2.0",
      id,
      result: annotateIfLarge({
        content: [{ type: "text", text: JSON.stringify({ error: message }) }],
        isError: true,
      }),
    };
  }
}

async function handleToolsCall(
  id: JsonRpcResponse["id"],
  req: JsonRpcRequest,
  tools: McpTool[],
  requestContext?: McpRequestContext,
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
  const scope = createBrowserInvocationScope({
    context: invocationContext,
    profilePartitionId: "default",
  });
  return runBrowserInvocation(scope, async () => {
    const toolArgs = params.arguments ?? {};
    const directTool = tools.find((tool) => tool.name === params.name);
    if (directTool?.handler) {
      const result = await directTool.handler(toolArgs);
      return { jsonrpc: "2.0", id, result: annotateIfLarge(result) };
    }
    const builtin = await dispatchBuiltin(id, params.name, toolArgs);
    if (builtin) return builtin;
    const result = await handleExpandedTool(params.name, toolArgs);
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
): JsonRpcHandler {
  return function handleRequest(
    req: JsonRpcRequest,
    requestContext?: McpRequestContext,
  ): JsonRpcResponse | undefined | Promise<JsonRpcResponse | undefined> {
    const id = req.id ?? null;

    switch (req.method) {
      case "initialize":
        return initializeResponse(id, prompts);
      case "notifications/initialized":
        // Notifications have no response — transports already guard `if (response)`.
        return undefined;
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools } };
      case "tools/call":
        return handleToolsCall(id, req, tools, requestContext);
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
}
