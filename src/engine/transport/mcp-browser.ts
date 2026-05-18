/**
 * @owner       src::engine::transport::mcp-browser
 * @does        Transport adapter that proxies pipeline browser steps (navigate / wait / evaluate / snapshot) to a real Chrome session reachable through the bb-browser or claude-in-chrome MCP server — sole programmatic path for L3 jurisdictions whose IP office offers no open API (CNIPA, INPI-BR pre-API, Rospatent, CIPO, Espacenet HTML).
 * @needs       src/transport/bus.ts (TransportBus surface — note: MCP client integration is NOT yet wired into the bus; this module returns MCP_BUS_MISSING TransportError until the bus grows an mcp transport kind)
 * @feeds       src/adapters/cnipa/*, src/adapters/espacenet/*, src/adapters/cipo/*, src/adapters/inpi-br/*, src/adapters/fips/*
 * @breaks      throws TransportError(code='MCP_BUS_MISSING') when invoked today because the in-repo TransportBus has no outbound MCP client; throws TransportError(code='MCP_NO_SERVER') when both candidate servers are absent; emits PATENT_BROWSER_CAPTCHA envelope when upstream challenge detected at the adapter layer (not here)
 * @invariants  prefer bb-browser MCP if both available (claude-in-chrome requires tool pre-loading via ToolSearch); never silently fall back to a synthetic response — rule 02
 * @side-effects network egress through MCP server; controls the user's actual Chrome browser (visible side-effect) — currently inactive because no MCP outbound transport exists in the bus
 * @perf        latency is bounded by browser navigation; expect 1-5 s per page once live
 * @concurrency one tab per logical request; the transport does not multiplex
 * @test        tests/unit/engine/transport/mcp-browser.test.ts (interface contract only — live MCP not under unit test)
 * @stability   experimental — MCP server vocabulary evolves; gate live use behind a feature flag
 * @since       2026-05-18
 *
 * Integration status: the existing TransportBus at src/transport/bus.ts exposes
 * a fixed set of seven TransportKind values (http, cdp-browser, subprocess,
 * desktop-ax, desktop-uia, desktop-atspi, cua). There is NO outbound MCP
 * client wired into the bus — src/mcp/* implements Uni-CLI AS an MCP server,
 * not as an MCP client. Per rule 02 / Priority Zero NO HACKS, this module
 * does NOT invent a fake transport; every entry point returns a structured
 * TransportError with code MCP_BUS_MISSING (or MCP_NO_SERVER from
 * initMcpBrowserTransport when probing) so callers can emit a PATENT_*
 * envelope with a clear suggestion. When the bus gains an mcp-client
 * TransportKind (tracked separately), replace the MCP_BUS_MISSING returns
 * with dispatch through that transport.
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
 * Server probe result. Active server is "none" when neither bb-browser nor
 * claude-in-chrome is reachable, AND when the engine has no outbound MCP
 * transport to call them through (current state on main).
 */
export interface McpBrowserInit {
  active_server: "bb-browser" | "claude-in-chrome" | "none";
  /**
   * Why no server is active. "bus-missing" means the engine has no outbound
   * MCP client wired into the TransportBus. "no-server" means an outbound
   * route exists but neither candidate MCP server is reachable. Surfaced so
   * adapter-level error envelopes can suggest the right repair path.
   */
  reason?: "bus-missing" | "no-server";
}

/**
 * Resolver injected by the host process (Claude Code session, future MCP
 * bus transport, or a test) that can dispatch an outbound MCP tool call to
 * either bb-browser or claude-in-chrome. Stays nullable so the module
 * loads cleanly on a host with no MCP plumbing — that is the production
 * path today.
 */
export interface McpResolver {
  /**
   * Best-effort liveness probe. Returns true when the named server has
   * declared its tools to the host. Implementations should NOT throw —
   * a failed probe returns false.
   */
  isAvailable(server: "bb-browser" | "claude-in-chrome"): Promise<boolean>;
  /**
   * Dispatch a single tool call. Tool name is the MCP convention
   * (e.g. "browser_navigate"); arguments shape is the server's contract.
   * The resolver normalises responses to McpBrowserResult so adapters do
   * not branch on which server answered.
   */
  call<T = unknown>(
    server: "bb-browser" | "claude-in-chrome",
    tool: string,
    args: Record<string, unknown>,
  ): Promise<McpBrowserResult<T>>;
}

