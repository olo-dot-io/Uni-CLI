/**
 * @owner       src::engine::transport::mcp-browser
 * @does        Transport adapter that proxies pipeline browser steps (navigate / wait / evaluate / snapshot) to a real Chrome session reachable through the bb-browser or claude-in-chrome MCP server — sole programmatic path for L3 jurisdictions whose IP office offers no open API (CNIPA, INPI-BR pre-API, Rospatent, CIPO, Espacenet HTML).
 * @needs       src/engine/transport/types.ts, src/engine/transport/bus.ts
 * @feeds       src/adapters/cnipa/*, src/adapters/espacenet/*, src/adapters/cipo/*, src/adapters/inpi-br/*, src/adapters/fips/*
 * @breaks      throws TransportError when no MCP server is reachable or the server returns an unrecognized error code; emits PATENT_BROWSER_CAPTCHA envelope code when upstream challenge detected
 * @invariants  prefer bb-browser MCP if both available (claude-in-chrome requires tool pre-loading via ToolSearch); never silently fall back to a synthetic response — rule 02
 * @side-effects network egress through MCP server; controls the user's actual Chrome browser (visible side-effect)
 * @perf        latency is bounded by browser navigation; expect 1-5 s per page
 * @concurrency one tab per logical request; the transport does not multiplex
 * @test        tests/unit/engine/transport/mcp-browser.test.ts (interface contract only — live MCP not under unit test)
 * @stability   experimental — MCP server vocabulary evolves; gate live use behind a feature flag
 * @since       2026-05-18
 */

export interface McpBrowserNavigateRequest {
  url: string;
  /** Preferred MCP server: "bb-browser" | "claude-in-chrome". Default "bb-browser". */
  preferred?: "bb-browser" | "claude-in-chrome";
  /** Optional tab short-id; if absent a new tab is opened. */
  tab?: string;
  /** Network-idle wait in ms after navigation. Default 1500. */
  network_idle_ms?: number;
}

export interface McpBrowserEvaluateRequest {
  /** JavaScript expression to evaluate in the page context. */
  expression: string;
  tab?: string;
}

export interface McpBrowserSnapshotRequest {
  tab?: string;
  /** Whether to return accessibility-tree refs alongside HTML. Default false. */
  with_refs?: boolean;
}

export interface McpBrowserResult<T = unknown> {
  ok: boolean;
  data?: T;
  /** Error code when ok=false. Aligned with PatentErrorCode where applicable. */
  code?: string;
  message?: string;
  /** Short-id of the tab the operation ran in, when applicable. */
  tab?: string;
}

export class TransportError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

/**
 * Initialize the transport — confirms which MCP server (bb-browser preferred,
 * claude-in-chrome fallback) is reachable in this session. Idempotent.
 */
export async function initMcpBrowserTransport(): Promise<{
  active_server: "bb-browser" | "claude-in-chrome" | "none";
}> {
  throw new Error(
    "mcp-browser: initMcpBrowserTransport not yet implemented (M0 stub — wave-2-subagent-D will fill body)",
  );
}

export async function mcpBrowserNavigate(
  _req: McpBrowserNavigateRequest,
): Promise<McpBrowserResult<{ url: string; title?: string }>> {
  throw new Error(
    "mcp-browser: mcpBrowserNavigate not yet implemented (M0 stub — wave-2-subagent-D will fill body)",
  );
}

export async function mcpBrowserEvaluate<T = unknown>(
  _req: McpBrowserEvaluateRequest,
): Promise<McpBrowserResult<T>> {
  throw new Error(
    "mcp-browser: mcpBrowserEvaluate not yet implemented (M0 stub — wave-2-subagent-D will fill body)",
  );
}

export async function mcpBrowserSnapshot(
  _req: McpBrowserSnapshotRequest,
): Promise<McpBrowserResult<{ html: string; refs?: unknown }>> {
  throw new Error(
    "mcp-browser: mcpBrowserSnapshot not yet implemented (M0 stub — wave-2-subagent-D will fill body)",
  );
}
