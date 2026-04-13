#!/usr/bin/env node

/**
 * MCP (Model Context Protocol) server for Uni-CLI.
 *
 * Two registration modes:
 *   1. **Smart default** — 3 tools: `unicli_run`, `unicli_list`,
 *      `unicli_discover`. Keeps the MCP handshake under 200 tokens.
 *   2. **Expanded (`--expanded`)** — one tool per adapter command
 *      (`unicli_<site>_<command>`) with JSON Schema derived from `args` +
 *      `columns`. MCP clients see the full Uni-CLI surface area.
 *
 * Three transports:
 *   - **stdio (default)** — newline-delimited JSON over stdin/stdout
 *   - **http (`--transport http [--port 19826]`)** — POST /mcp accepts a
 *     single JSON-RPC envelope and returns a single JSON response.
 *   - **sse (`--transport sse [--port 19826]`)** — Streamable HTTP with
 *     Server-Sent Events. GET /mcp/sse opens the event stream, POST
 *     /mcp/message?sessionId=xxx delivers JSON-RPC requests.
 *
 * Auth pass-through is automatic: every adapter the CLI loads (including
 * cookie-based ones) is exposed by name; the runtime resolves cookies on
 * each call via the same code path as the CLI.
 */

import { createInterface } from "node:readline";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { loadAllAdapters, loadTsAdapters } from "../discovery/loader.js";
import { getAllAdapters, listCommands, resolveCommand } from "../registry.js";
import { runPipeline } from "../engine/yaml-runner.js";
import { VERSION, MCP_PROTOCOL_VERSION } from "../constants.js";
// sse-transport.ts is deprecated (spec 2025-03-26). Kept for backwards compatibility.
// import { startSseServer } from "./sse-transport.js";
import { startStreamableHttp } from "./streamable-http.js";
import { handleOAuthRoute, createOAuthMiddleware } from "./oauth.js";
import {
  type JsonSchemaObject,
  buildInputSchema,
  buildOutputSchema,
  buildToolName,
  truncateDescription,
} from "./schema.js";
import { resolveElicitation, type ElicitationResponse } from "./elicitation.js";
import type { AdapterManifest, AdapterCommand } from "../types.js";

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

// ── MCP Tool Schema (shared types from ./schema.ts) ─────────────────────────

interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
  outputSchema?: JsonSchemaObject;
  _meta?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

interface McpStructuredContent {
  type: "json";
  data: unknown;
}

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: McpStructuredContent;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

// ── Smart default tools (4 meta-tools — the default mode) ─────────────────

const MAX_RESULT_SIZE_CHARS = 10_000;

