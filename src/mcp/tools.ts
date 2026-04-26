/**
 * MCP tool-definition builders.
 *
 * Three build modes:
 *   1. `buildDefaultTools()`  — 4 meta-tools (~200 tokens handshake)
 *   2. `buildExpandedTools()` — one tool per adapter command (~160K tokens)
 *   3. `buildDeferredTools()` — stubs for ToolSearch/deferred clients (~8K)
 *
 * Extracted from `server.ts` to keep that file's responsibility limited to
 * JSON-RPC transport wiring.
 */

import { getAllAdapters } from "../registry.js";
import type { AdapterManifest, AdapterCommand } from "../types.js";
import {
  type JsonSchemaObject,
  buildInputSchema,
  buildOutputSchema,
  buildToolName,
  truncateDescription,
} from "./schema.js";

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
  outputSchema?: JsonSchemaObject;
  _meta?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

export interface ExpandedEntry {
  adapter: AdapterManifest;
  cmdName: string;
  cmd: AdapterCommand;
}

/**
 * Reverse-lookup registry for expanded-mode tool calls. Maps the normalized
 * tool name to the resolved adapter + original command name.
 */
export const expandedRegistry = new Map<string, ExpandedEntry>();

export const DEFAULT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "unicli_run",
  "unicli_list",
  "unicli_search",
  "unicli_explore",
]);

const RESERVED_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...DEFAULT_TOOL_NAMES,
  "unicli_discover",
]);

export function buildDefaultTools(): McpTool[] {
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
        "Search the Uni-CLI command catalog by intent. Bilingual (EN/ZH). Returns top matches with usage examples.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Natural language intent (e.g. 'download video', 'twitter trending', 'stock price')",
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

/**
 * Build the expanded tool set: 4 default meta-tools + one full tool per
 * adapter command. Clients see the complete Uni-CLI surface area.
 *
 * Token cost scales with the adapter catalog. Use only when the client can
 * handle a large tool list.
 */
export function buildExpandedTools(): McpTool[] {
  const tools: McpTool[] = [];
  tools.push(...buildDefaultTools());

  expandedRegistry.clear();
  const seen = new Set<string>(RESERVED_TOOL_NAMES);

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
export function buildDeferredTools(): McpTool[] {
  const tools: McpTool[] = [];
  tools.push(...buildDefaultTools());

  expandedRegistry.clear();
  const seen = new Set<string>(RESERVED_TOOL_NAMES);

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
