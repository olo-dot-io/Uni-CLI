/**
 * @owner       src::adapters::espacenet::_shared
 * @does        Shared helpers for the Espacenet browser-driven adapter — distinct from the EPO OPS HTTP adapter (which lives at src/adapters/epo/*). Espacenet is the no-key public front end; EPO OPS is the keyed REST API.
 * @needs       src/engine/transport/mcp-browser.ts, src/engine/normalizer/patent-envelope.ts, src/types/patent.ts
 * @feeds       src/adapters/espacenet/*.ts
 * @breaks      none — pure helpers
 * @invariants  every transport gap surfaces as a PatentEnvelope row with adapter_path stamped
 * @side-effects none
 * @perf        n/a
 * @concurrency safe
 * @test        covered transitively
 * @stability   experimental
 * @since       2026-05-18
 * @verification browser-only
 */

import {
  TransportError,
  initMcpBrowserTransport,
  mcpBrowserEvaluate,
  mcpBrowserNavigate,
  type McpBrowserResult,
} from "../../engine/transport/mcp-browser.js";
import { buildPatentEnvelope } from "../../engine/normalizer/patent-envelope.js";
import type { PatentEnvelope, PatentErrorCode } from "../../types/patent.js";

export function espacenetEnvelope(
  code: PatentErrorCode,
  adapter_path: string,
  step: string,
  suggestion: string,
  alternatives: string[] = [],
): PatentEnvelope {
  return buildPatentEnvelope({
    code,
    adapter_path,
    step,
    suggestion,
    alternatives,
    retryable: false,
  });
}

export function transportErrorToEspacenetEnvelope(
  err: TransportError,
  adapter_path: string,
  step: string,
): PatentEnvelope {
  if (err.code === "MCP_BUS_MISSING") {
    return buildPatentEnvelope({
      code: "PATENT_API_DEPRECATED",
      adapter_path,
      step,
      suggestion:
        "engine has no outbound MCP transport wired into the bus today; install an McpResolver before invoking espacenet browser adapter, or use EPO OPS (src/adapters/epo/*) which exposes a keyed API",
      alternatives: ["epo", "uspto", "lens"],
      retryable: false,
    });
  }
  return buildPatentEnvelope({
    code: "PATENT_API_DEPRECATED",
    adapter_path,
    step,
    suggestion: `mcp-browser transport error (${err.code}): ${err.message}`,
    alternatives: ["epo"],
    retryable: false,
  });
}

export async function espacenetNavigateAndExtract<T>(
  url: string,
  expression: string,
): Promise<McpBrowserResult<T>> {
  const init = await initMcpBrowserTransport();
  if (init.active_server === "none") {
    const code =
      init.reason === "bus-missing" ? "MCP_BUS_MISSING" : "MCP_NO_SERVER";
    throw new TransportError(code, `mcp-browser unavailable (${init.reason})`);
  }
  const navResult = await mcpBrowserNavigate({ url });
  if (!navResult.ok) {
    throw new TransportError(
      navResult.code ?? "MCP_NAVIGATE_FAILED",
      navResult.message ?? "navigate did not succeed",
    );
  }
  const evalResult = await mcpBrowserEvaluate<T>({
    expression,
    tab: navResult.tab,
  });
  if (!evalResult.ok) {
    throw new TransportError(
      evalResult.code ?? "MCP_EVALUATE_FAILED",
      evalResult.message ?? "evaluate did not succeed",
    );
  }
  return evalResult;
}
