/**
 * @owner       src::mcp::http-transport
 * @does        Preserve the `--http` entry point as a compatibility name for the single MCP 2025-11-25 Streamable HTTP implementation.
 * @needs       shared JSON-RPC handler and Streamable HTTP runtime
 * @feeds       src/mcp/server.ts and legacy programmatic callers
 * @breaks      A second stateless HTTP implementation cannot preserve standard Tasks identity and creates protocol/security drift.
 * @invariants  Simple HTTP and Streamable HTTP share the same session, Origin, OAuth, cancellation, Tasks, and teardown semantics; no random per-request task owner exists.
 * @side-effects Starts/stops the shared loopback Streamable HTTP runtime.
 * @perf        Adds no runtime layer beyond one function call.
 * @concurrency Lifecycle is delegated to the idempotent shared runtime.
 * @test        tests/unit/mcp/http-transport.test.ts, tests/unit/streamable-http.test.ts
 * @stability   stable compatibility surface
 * @since       2026-04-01
 */

import type { buildHandler } from "./handler.js";
import {
  startStreamableHttp,
  stopStreamableHttp,
} from "./streamable-http/index.js";

export function startHttp(
  handler: ReturnType<typeof buildHandler>,
  port: number,
  authEnabled = false,
): Promise<number> {
  return startStreamableHttp(port, handler, { auth: authEnabled });
}

export function stopHttp(
  port: number,
  reason = "MCP HTTP server stopped",
): Promise<void> {
  return stopStreamableHttp(port, reason);
}
