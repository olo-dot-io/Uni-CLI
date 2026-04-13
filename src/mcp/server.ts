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
 * Two transports:
 *   - **stdio (default)** — newline-delimited JSON over stdin/stdout
 *   - **http (`--transport http [--port 19826]`)** — POST /mcp accepts a
 *     single JSON-RPC envelope and returns a single JSON response. No
 *     SSE streaming yet — additive in a future release.
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
import { VERSION } from "../constants.js";
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

// ── MCP Tool Schema ─────────────────────────────────────────────────────────

interface JsonSchemaProperty {
  type: string;
  description?: string;
  default?: unknown;
  enum?: string[];
  /** For object-typed properties — allows nested run_command-style payloads. */
  additionalProperties?: boolean;
  /** For array-typed properties. */
  items?: JsonSchemaProperty;
}

interface JsonSchemaObject {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
  outputSchema?: JsonSchemaObject;
}

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

// ── Smart default tools (3 tools — the default mode) ────────────────────────

/**
 * Approximate token count for a string. Uses the heuristic `words * 1.3`
 * which closely tracks tiktoken cl100k for English + mixed-case identifiers.
 */
function approxTokens(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.3);
}

/**
 * Truncate a description to fit within a token budget. Cuts at word boundary
 * and appends "…" when truncation occurs.
 */
export function truncateDescription(desc: string, maxTokens = 68): string {
  if (approxTokens(desc) <= maxTokens) return desc;
  const words = desc.split(/\s+/).filter(Boolean);
  let result = "";
  for (const word of words) {
    const candidate = result ? `${result} ${word}` : word;
    if (approxTokens(candidate + " …") > maxTokens) break;
    result = candidate;
  }
  return result ? `${result} …` : words[0] + " …";
}

const MAX_RESULT_SIZE_CHARS = 10_000;

