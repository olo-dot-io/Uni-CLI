/**
 * @owner       src::mcp::local-observation
 * @does        Converts one privacy-safe MCP request identity and terminal JSON-RPC response into a local diagnostic event.
 * @needs       JSON-RPC response contract, local event log
 * @feeds       MCP handler request and protocol-error instrumentation
 * @breaks      Raw request names, duplicate warnings, or divergent response classification corrupt local MCP evidence.
 * @invariants  Only advertised safe tool names or fixed error labels persist; one observation appends at most one request-boundary event.
 * @side-effects Appends a bounded terminal event and adds any append failure to the existing MCP response metadata.
 * @perf        O(serialized response bytes) once per completed MCP tool request.
 * @concurrency Observation state is request-local; the event store serializes persistence.
 * @test        tests/unit/mcp/logging.test.ts
 * @stability   internal
 * @since       2026-07-18
 */

import { randomUUID } from "node:crypto";
import {
  appendLocalEvent,
  createLocalEvent,
  localEventWarning,
} from "../runtime/local-event-log.js";
import type { JsonRpcResponse } from "./jsonrpc.js";

export interface McpCallObservation {
  invocationId: string;
  startedAt: number;
  command: string;
}

export function createMcpCallObservation(
  toolName: string | undefined,
  startedAt: number = Date.now(),
): McpCallObservation {
  const safeToolName =
    toolName && /^[a-z0-9_-]{1,128}$/i.test(toolName)
      ? toolName.toLowerCase()
      : "known_tool";
  return createObservation(safeToolName, startedAt);
}

export function createMcpErrorObservation(
  command: "unknown_tool" | "protocol_error",
  startedAt: number,
): McpCallObservation {
  return createObservation(command, startedAt);
}

export function completeMcpCallObservation(
  observation: McpCallObservation,
  response: JsonRpcResponse,
): JsonRpcResponse {
  const error = responseError(response);
  const resultCount = responseCount(response);
  const resultBytes = serializedResponseBytes(response);
  const warning = appendObservation(observation, {
    outcome: error ? "error" : responseIsEmpty(response) ? "empty" : "success",
    exitCode: error ? 2 : 0,
    ...(resultCount !== undefined ? { resultCount } : {}),
    ...(resultBytes !== undefined ? { resultBytes } : {}),
    ...(error ? { errorType: error.type, retryable: error.retryable } : {}),
  });
  return warning ? withLocalLogWarning(response, warning) : response;
}

export function recordThrownMcpCall(
  observation: McpCallObservation,
): string | undefined {
  return appendObservation(observation, {
    outcome: "error",
    exitCode: 1,
    errorType: "internal_error",
  });
}

function createObservation(
  command: string,
  startedAt: number,
): McpCallObservation {
  return {
    invocationId: randomUUID(),
    startedAt,
    command: `mcp.${command}`,
  };
}

function appendObservation(
  observation: McpCallObservation,
  terminal: {
    outcome: "success" | "empty" | "error";
    exitCode: number;
    resultCount?: number;
    resultBytes?: number;
    errorType?: string;
    retryable?: boolean;
  },
): string | undefined {
  return localEventWarning(
    appendLocalEvent(
      createLocalEvent({
        event_name: "unicli.tool.call.completed",
        invocation_id: observation.invocationId,
        transport: "mcp",
        command: observation.command,
        site: "mcp",
        cmd: observation.command.slice("mcp.".length),
        strategy: "handler",
        operation_role: "invocation",
        outcome: terminal.outcome,
        exit_code: terminal.exitCode,
        duration_ms: Math.max(0, Date.now() - observation.startedAt),
        ...(terminal.resultCount !== undefined
          ? { result_count: terminal.resultCount }
          : {}),
        ...(terminal.resultBytes !== undefined
          ? { result_bytes: terminal.resultBytes }
          : {}),
        ...(terminal.errorType
          ? {
              error_type: terminal.errorType,
              retryable: terminal.retryable ?? false,
            }
          : {}),
      }),
    ),
  );
}

const SAFE_TOOL_ERROR_TYPES = new Set([
  "ambiguous",
  "api_error",
  "auth_required",
  "challenge_required",
  "empty_result",
  "internal_error",
  "invalid_input",
  "network_error",
  "not_authenticated",
  "not_found",
  "operation_outcome_ambiguous",
  "permission_denied",
  "quarantined",
  "rate_limited",
  "ref_not_found",
  "selector_miss",
  "service_unavailable",
  "stale_ref",
  "timeout",
  "unsupported_surface",
  "upstream_error",
]);

function responseError(
  response: JsonRpcResponse,
): { type: string; retryable: boolean } | undefined {
  if (response.error?.code === -32602) {
    return { type: "invalid_input", retryable: false };
  }
  if (response.error?.code === -32601) {
    return { type: "not_found", retryable: false };
  }
  if (response.error) return { type: "protocol_error", retryable: false };
  if (!isRecord(response.result) || response.result.isError !== true) {
    return undefined;
  }
  const structuredContent = response.result.structuredContent;
  const data = isRecord(structuredContent) ? structuredContent.data : undefined;
  const candidates = [data, isRecord(data) ? data.error : undefined];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const code = candidate.code;
    if (typeof code !== "string" || !SAFE_TOOL_ERROR_TYPES.has(code)) continue;
    return {
      type: code,
      retryable:
        typeof candidate.retryable === "boolean" ? candidate.retryable : false,
    };
  }
  return { type: "tool_error", retryable: false };
}

function responseIsEmpty(response: JsonRpcResponse): boolean {
  return (
    isRecord(response.result) &&
    Array.isArray(response.result.content) &&
    response.result.content.length === 0
  );
}

function responseCount(response: JsonRpcResponse): number | undefined {
  if (
    !isRecord(response.result) ||
    !isRecord(response.result.structuredContent)
  ) {
    return undefined;
  }
  const structuredData = response.result.structuredContent.data;
  if (!isRecord(structuredData)) return undefined;
  const count = structuredData.count;
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0
    ? count
    : undefined;
}

function serializedResponseBytes(
  response: JsonRpcResponse,
): number | undefined {
  try {
    return Buffer.byteLength(
      JSON.stringify(response.result ?? response.error),
      "utf-8",
    );
  } catch {
    return undefined;
  }
}

function withLocalLogWarning(
  response: JsonRpcResponse,
  warning: string,
): JsonRpcResponse {
  if (isRecord(response.result)) {
    const metadata = isRecord(response.result._meta)
      ? response.result._meta
      : {};
    const warnings = Array.isArray(metadata.warnings)
      ? metadata.warnings.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];
    return warnings.includes(warning)
      ? response
      : {
          ...response,
          result: {
            ...response.result,
            _meta: { ...metadata, warnings: [...warnings, warning] },
          },
        };
  }
  if (response.error) {
    const errorData = isRecord(response.error.data) ? response.error.data : {};
    return {
      ...response,
      error: {
        ...response.error,
        data: { ...errorData, local_log_warnings: [warning] },
      },
    };
  }
  return response;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
