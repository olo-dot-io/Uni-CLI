/**
 * @owner       src::mcp::result-budget
 * @does        Enforce one bounded JSON-RPC result budget before any MCP transport writes a response.
 * @needs       MCP JSON-RPC response types.
 * @feeds       MCP handler, stdio, JSON HTTP, and SSE response paths.
 * @breaks      Unbounded synchronous tool results can exhaust server/client memory and monopolize a transport write queue.
 * @invariants  Oversized request results become a small typed JSON-RPC error with the original id; errors are never recursively budgeted.
 * @side-effects None.
 * @perf        One serialization of a successful result to determine its exact UTF-8 wire size.
 * @concurrency Pure and request-local.
 * @test        tests/unit/mcp/tools.test.ts, tests/unit/mcp/stdio-transport.test.ts
 * @stability   experimental
 * @since       2026-07-30
 */

import type { JsonRpcResponse, JsonRpcServerMessage } from "./jsonrpc.js";
import { jsonRpcError } from "./jsonrpc.js";

export const MCP_MAX_RESULT_BYTES = 768 * 1024;
export const MCP_RESULT_TOO_LARGE = -32_010;
export const MCP_RESULT_NOT_SERIALIZABLE = -32_011;

export function enforceJsonRpcResultBudget(
  response: JsonRpcResponse | undefined,
): JsonRpcResponse | undefined {
  if (!response || response.error || response.result === undefined) {
    return response;
  }
  const serialized = safeSerialize(response.result);
  if (!serialized.ok) return notSerializable(response.id);
  const actualBytes = Buffer.byteLength(serialized.text, "utf8");
  if (actualBytes <= MCP_MAX_RESULT_BYTES) return response;
  return jsonRpcError(
    response.id,
    MCP_RESULT_TOO_LARGE,
    "Tool result exceeds the synchronous MCP result budget",
    {
      code: "result_too_large",
      actual_bytes: actualBytes,
      max_bytes: MCP_MAX_RESULT_BYTES,
      retryable: false,
      suggestion:
        "Request a narrower result, use pagination, or run the operation as a durable task that returns an artifact reference.",
    },
  );
}

export function serializeBoundedJsonRpcMessage(
  message: JsonRpcServerMessage,
): string {
  // Serialize the actual wire envelope once. This catches cyclic/BigInt
  // values at the transport boundary and reuses the exact measured bytes,
  // avoiding a measure-then-stringify TOCTOU.
  const serialized = safeSerialize(message);
  if (!serialized.ok) {
    return JSON.stringify(notSerializable("id" in message ? message.id : null));
  }
  if (
    "id" in message &&
    !message.error &&
    message.result !== undefined &&
    Buffer.byteLength(serialized.text, "utf8") > MCP_MAX_RESULT_BYTES
  ) {
    return JSON.stringify(
      jsonRpcError(
        message.id,
        MCP_RESULT_TOO_LARGE,
        "Tool result exceeds the synchronous MCP result budget",
        {
          code: "result_too_large",
          actual_bytes: Buffer.byteLength(serialized.text, "utf8"),
          max_bytes: MCP_MAX_RESULT_BYTES,
          retryable: false,
          suggestion:
            "Request a narrower result, use pagination, or run the operation as a durable task that returns an artifact reference.",
        },
      ),
    );
  }
  return serialized.text;
}

function notSerializable(id: JsonRpcResponse["id"]): JsonRpcResponse {
  return jsonRpcError(
    id,
    MCP_RESULT_NOT_SERIALIZABLE,
    "Tool result is not JSON serializable",
    {
      code: "result_not_serializable",
      retryable: false,
      suggestion:
        "Return plain JSON values without cycles, BigInt, functions, or symbols.",
    },
  );
}

function safeSerialize(
  value: unknown,
): { ok: true; text: string } | { ok: false } {
  try {
    const text = JSON.stringify(value);
    return { ok: true, text: text ?? "null" };
  } catch {
    return { ok: false };
  }
}
