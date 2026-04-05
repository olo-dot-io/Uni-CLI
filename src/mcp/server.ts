#!/usr/bin/env node

/**
 * MCP (Model Context Protocol) stdio server for Uni-CLI.
 *
 * Lazy tool registration strategy:
 *   - At startup, only two tools are registered: list_adapters + run_command
 *   - run_command takes site + command as params, resolves the adapter dynamically
 *   - This avoids registering 600+ tools upfront, keeping MCP handshake fast
 *
 * Protocol: JSON-RPC 2.0 over stdio (newline-delimited JSON)
 */

import { createInterface } from "node:readline";
import { loadAllAdapters, loadTsAdapters } from "../discovery/loader.js";
import { getAllAdapters, listCommands, resolveCommand } from "../registry.js";
import { runPipeline } from "../engine/yaml-runner.js";
import { VERSION } from "../constants.js";

// ── JSON-RPC Types ──────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ── MCP Tool Schema ─────────────────────────────────────────────────────────

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// ── Tool Definitions ────────────────────────────────────────────────────────

function buildCoreTools(): McpTool[] {
  return [
    {
      name: "list_adapters",
      description:
        "List all available Uni-CLI adapters and their commands. " +
        "Use this to discover what sites and commands are available before calling run_command.",
      inputSchema: {
        type: "object",
        properties: {
          site: {
            type: "string",
            description: "Filter by site name (optional, partial match)",
          },
          type: {
            type: "string",
            description:
              "Filter by adapter type: web-api, desktop, browser, bridge, service",
            enum: ["web-api", "desktop", "browser", "bridge", "service"],
          },
        },
      },
    },
    {
      name: "run_command",
      description:
        "Execute a Uni-CLI adapter command. Equivalent to running `unicli <site> <command>` on the CLI. " +
        "Returns JSON results. Use list_adapters first to discover available commands.",
      inputSchema: {
        type: "object",
        properties: {
          site: {
            type: "string",
            description:
              "The adapter site name (e.g. hackernews, github, bilibili)",
          },
          command: {
            type: "string",
            description: "The command to run (e.g. top, search, hot)",
          },
          args: {
            type: "object",
            description:
              'Command arguments as key-value pairs (e.g. {"query": "ai", "limit": 10})',
            additionalProperties: true,
          },
        },
        required: ["site", "command"],
      },
    },
  ];
}

// ── Tool Handlers ───────────────────────────────────────────────────────────

function handleListAdapters(params: Record<string, unknown>): McpToolResult {
  let commands = listCommands();

  const site = params.site as string | undefined;
  const type = params.type as string | undefined;

  if (site) {
    commands = commands.filter((c) => c.site.includes(site));
  }
  if (type) {
    commands = commands.filter((c) => c.type === type);
  }

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

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            total_sites: result.length,
            total_commands: commands.length,
            adapters: result,
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function handleRunCommand(
  params: Record<string, unknown>,
): Promise<McpToolResult> {
  const site = params.site as string;
  const command = params.command as string;
  const args = (params.args as Record<string, unknown>) ?? {};

  if (!site || !command) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: "site and command are required" }),
        },
      ],
      isError: true,
    };
  }

  const resolved = resolveCommand(site, command);
  if (!resolved) {
    // Provide helpful suggestion
    const adapters = getAllAdapters();
    const matchingSites = adapters
      .filter((a) => a.name.includes(site))
      .map((a) => ({
        site: a.name,
        commands: Object.keys(a.commands),
      }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: `Unknown command: ${site} ${command}`,
              suggestion:
                matchingSites.length > 0
                  ? `Did you mean one of these? ${JSON.stringify(matchingSites)}`
                  : "Use list_adapters to see all available commands.",
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

  const { adapter, command: cmd } = resolved;

  // Merge default args
  const mergedArgs: Record<string, unknown> = { limit: 20, ...args };
  if (args.limit !== undefined) {
    mergedArgs.limit =
      typeof args.limit === "number"
        ? args.limit
        : parseInt(String(args.limit), 10) || 20;
  }

  try {
    let results: unknown[];

    if (cmd.pipeline) {
      results = await runPipeline(cmd.pipeline, mergedArgs, adapter.base, {
        site: adapter.name,
        strategy: adapter.strategy,
      });
    } else if (cmd.func) {
      const raw = await cmd.func(null as never, mergedArgs);
      results = Array.isArray(raw) ? raw : [raw];
    } else {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "No pipeline or function defined for this command",
            }),
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ count: results.length, results }, null, 2),
        },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: message,
              adapter_path: `src/adapters/${adapter.name}/${command}.yaml`,
              suggestion: "The adapter may need updating. Check the YAML file.",
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }
}

// ── MCP Protocol Handler ────────────────────────────────────────────────────

const PROTOCOL_VERSION = "2024-11-05";

const tools = buildCoreTools();

function handleRequest(
  req: JsonRpcRequest,
): JsonRpcResponse | Promise<JsonRpcResponse> {
  const id = req.id ?? null;

  switch (req.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "unicli",
            version: VERSION,
          },
        },
      };

    case "notifications/initialized":
      // Client acknowledgement — no response needed for notifications
      return null as unknown as JsonRpcResponse;

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: { tools },
      };

    case "tools/call": {
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

      switch (params.name) {
        case "list_adapters": {
          const result = handleListAdapters(toolArgs);
          return { jsonrpc: "2.0", id, result };
        }
        case "run_command":
          return handleRunCommand(toolArgs).then((result) => ({
            jsonrpc: "2.0",
            id,
            result,
          }));
        default:
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: `Unknown tool: ${params.name}. Available tools: ${tools.map((t) => t.name).join(", ")}`,
            },
          };
      }
    }

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    default:
      // Unknown method — return error for requests (has id), ignore notifications
      if (id !== null && id !== undefined) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${req.method}` },
        };
      }
      return null as unknown as JsonRpcResponse;
  }
}

// ── Stdio Transport ─────────────────────────────────────────────────────────

function send(response: JsonRpcResponse): void {
  const json = JSON.stringify(response);
  process.stdout.write(json + "\n");
}

async function main(): Promise<void> {
  // Load adapters (same as CLI)
  loadAllAdapters();
  await loadTsAdapters();

  const rl = createInterface({
    input: process.stdin,
    terminal: false,
  });

  rl.on("line", async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }

    try {
      const response = await handleRequest(req);
      if (response) {
        send(response);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send({
        jsonrpc: "2.0",
        id: req.id ?? null,
        error: { code: -32603, message: `Internal error: ${message}` },
      });
    }
  });

  rl.on("close", () => {
    process.exit(0);
  });

  // Log to stderr so it doesn't interfere with JSON-RPC on stdout
  const adapterCount = getAllAdapters().length;
  const commandCount = listCommands().length;
  process.stderr.write(
    `unicli MCP server v${VERSION} — ${adapterCount} sites, ${commandCount} commands (2 tools registered)\n`,
  );
}

main().catch((err) => {
  process.stderr.write(
    `Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
