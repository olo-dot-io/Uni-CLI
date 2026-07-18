/**
 * @owner       src/mcp/dispatch.ts
 * @does        Dispatch correlated, cancellable MCP tool calls through the shared invocation kernel and shape stable text/image MCP envelopes.
 * @needs       invocation kernel, run recorder, argument coercion, adapter types
 * @feeds       MCP default and expanded tool handlers
 * @breaks      Bypassing this boundary breaks CLI/MCP envelope, authorization, recording, or cancellation parity.
 * @invariants  Handler-owned parent IDs reach the kernel unchanged; flat MCP args remain backward-compatible.
 * @side-effects Executes one adapter invocation and may persist its run receipt and diagnostic event.
 * @perf        One argument coercion and one shared-kernel call per resolved MCP command.
 * @concurrency Request cancellation and diagnostic identity remain invocation-local.
 * @test        tests/unit/mcp/tools.test.ts and tests/unit/mcp/logging.test.ts
 * @stability   stable
 * @since       2026-04-19
 *
 * v0.213.3 R2: every MCP tool call funnels through the invocation kernel so
 * the CLI and MCP surfaces produce byte-identical envelopes (modulo trace_id
 * and duration_ms). Flat `params` shape preserved for D2 backward compat.
 *
 * Shape contract (backward compat with v0.213.2 and earlier):
 *   - success → `{ content: [{type:"text", text: JSON.stringify({count, results}, null, 2)}],
 *                  structuredContent: { type: "json", data: {count, results} } }`
 *   - error   → `{ isError: true, content, structuredContent.data.suggestion, _meta }`
 *   - warnings flow to `_meta.warnings` so agents can inspect them
 */

import { buildInvocation } from "../engine/kernel/execute.js";
import { executeWithRunRecording } from "../engine/session/run-loop.js";
import { coerceLimit } from "../engine/args.js";
import type { AdapterManifest, AdapterCommand } from "../types.js";

export interface McpStructuredContent {
  type: "json";
  data: unknown;
}

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface McpToolResult {
  content: McpContent[];
  structuredContent?: McpStructuredContent;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface ResolvedCommandExecution {
  cmdName: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
  parentInvocationId?: string;
}

/**
 * 10 KB threshold above which MCP clients (Claude Code, Zed) may truncate
 * tool output. When exceeded, we attach `_meta.anthropic/maxResultSizeChars`
 * to raise the cap to 100 KB for this call.
 */
export const MAX_RESULT_SIZE_CHARS = 10_000;

/**
 * Annotate a tool result with `_meta.anthropic/maxResultSizeChars` when the
 * serialized payload exceeds MAX_RESULT_SIZE_CHARS.
 */
export function annotateIfLarge(result: McpToolResult): McpToolResult {
  const totalChars = result.content.reduce(
    (sum, content) => sum + (content.type === "text" ? content.text.length : 0),
    0,
  );
  if (totalChars > MAX_RESULT_SIZE_CHARS) {
    return {
      ...result,
      _meta: {
        ...result._meta,
        "anthropic/maxResultSizeChars": 100_000,
      },
    };
  }
  return result;
}

function withWarnings(
  result: McpToolResult,
  warnings: string[],
): McpToolResult {
  if (warnings.length === 0) return result;
  return {
    ...result,
    _meta: { ...result._meta, warnings: [...warnings] },
  };
}

/**
 * Execute a resolved (adapter, command) pair via the invocation kernel and
 * shape the result into the MCP `McpToolResult` envelope. Used by both the
 * default `unicli_run` tool and every expanded `unicli_<site>_<command>`.
 */
export async function runResolvedCommand(
  adapter: AdapterManifest,
  cmd: AdapterCommand,
  execution: ResolvedCommandExecution,
): Promise<McpToolResult> {
  const { cmdName, args, signal, parentInvocationId } = execution;
  // MCP preserves the flat-params contract. Apply the default `limit: 20`
  // only when the adapter declares a `limit` arg — the kernel's ajv
  // validator runs in strict mode (`additionalProperties: false`), so
  // passing an undeclared `limit` would trip usage errors for adapters
  // that don't paginate.
  const declaresLimit = (cmd.adapterArgs ?? []).some((a) => a.name === "limit");
  const mergedArgs: Record<string, unknown> = declaresLimit
    ? { limit: 20, ...args }
    : { ...args };
  if (declaresLimit && args.limit !== undefined) {
    const coerced = coerceLimit(args.limit);
    if (coerced !== undefined) mergedArgs.limit = coerced;
  }

  const inv = buildInvocation(
    "mcp",
    adapter.name,
    cmdName,
    {
      args: mergedArgs,
      source: "mcp",
    },
    {
      signal,
      parentInvocationId,
      operationRole: parentInvocationId ? "direct" : undefined,
    },
  );
  if (!inv) {
    // Already filtered by handleRunCommand / handleExpandedTool before this
    // point; still, guard so a misrouted call doesn't crash the server.
    const errorData = {
      error: `Unknown command: ${adapter.name} ${cmdName}`,
      suggestion: "Use unicli_list to see available commands.",
    };
    return {
      content: [{ type: "text", text: JSON.stringify(errorData, null, 2) }],
      structuredContent: { type: "json", data: errorData },
      isError: true,
    };
  }

  const result = await executeWithRunRecording(inv);

  if (result.error) {
    const { message, ...details } = result.error;
    const errorData = {
      error: message,
      ...details,
      trace_id: inv.trace_id,
    };
    const base: McpToolResult = {
      content: [{ type: "text", text: JSON.stringify(errorData, null, 2) }],
      structuredContent: { type: "json", data: errorData },
      isError: true,
    };
    return withWarnings(base, result.warnings);
  }

  const data = { count: result.results.length, results: result.results };
  const base: McpToolResult = {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: { type: "json", data },
  };
  return withWarnings(base, result.warnings);
}