let installedResolver: McpResolver | undefined;

/**
 * Install an MCP resolver. The host process (the Claude Code session, a
 * future MCP-bus transport adapter, or a unit test) injects a resolver so
 * this module can stay free of the SDK dependency. Calling with `undefined`
 * uninstalls — used by tests to assert the "no resolver" path.
 */
export function installMcpResolver(resolver: McpResolver | undefined): void {
  installedResolver = resolver;
}

/** @internal — exposed for tests; production callers should not read this. */
export function _getMcpResolverForTests(): McpResolver | undefined {
  return installedResolver;
}

/**
 * Initialize the transport — confirms which MCP server (bb-browser
 * preferred, claude-in-chrome fallback) is reachable in this session.
 * Idempotent.
 *
 * Returns `{ active_server: "none", reason: "bus-missing" }` when no
 * outbound MCP resolver has been installed (the engine's current state).
 * Returns `{ active_server: "none", reason: "no-server" }` when a resolver
 * exists but neither candidate server is reachable.
 *
 * Never throws — callers (adapters) emit a PATENT_* envelope with the
 * appropriate suggestion based on `reason`.
 */
export async function initMcpBrowserTransport(): Promise<McpBrowserInit> {
  const resolver = installedResolver;
  if (!resolver) {
    return { active_server: "none", reason: "bus-missing" };
  }
  // bb-browser preferred per file-header @invariants.
  let bbAvailable = false;
  try {
    bbAvailable = await resolver.isAvailable("bb-browser");
  } catch {
    bbAvailable = false;
  }
  if (bbAvailable) return { active_server: "bb-browser" };

  let cicAvailable = false;
  try {
    cicAvailable = await resolver.isAvailable("claude-in-chrome");
  } catch {
    cicAvailable = false;
  }
  if (cicAvailable) return { active_server: "claude-in-chrome" };

  return { active_server: "none", reason: "no-server" };
}

async function dispatch<T>(
  tool: { bb: string; cic: string },
  args: Record<string, unknown>,
): Promise<McpBrowserResult<T>> {
  const init = await initMcpBrowserTransport();
  if (init.active_server === "none") {
    const code =
      init.reason === "bus-missing" ? "MCP_BUS_MISSING" : "MCP_NO_SERVER";
    const message =
      init.reason === "bus-missing"
        ? "no outbound MCP transport is wired into the engine; register an McpResolver via installMcpResolver() before invoking browser-driven adapters"
        : "neither bb-browser nor claude-in-chrome MCP server is reachable in this session; start one (bb-browser preferred) and retry";
    throw new TransportError(code, message);
  }
  const resolver = installedResolver;
  if (!resolver) {
    // Defensive: initMcpBrowserTransport already returned a server, so a
    // resolver should be present. If it disappeared between calls,
    // surface the gap honestly rather than synthesise a result.
    throw new TransportError(
      "MCP_BUS_MISSING",
      "McpResolver disappeared between init and dispatch; no fallback",
    );
  }
  const toolName = init.active_server === "bb-browser" ? tool.bb : tool.cic;
  return resolver.call<T>(init.active_server, toolName, args);
}

export async function mcpBrowserNavigate(
  req: McpBrowserNavigateRequest,
): Promise<McpBrowserResult<{ url: string; title?: string }>> {
  return dispatch<{ url: string; title?: string }>(
    { bb: "browser_navigate", cic: "navigate" },
    {
      url: req.url,
      tab: req.tab,
      network_idle_ms: req.network_idle_ms ?? 1500,
    },
  );
}

export async function mcpBrowserEvaluate<T = unknown>(
  req: McpBrowserEvaluateRequest,
): Promise<McpBrowserResult<T>> {
  return dispatch<T>(
    { bb: "browser_eval", cic: "javascript_tool" },
    { expression: req.expression, tab: req.tab },
  );
}

export async function mcpBrowserSnapshot(
  req: McpBrowserSnapshotRequest,
): Promise<McpBrowserResult<{ html: string; refs?: unknown }>> {
  return dispatch<{ html: string; refs?: unknown }>(
    { bb: "browser_snapshot", cic: "read_page" },
    { tab: req.tab, with_refs: req.with_refs ?? false },
  );
}