function buildDefaultTools(): McpTool[] {
  return [
    {
      name: "unicli_run",
      description:
        "Execute any Uni-CLI command. Returns JSON results.",
      inputSchema: {
        type: "object",
        properties: {
          site: {
            type: "string",
            description:
              "Site name (e.g. hackernews, github, bilibili)",
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
    },
    {
      name: "unicli_list",
      description:
        "List available commands. Filter by site or adapter type.",
      inputSchema: {
        type: "object",
        properties: {
          site: {
            type: "string",
            description: "Filter by site name (partial match)",
          },
          type: {
            type: "string",
            description:
              "Filter by adapter type",
            enum: ["web-api", "desktop", "browser", "bridge", "service"],
          },
        },
      },
    },
    {
      name: "unicli_discover",
      description:
        "Auto-discover CLI capabilities for any URL. Navigates the page, captures API endpoints, generates adapters.",
      inputSchema: {
        type: "object" as const,
        properties: {
          url: { type: "string", description: "Website URL to explore" },
          goal: {
            type: "string",
            description:
              "Capability to find (e.g. 'search', 'hot', 'feed')",
          },
        },
        required: ["url"],
      },
    },
  ];
}

// ── Expanded-mode: one tool per adapter command ─────────────────────────────

/**
 * Map an adapter `arg.type` to a JSON Schema primitive. Defaults to "string"
 * for unknown / missing types — safer than failing the schema build.
 */
function jsonTypeFor(t: string | undefined): string {
  switch (t) {
    case "int":
      return "integer";
    case "float":
      return "number";
    case "bool":
      return "boolean";
    case "str":
    default:
      return "string";
  }
}

/**
 * Build the input JSON Schema for one adapter command from its `args`.
 */
function buildInputSchema(cmd: AdapterCommand): JsonSchemaObject {
  const props: Record<string, JsonSchemaProperty> = {
    limit: {
      type: "integer",
      description: "Cap result count (default 20)",
      default: 20,
    },
  };
  const required: string[] = [];

  for (const a of cmd.adapterArgs ?? []) {
    if (a.name === "limit") continue; // already added
    const prop: JsonSchemaProperty = {
      type: jsonTypeFor(a.type),
      description: a.description,
    };
    if (a.default !== undefined) prop.default = a.default;
    if (a.choices) prop.enum = a.choices;
    props[a.name] = prop;
    if (a.required) required.push(a.name);
  }

  const schema: JsonSchemaObject = {
    type: "object",
    properties: props,
    additionalProperties: false,
  };
  if (required.length > 0) schema.required = required;
  return schema;
}

/**
 * Build the output JSON Schema. We model results as `{ count, results }`
 * mirroring run_command, where each item in `results` follows the
 * `columns` shape (string-typed properties — Uni-CLI columns are
 * format-agnostic and the runtime emits whatever the pipeline produced).
 */
/**
 * Build an output JSON Schema. We model results as `{count, results}` where
 * `results` is an array of items. `columns` becomes the item's property set.
 *
 * Note: we return a simple nested schema rather than a full JSON Schema
 * (which would need a deeper `items` type for `array`). Most MCP clients
 * only inspect the top-level type; Anthropic's client is permissive. If a
 * strict validator rejects this, it will still fall back to the default tool
 * path via `run_command`.
 */
function buildOutputSchema(cmd: AdapterCommand): JsonSchemaObject {
  const itemProps: Record<string, JsonSchemaProperty> = {};
  for (const col of cmd.columns ?? []) {
    itemProps[col] = { type: "string", description: `Column: ${col}` };
  }
  return {
    type: "object",
    properties: {
      count: { type: "integer", description: "Number of results returned" },
      results: {
        type: "array",
        description: "Result rows",
        items: {
          type: "object",
          ...(Object.keys(itemProps).length > 0
            ? { properties: itemProps }
            : {}),
        } as JsonSchemaProperty,
      } as JsonSchemaProperty,
    },
  };
}

/**
 * MCP tool name: `unicli_<site>_<command>` with non-alphanumeric chars
 * collapsed to `_`. Anthropic / Claude Desktop accept underscores; some
 * older clients reject hyphens, so we normalize defensively.
 *
 * CRITICAL: normalization is NOT reversible (e.g. both `claude-code_version`
 * and `claude_code-version` would yield the same normalized name). The
 * expanded-mode dispatcher uses a name → {adapter, cmdName} lookup table
 * built at the same time as the tool list, so callers never need to reverse
 * the normalization. See `expandedRegistry` and `buildExpandedTools` below.
 */
function buildToolName(site: string, command: string): string {
  return `unicli_${site}_${command}`.replace(/[^a-zA-Z0-9_]/g, "_");
}

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

function buildExpandedTools(): McpTool[] {
  const tools: McpTool[] = [];
  // Always include the 3 default tools for discovery and generic execution.
  tools.push(...buildDefaultTools());

  expandedRegistry.clear();
  // Collision detection: if two (site, command) pairs normalize to the same
  // tool name, the first one wins and the second is silently shadowed. We
  // don't expect this in practice (most adapters use lowercase alphanumeric
  // + hyphen names), but flag it on stderr so it gets noticed.
  // Seed with the 3 default tool names to prevent adapter commands from
  // overwriting them if they happen to produce an identical normalized name.
  const seen = new Set<string>(["unicli_run", "unicli_list", "unicli_discover"]);

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
      });
    }
  }

  return tools;
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
              adapter_path: `src/adapters/${adapter.name}/${cmdName}.yaml`,
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
      _meta: { "anthropic/maxResultSizeChars": 500_000 },
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

const PROTOCOL_VERSION = "2024-11-05";

interface ServerOptions {
  expanded: boolean;
  transport: "stdio" | "http";
  port: number;
}

function parseArgs(argv: string[]): ServerOptions {
  const opts: ServerOptions = {
    expanded: false,
    transport: "stdio",
    port: 19826,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--expanded") opts.expanded = true;
    else if (a === "--transport") {
      const v = argv[++i];
      if (v === "stdio" || v === "http") opts.transport = v;
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
              tools: {},
            },
            serverInfo: {
              name: "unicli",
              version: VERSION,
            },
          },
        };

      case "notifications/initialized":
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
          case "unicli_discover": {
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
              if (result) return { jsonrpc: "2.0", id, result: annotateIfLarge(result) };
              return {
                jsonrpc: "2.0",
                id,
                error: {
                  code: -32601,
                  message: `Unknown tool: ${params.name}. Use unicli_list to see available commands.`,
                },
              };
            });
        }
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
): Promise<void> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && (req.url === "/" || req.url === "/mcp" || req.url === "/health")) {
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
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response ?? null));
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

  const mode = opts.expanded ? "expanded" : "default";
  const tools = opts.expanded ? buildExpandedTools() : buildDefaultTools();
  const handler = buildHandler(tools);

  const adapterCount = getAllAdapters().length;
  const commandCount = listCommands().length;

  if (opts.transport === "http") {
    await startHttp(handler, opts.port);
    process.stderr.write(
      `unicli MCP server v${VERSION} — ${adapterCount} sites, ${commandCount} commands (${tools.length} tools registered, mode=${mode})\n`,
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
