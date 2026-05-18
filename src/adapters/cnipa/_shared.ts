/**
 * @owner       src::adapters::cnipa::_shared
 * @does        Shared helpers for CNIPA browser-driven adapter commands — emits structured PATENT_BROWSER_CAPTCHA / MCP_BUS_MISSING / PATENT_NOT_FOUND error rows so adapters never synthesize results from a failed page.
 * @needs       src/engine/transport/mcp-browser.ts, src/engine/normalizer/patent-envelope.ts, src/types/patent.ts
 * @feeds       src/adapters/cnipa/search.ts, src/adapters/cnipa/get.ts, src/adapters/cnipa/legal-status.ts
 * @breaks      none — pure helpers; bubble TransportError out to the registry func contract
 * @invariants  every error path maps to a PatentEnvelope with adapter_path stamped; no silent fallbacks
 * @side-effects none
 * @perf        n/a
 * @concurrency safe
 * @test        covered transitively by src/adapters/cnipa/*.test.ts
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

export interface CnipaErrorRow {
  publication_number: string;
  title: string;
  envelope: PatentEnvelope;
}

export function cnipaEnvelope(
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
    retryable: code === "PATENT_BROWSER_CAPTCHA" ? true : false,
  });
}

/**
 * Wrap a TransportError from mcp-browser into a PatentEnvelope row.
 * MCP_BUS_MISSING is the production state today — surfaced honestly so the
 * agent's repair loop knows the engine is missing the outbound MCP transport.
 */
export function transportErrorToEnvelope(
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
        "engine has no outbound MCP transport wired into the bus today; install an McpResolver via src/engine/transport/mcp-browser.installMcpResolver() before invoking this adapter, or try a non-browser source first",
      alternatives: ["uspto", "epo", "lens"],
      retryable: false,
    });
  }
  return buildPatentEnvelope({
    code: "PATENT_API_DEPRECATED",
    adapter_path,
    step,
    suggestion: `mcp-browser transport error (${err.code}): ${err.message}`,
    alternatives: ["uspto", "epo"],
    retryable: false,
  });
}

/**
 * Navigate then evaluate a DOM-extraction expression. Returns the evaluate
 * result on the happy path, or throws a TransportError with a structured
 * code so callers map to a PatentEnvelope row.
 *
 * Adapters MUST treat the result as untrusted and validate shape before
 * normalization — captcha pages tend to return zero-length arrays without
 * throwing.
 */
export async function navigateAndExtract<T>(
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

/**
 * Heuristic — CNIPA public-search captcha is a 验证码 iframe. When the
 * evaluator returns a zero-length result array, the safest assumption is
 * captcha; emit a structured envelope rather than a "no results" message
 * the agent cannot disambiguate.
 */
export function looksLikeCaptcha(
  rowCount: number,
  htmlMarker?: string,
): boolean {
  if (rowCount > 0) return false;
  if (!htmlMarker) return true; // empty result on a browser path = assume captcha
  const lowered = htmlMarker.toLowerCase();
  return (
    lowered.includes("captcha") ||
    lowered.includes("验证码") ||
    lowered.includes("verifycode")
  );
}
