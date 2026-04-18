/**
 * MCP JSON-RPC dispatch — `buildHandler(tools)` returns the per-request
 * handler used by every transport (stdio, HTTP, Streamable HTTP).
 *
 * Extracted from `server.ts` so the top-level file only owns bootstrap,
 * arg parsing, and transport wiring. This module owns:
 *   - `initialize` / `ping` / `tools/list` / `tools/call` method dispatch
 *   - The four built-in meta-tools (`unicli_list` / `unicli_run` /
 *     `unicli_search` / `unicli_explore` + deprecated aliases)
 *   - Fallthrough to expanded-tool dispatch via `./dispatch.ts`
 */

import { getAllAdapters, listCommands, resolveCommand } from "../registry.js";
import {
  annotateIfLarge,
  runResolvedCommand,
  type McpToolResult,
} from "./dispatch.js";
import { expandedRegistry, type McpTool } from "./tools.js";
import { MCP_PROTOCOL_VERSION, VERSION } from "../constants.js";
import { resolveElicitation, type ElicitationResponse } from "./elicitation.js";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function handleListAdapters(params: Record<string, unknown>): McpToolResult {
  let commands = listCommands();

  const site = params.site as string | undefined;
  const type = params.type as string | undefined;

  if (site) commands = commands.filter((c) => c.site.includes(site));
  if (type) commands = commands.filter((c) => c.type === type);

  const adapters = getAllAdapters();
  const siteMap = new Map<
    string,
    { type: string; commands: Array<{ name: string; description: string }> }
  >();

  for (const cmd of commands) {
    let entry = siteMap.get(cmd.site);
    if (!entry) {
      const adapter = adapters.find((a) => a.name === cmd.site);
      entry = { type: adapter?.type ?? cmd.type, commands: [] };
      siteMap.set(cmd.site, entry);
    }
    entry.commands.push({ name: cmd.command, description: cmd.description });
  }

  const result = Array.from(siteMap.entries()).map(([name, info]) => ({
    site: name,
    type: info.type,
    commands: info.commands,
  }));

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
  return runResolvedCommand(entry.adapter, entry.cmd, entry.cmdName, args);
}

function initializeResponse(id: JsonRpcResponse["id"]): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: false },
        elicitation: { supported: true },
      },
      serverInfo: { name: "unicli", version: VERSION },
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
  if (!searchQuery) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: "Missing required parameter: query" },
    };
  }
  const { search: searchFn } = await import("../discovery/search.js");
  const results = searchFn(searchQuery, searchLimit);
  const data = {
    query: searchQuery,
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
  const toolArgs = params.arguments ?? {};

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
): (req: JsonRpcRequest) => JsonRpcResponse | Promise<JsonRpcResponse> {
  return function handleRequest(
    req: JsonRpcRequest,
  ): JsonRpcResponse | Promise<JsonRpcResponse> {
    const id = req.id ?? null;

    switch (req.method) {
      case "initialize":
        return initializeResponse(id);
      case "notifications/initialized":
        // Sentinel — transports check for null/undefined and suppress.
        return null as unknown as JsonRpcResponse;
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools } };
      case "tools/call":
        return handleToolsCall(id, req);
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
        return null as unknown as JsonRpcResponse;
    }
  };
}
