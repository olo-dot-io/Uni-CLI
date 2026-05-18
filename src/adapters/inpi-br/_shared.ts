/**
 * @owner       src::adapters::inpi-br::_shared
 * @does        Shared helpers for the INPI Brasil browser adapter — busca.inpi.gov.br/pePI/ has no programmatic API today (pre-API status); the browser route is the only path.
 * @needs       src/engine/transport/mcp-browser.ts, src/engine/normalizer/patent-envelope.ts, src/types/patent.ts
 * @feeds       src/adapters/inpi-br/*.ts
 * @breaks      none — pure helpers
 * @invariants  every transport gap surfaces as a PatentEnvelope row
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

export function inpiBrEnvelope(
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

export function transportErrorToInpiBrEnvelope(
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
        "engine has no outbound MCP transport wired into the bus today; INPI Brasil has no upstream API so the browser path is the only route — install an McpResolver to activate this adapter",
      alternatives: ["espacenet", "lens"],
      retryable: false,
    });
  }
  return buildPatentEnvelope({
    code: "PATENT_API_DEPRECATED",
    adapter_path,
    step,
    suggestion: `mcp-browser transport error (${err.code}): ${err.message}`,
    alternatives: ["espacenet"],
    retryable: false,
  });
}

export async function inpiBrNavigateAndExtract<T>(
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