function buildDefaultTools(): McpTool[] {
  return [
    {
      name: "unicli_run",
      description: "Execute any Uni-CLI command. Returns JSON results.",
      inputSchema: {
        type: "object",
        properties: {
          site: {
            type: "string",
            description: "Site name (e.g. hackernews, github, bilibili)",
          },
          command: {
            type: "string",
            description: "Command to run (e.g. top, search, hot)",
          },
          args: {
            type: "object",
            description:
              'Key-value arguments (e.g. {"query": "ai", "limit": 10})',
            additionalProperties: true,
          },
        },
        required: ["site", "command"],
      },
      _meta: {
        "anthropic/searchHint":
          "Execute CLI commands on 200+ websites and desktop apps. Run adapters by site and command name.",
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    {
      name: "unicli_list",
      description: "List available commands. Filter by site or adapter type.",
      inputSchema: {
        type: "object",
        properties: {
          site: {
            type: "string",
            description: "Filter by site name (partial match)",
          },
          type: {
            type: "string",
            description: "Filter by adapter type",
            enum: ["web-api", "desktop", "browser", "bridge", "service"],
          },
        },
      },
      _meta: {
        "anthropic/searchHint":
          "Browse available Uni-CLI sites and commands. Filter by site name or adapter type.",
        "anthropic/alwaysLoad": true,
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: "unicli_search",
      description:
        "Search 200+ sites and 956 commands by intent. Bilingual (EN/ZH). Returns top matches with usage examples.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Natural language intent (e.g. 'download video', '推特热门', 'stock price')",
          },
          limit: {
            type: "integer",
            description: "Max results (default 5)",
            default: 5,
          },
        },
        required: ["query"],
      },
      _meta: {
        "anthropic/searchHint":
          "Find CLI commands by intent. Semantic search across websites, desktop apps, macOS. Bilingual Chinese/English.",
        "anthropic/alwaysLoad": true,
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: "unicli_explore",
      description:
        "Auto-discover API endpoints for any URL. Navigates the page, captures network requests, generates YAML adapters.",
      inputSchema: {
        type: "object" as const,
        properties: {
          url: { type: "string", description: "Website URL to explore" },
          goal: {
            type: "string",
            description: "Capability to find (e.g. 'search', 'hot', 'feed')",
          },
        },
        required: ["url"],
      },
      _meta: {
        "anthropic/searchHint":
          "Auto-discover API endpoints for any website URL. Generate YAML adapters for new sites.",
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
  ];
}

// ── Expanded-mode: one tool per adapter command ─────────────────────────────
// Schema builders (buildInputSchema, buildOutputSchema, buildToolName) are
// imported from ./schema.ts — single source of truth.

/**
 * Reverse-lookup registry for expanded-mode tool calls. Maps the normalized
 * tool name to the resolved adapter + original command name, so dispatch
 * does not depend on whether `buildToolName` is invertible. Populated by
 * `buildExpandedTools` and queried by `handleExpandedTool`.
 */
interface ExpandedEntry {
  adapter: AdapterManifest;
  cmdName: string;
  cmd: AdapterCommand;
}
const expandedRegistry = new Map<string, ExpandedEntry>();

/**
 * Build the expanded tool set: 4 default meta-tools + one full tool per
 * adapter command. Clients see the complete Uni-CLI surface area.
 *
 * Token cost: ~160K for 956 commands. Use only when the client can handle it.
 */
function buildExpandedTools(): McpTool[] {
  const tools: McpTool[] = [];
  tools.push(...buildDefaultTools());

  expandedRegistry.clear();
  const seen = new Set<string>(DEFAULT_TOOL_NAMES);

  for (const adapter of getAllAdapters()) {
    for (const [cmdName, cmd] of Object.entries(adapter.commands)) {
      const rawDesc =
        cmd.description?.trim() ||
        adapter.description?.trim() ||
        `${cmdName} for ${adapter.name}`;
      const toolName = buildToolName(adapter.name, cmdName);
      if (seen.has(toolName)) {
        process.stderr.write(
          `unicli MCP: tool name collision: ${toolName} — shadowing ${adapter.name}/${cmdName}\n`,
        );
        continue;
      }
      seen.add(toolName);
      expandedRegistry.set(toolName, { adapter, cmdName, cmd });
      tools.push({
        name: toolName,
        description: truncateDescription(`[${adapter.name}] ${rawDesc}`),
        inputSchema: buildInputSchema(cmd),
        outputSchema: buildOutputSchema(cmd),
        _meta: {
          "anthropic/searchHint": `${adapter.name}: ${rawDesc}`,
        },
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      });
    }
  }

  return tools;
}

/**
 * Build deferred tool set: 4 default meta-tools with full schemas, plus
 * lightweight stubs for all adapter commands (name + searchHint only,
 * minimal inputSchema). Clients like Claude Code's ToolSearch can discover
 * tools by searchHint and then call them — the handler resolves the full
 * command at call time via the expandedRegistry.
 *
 * Token cost: ~8K (vs ~160K for expanded). 95% reduction.
 */
function buildDeferredTools(): McpTool[] {
  const tools: McpTool[] = [];
  tools.push(...buildDefaultTools());

  expandedRegistry.clear();
  const seen = new Set<string>(DEFAULT_TOOL_NAMES);

  for (const adapter of getAllAdapters()) {
    for (const [cmdName, cmd] of Object.entries(adapter.commands)) {
      const rawDesc =
        cmd.description?.trim() ||
        adapter.description?.trim() ||
        `${cmdName} for ${adapter.name}`;
      const toolName = buildToolName(adapter.name, cmdName);
      if (seen.has(toolName)) continue;
      seen.add(toolName);

      // Register in the lookup table for runtime dispatch
      expandedRegistry.set(toolName, { adapter, cmdName, cmd });

      // Lightweight stub: name + searchHint + minimal schema.
      // Full inputSchema is resolved at call time via expandedRegistry.
      tools.push({
        name: toolName,
        description: truncateDescription(`[${adapter.name}] ${rawDesc}`),
        inputSchema: {
          type: "object",
          properties: {
            _args: {
              type: "object",
              description: "Command arguments (pass key-value pairs)",
              additionalProperties: true,
            },
          },
        },
        _meta: {
          "anthropic/searchHint": `${adapter.name}: ${rawDesc}`,
        },
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      });
    }
  }

  return tools;
}

const DEFAULT_TOOL_NAMES = new Set([
  "unicli_run",
  "unicli_list",
  "unicli_search",
  "unicli_explore",
  "unicli_discover",
]);

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

async function runResolvedCommand(
  adapter: AdapterManifest,
  cmd: AdapterCommand,
  cmdName: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
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
      const errorData = {
        error: "No pipeline or function defined for this command",
      };
      return {
        content: [{ type: "text", text: JSON.stringify(errorData) }],
        structuredContent: { type: "json", data: errorData },
        isError: true,
      };
    }

    const data = { count: results.length, results };
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      structuredContent: { type: "json", data },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errorData = {
      error: message,
      adapter_path: `src/adapters/${adapter.name}/${cmdName}.yaml`,
      suggestion: "The adapter may need updating. Check the YAML file.",
    };
    return {
      content: [{ type: "text", text: JSON.stringify(errorData, null, 2) }],
      structuredContent: { type: "json", data: errorData },
      isError: true,
    };
  }
}

/**
 * Annotate a tool result with `_meta.anthropic/maxResultSizeChars` when the
 * serialized payload exceeds MAX_RESULT_SIZE_CHARS (10 KB). This tells
 * Claude Code to accept large payloads without truncation.
 */
export function annotateIfLarge(result: McpToolResult): McpToolResult {
  const totalChars = result.content.reduce((sum, c) => sum + c.text.length, 0);
  if (totalChars > MAX_RESULT_SIZE_CHARS) {
    return {
      ...result,
      _meta: { "anthropic/maxResultSizeChars": 100_000 },
    };
  }
  return result;
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
 * Expanded-tool dispatcher — parse `unicli_<site>_<command>` back to its
 * components and call the resolver. Returns `undefined` when the tool name
 * is not in expanded form, so the caller can fall through to default-tool
 * handling (list_adapters / run_command).
 */
async function handleExpandedTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpToolResult | undefined> {
  if (!toolName.startsWith("unicli_")) return undefined;

  // Dictionary lookup into the expansion registry built by
  // `buildExpandedTools`. This is the ONLY correct way to map a normalized
  // tool name back to its adapter + command because the normalization
  // (`s/[^a-zA-Z0-9_]/_/g`) is not reversible — a command file named
  // `capture-list.yaml` and another named `capture_list.yaml` would map
  // to the same tool name. The registry resolves the ambiguity deterministically
  // (first-write-wins, collisions logged to stderr in `buildExpandedTools`).
  const entry = expandedRegistry.get(toolName);
  if (!entry) return undefined;
  return runResolvedCommand(entry.adapter, entry.cmd, entry.cmdName, args);
}

// ── MCP Protocol Handler ────────────────────────────────────────────────────

// Protocol version imported from src/constants.ts (single source of truth)
const PROTOCOL_VERSION = MCP_PROTOCOL_VERSION;

interface ServerOptions {
  expanded: boolean;
  transport: "stdio" | "http" | "streamable";
  port: number;
  auth: boolean;
}

function parseArgs(argv: string[]): ServerOptions {
  const opts: ServerOptions = {
    expanded: false,
    transport: "stdio",
    port: 19826,
    auth: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--expanded") opts.expanded = true;
    else if (a === "--auth") opts.auth = true;
    else if (a === "--transport") {
      const v = argv[++i];
      if (v === "stdio" || v === "http" || v === "streamable") {
        opts.transport = v;
      } else if (v === "sse") {
        // Deprecated alias — SSE replaced by Streamable HTTP in spec 2025-03-26
        opts.transport = "streamable";
      }
    } else if (a === "--port") {
      const v = parseInt(argv[++i], 10);
      if (Number.isFinite(v)) opts.port = v;
    }
  }
  return opts;
}

function buildHandler(
  tools: McpTool[],
): (req: JsonRpcRequest) => JsonRpcResponse | Promise<JsonRpcResponse> {
  return function handleRequest(
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
              tools: { listChanged: false },
              elicitation: { supported: true },
            },
            serverInfo: {
              name: "unicli",
              version: VERSION,
            },
          },
        };

      case "notifications/initialized":
        // JSON-RPC notifications must not receive responses.
        // Returning a sentinel that transports check before serializing.
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
          // Support both old names (list_adapters, run_command) and new
          // names (unicli_list, unicli_run) for backwards compatibility.
          case "unicli_list":
          case "list_adapters": {
            const result = handleListAdapters(toolArgs);
            return { jsonrpc: "2.0", id, result: annotateIfLarge(result) };
          }
          case "unicli_run":
          case "run_command":
            return handleRunCommand(toolArgs).then((result) => ({
              jsonrpc: "2.0",
              id,
              result: annotateIfLarge(result),
            }));
          case "unicli_search": {
            const searchQuery = toolArgs.query as string;
            const searchLimit = (toolArgs.limit as number) || 5;
            if (!searchQuery) {
              return {
                jsonrpc: "2.0",
                id,
                error: {
                  code: -32602,
                  message: "Missing required parameter: query",
                },
              };
            }
            return import("../discovery/search.js").then(
              ({ search: searchFn }) => {
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
                  jsonrpc: "2.0" as const,
                  id,
                  result: annotateIfLarge({
                    content: [
                      {
                        type: "text" as const,
                        text: JSON.stringify(data, null, 2),
                      },
                    ],
                    structuredContent: { type: "json" as const, data },
                  }),
                };
              },
            );
          }
          case "unicli_explore":
          case "unicli_discover": {
            // unicli_explore is the canonical name (v0.211.1+).
            // unicli_discover kept as alias for backwards compatibility.
            const discoverUrl = toolArgs.url as string;
            const discoverGoal = toolArgs.goal as string | undefined;
            if (!discoverUrl) {
              return {
                jsonrpc: "2.0",
                id,
                error: {
                  code: -32602,
                  message: "Missing required parameter: url",
                },
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
            return import("node:child_process").then(({ execFile: ef }) =>
              import("node:util").then(({ promisify: prom }) => {
                const execFileP = prom(ef);
                const discoverArgs = ["generate", discoverUrl, "--json"];
                if (discoverGoal) discoverArgs.push("--goal", discoverGoal);
                return execFileP("unicli", discoverArgs, {
                  timeout: 120_000,
                  encoding: "utf-8",
                }).then(
                  ({ stdout }) => ({
                    jsonrpc: "2.0" as const,
                    id,
                    result: annotateIfLarge({
                      content: [{ type: "text" as const, text: stdout }],
                    }),
                  }),
                  (err: unknown) => ({
                    jsonrpc: "2.0" as const,
                    id,
                    result: annotateIfLarge({
                      content: [
                        {
                          type: "text" as const,
                          text: JSON.stringify({
                            error:
                              err instanceof Error ? err.message : String(err),
                          }),
                        },
                      ],
                      isError: true,
                    }),
                  }),
                );
              }),
            );
          }
          default:
            return handleExpandedTool(params.name, toolArgs).then((result) => {
              if (result)
                return { jsonrpc: "2.0", id, result: annotateIfLarge(result) };
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
      }

      case "elicitation/response": {
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
        const resolved = resolveElicitation(
          elicitParams.id,
          elicitParams.response,
        );
        return {
          jsonrpc: "2.0",
          id,
          result: { resolved },
        };
      }

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

// ── Stdio Transport ─────────────────────────────────────────────────────────

function send(response: JsonRpcResponse): void {
  const json = JSON.stringify(response);
  process.stdout.write(json + "\n");
}

async function startStdio(
  handler: ReturnType<typeof buildHandler>,
): Promise<void> {
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
      const response = await handler(req);
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
}

// ── HTTP Transport ──────────────────────────────────────────────────────────

/**
 * Simple JSON-RPC over HTTP. POST /mcp accepts a single JSON-RPC envelope and
 * returns a single JSON response. GET /mcp returns server info — handy for
 * a health check from a browser.
 *
 * Note: this is intentionally NOT a full MCP Streamable HTTP transport —
 * no SSE event stream, no session resume. Most clients that "speak HTTP"
 * to MCP only need request/response, and starting with the simpler shape
 * means zero new dependencies and a tiny attack surface.
 */
async function startHttp(
  handler: ReturnType<typeof buildHandler>,
  port: number,
  authEnabled = false,
): Promise<void> {
  const oauthMiddleware = authEnabled ? createOAuthMiddleware() : null;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // OAuth routes (authorize + token) — always public
    if (authEnabled && handleOAuthRoute(req, res)) return;

    // Health endpoint — always public
    if (
      req.method === "GET" &&
      (req.url === "/" || req.url === "/mcp" || req.url === "/health")
    ) {
      res.writeHead(200, { "Content-Type": "application/json" });
      const adapterCount = getAllAdapters().length;
      const commandCount = listCommands().length;
      // Compute actual expanded tool count: 3 default tools + all adapter commands.
      let expandedCount = 3; // default tools
      for (const adapter of getAllAdapters()) {
        expandedCount += Object.keys(adapter.commands).length;
      }
      res.end(
        JSON.stringify({
          status: "ok",
          adapters: adapterCount,
          commands: commandCount,
          tools: { default: 3, expanded: expandedCount },
          version: VERSION,
        }),
      );
      return;
    }
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "POST /mcp" }));
      return;
    }

    // OAuth middleware — block unauthenticated requests when --auth is set
    if (oauthMiddleware?.(req, res)) return;

    const MAX_BODY = 1_048_576; // 1 MB
    const chunks: Buffer[] = [];
    let bodySize = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY) {
        aborted = true;
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32600, message: "Request too large" },
          }),
        );
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", async () => {
      if (aborted) return;
      const body = Buffer.concat(chunks).toString("utf-8");
      let parsed: JsonRpcRequest;
      try {
        parsed = JSON.parse(body) as JsonRpcRequest;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          }),
        );
        return;
      }
      try {
        const response = await handler(parsed);
        if (!response) {
          // JSON-RPC notification — no response expected
          res.writeHead(204);
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id ?? null,
            error: { code: -32603, message: `Internal error: ${message}` },
          }),
        );
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  process.stderr.write(
    `unicli MCP server v${VERSION} — HTTP transport on http://127.0.0.1:${port}/mcp\n`,
  );
}

// ── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  // Load adapters (same as CLI)
  loadAllAdapters();
  await loadTsAdapters();

  // Three modes:
  //   default  → 4 meta-tools (~200 tokens)
  //   expanded → 4 meta-tools + 956 full tool schemas (~160K tokens)
  //   deferred → 4 meta-tools + 956 lightweight stubs (~8K tokens)
  const mode = opts.expanded ? "expanded" : "default";
  const tools = opts.expanded ? buildExpandedTools() : buildDefaultTools();
  // Deferred mode is auto-activated for Streamable HTTP transport (remote
  // clients benefit most from searchHint-based discovery).
  // For explicit control, the expanded flag takes precedence.
  if (opts.transport === "streamable" && !opts.expanded) {
    const deferredTools = buildDeferredTools();
    tools.length = 0;
    tools.push(...deferredTools);
  }
  const handler = buildHandler(tools);

  const adapterCount = getAllAdapters().length;
  const commandCount = listCommands().length;

  if (opts.transport === "http") {
    await startHttp(handler, opts.port, opts.auth);
    const authLabel = opts.auth ? ", OAuth enabled" : "";
    process.stderr.write(
      `unicli MCP server v${VERSION} — ${adapterCount} sites, ${commandCount} commands (${tools.length} tools registered, mode=${mode}${authLabel})\n`,
    );
    return;
  }

  if (opts.transport === "streamable") {
    await startStreamableHttp(opts.port, handler, { auth: opts.auth });
    const authLabel = opts.auth ? ", OAuth enabled" : "";
    process.stderr.write(
      `unicli MCP server v${VERSION} — ${adapterCount} sites, ${commandCount} commands (${tools.length} tools, mode=${mode}, transport=streamable${authLabel})\n`,
    );
    return;
  }

  // stdio (default)
  await startStdio(handler);
  process.stderr.write(
    `unicli MCP server v${VERSION} — ${adapterCount} sites, ${commandCount} commands (${tools.length} tools registered, mode=${mode})\n`,
  );
}

main().catch((err) => {
  process.stderr.write(
    `Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
