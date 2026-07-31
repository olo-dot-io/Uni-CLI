#!/usr/bin/env node

/**
 * @owner       src::mcp::server
 * @does        Boots stdio, HTTP, or Streamable HTTP MCP transports over the canonical Uni-CLI command registry.
 * @needs       discovery/registry, MCP handler/transports/tools, proxy-aware network
 * @feeds       bin/unicli-mcp and `unicli mcp serve`
 * @breaks      Adapter loading, transport startup, and handler failures surface as JSON-RPC or process errors.
 * @invariants  Default mode exposes four meta-tools; all network-capable handlers share the CLI proxy contract.
 * @side-effects Loads adapters, installs global proxy-aware fetch, binds stdin or network listeners.
 * @perf        Tool catalog size depends on default/deferred/expanded profile.
 * @concurrency JSON-RPC calls may overlap; shared registries are read-only after startup.
 * @test        tests/unit/mcp, tests/integration/mcp*.test.ts
 * @stability   stable
 * @since       2026-04-06
 *
 * Thin bootstrap: load adapters → build tool list → wire the transport →
 * start serving. The meat lives in sibling modules:
 *   - `./tools.ts`          — tool-definition builders (default/expanded/deferred)
 *   - `./dispatch.ts`       — kernel-backed tool-call dispatcher
 *   - `./handler.ts`        — JSON-RPC method dispatch
 *   - `./http-transport.ts` — POST /mcp transport
 *   - `./streamable-http/`  — dual-era Streamable HTTP (MCP 2026-07-28 + 2025-11-25)
 *
 * Three modes:
 *   - default   — 4 meta-tools only
 *   - deferred  — one lightweight stub per loaded adapter command
 *   - expanded  — one full-schema tool per loaded adapter command
 *
 * Three transports:
 *   - stdio (default) — newline-delimited JSON over stdin/stdout
 *   - http            — POST /mcp single request/response
 *   - streamable      — Streamable HTTP with SSE session resume
 *
 * Auth pass-through is automatic: every adapter the CLI loads (including
 * cookie-based ones) is exposed by name; the runtime resolves cookies on
 * each call via the same code path as the CLI.
 */

import { parseArgs as parseNodeArgs } from "node:util";
import { loadAllAdapters, loadTsAdapters } from "../discovery/loader.js";
import { getAllAdapters, listCommands } from "../registry.js";
import { VERSION } from "../constants.js";
import {
  buildExpandedTools,
  buildDeferredTools,
  selectPrompts,
  selectTools,
} from "./tools.js";
import {
  buildHandler,
  createMcpBrowserPolicy,
  type McpBrowserPolicyInput,
} from "./handler.js";
import { startHttp, stopHttp } from "./http-transport.js";
import {
  startStreamableHttp,
  stopStreamableHttp,
} from "./streamable-http/index.js";
import { startStdioTransport } from "./stdio-transport.js";
import { installProxyAwareFetch } from "../engine/proxy.js";

installProxyAwareFetch();

export { annotateIfLarge } from "./dispatch.js";

interface ServerOptions {
  expanded: boolean;
  transport: "stdio" | "http" | "streamable";
  port: number;
  auth: boolean;
  profile: string;
  browserPolicy: McpBrowserPolicyInput;
}

function parseArgs(argv: string[]): ServerOptions {
  const { values } = parseNodeArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      expanded: { type: "boolean", default: false },
      auth: { type: "boolean", default: false },
      profile: { type: "string", default: "default" },
      transport: { type: "string", default: "stdio" },
      port: { type: "string", default: "19826" },
      "browser-provider": { type: "string" },
      "browser-visibility": { type: "string" },
      "browser-profile-partition": { type: "string" },
      "browser-isolated": { type: "boolean", default: false },
      "browser-ephemeral": { type: "boolean", default: false },
      "browser-profile-id": { type: "string" },
    },
  });
  const profile = parseProfile(values.profile);
  return {
    expanded: values.expanded || profile === "expanded",
    transport: parseTransport(values.transport),
    port: parsePort(values.port),
    auth: values.auth,
    profile,
    browserPolicy: {
      provider: parseBrowserProvider(values["browser-provider"]),
      visibility: parseBrowserVisibility(values["browser-visibility"]),
      profilePartitionId: values["browser-profile-partition"],
      isolated: values["browser-isolated"],
      ephemeral: values["browser-ephemeral"],
      profileId: values["browser-profile-id"],
    },
  };
}

function parseProfile(value: string): string {
  if (
    value === "default" ||
    value === "deferred" ||
    value === "expanded" ||
    value === "computer-use"
  ) {
    return value;
  }
  throw new Error(
    `Invalid MCP profile "${value}"; expected default, deferred, expanded, or computer-use`,
  );
}

function parseTransport(value: string): ServerOptions["transport"] {
  if (value === "stdio" || value === "http" || value === "streamable") {
    return value;
  }
  if (value === "sse") return "streamable";
  throw new Error(
    `Invalid MCP transport "${value}"; expected stdio, http, or streamable`,
  );
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid MCP port "${value}"; expected 0-65535`);
  }
  return port;
}

function parseBrowserProvider(
  value: string | undefined,
): McpBrowserPolicyInput["provider"] {
  if (value === undefined) return undefined;
  if (value === "managed" || value === "chrome" || value === "remote") {
    return value;
  }
  throw new Error(
    `Invalid browser provider "${value}"; expected managed, chrome, or remote`,
  );
}

function parseBrowserVisibility(
  value: string | undefined,
): McpBrowserPolicyInput["visibility"] {
  if (value === undefined) return undefined;
  if (value === "hidden" || value === "background" || value === "foreground") {
    return value;
  }
  throw new Error(
    `Invalid browser visibility "${value}"; expected hidden, background, or foreground`,
  );
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  loadAllAdapters();
  await loadTsAdapters();

  const mode = opts.expanded ? "expanded" : opts.profile;
  const tools = opts.expanded
    ? buildExpandedTools()
    : selectTools(opts.profile);
  const prompts = opts.expanded ? [] : selectPrompts(opts.profile);
  // Streamable HTTP auto-activates deferred mode — remote clients benefit
  // most from searchHint-based discovery.
  if (
    opts.transport === "streamable" &&
    !opts.expanded &&
    opts.profile === "default"
  ) {
    const deferredTools = buildDeferredTools();
    tools.length = 0;
    tools.push(...deferredTools);
  }
  const browserPolicy = createMcpBrowserPolicy(opts.browserPolicy);
  const handler = buildHandler(tools, prompts, { browserPolicy });

  const adapterCount = getAllAdapters().length;
  const commandCount = listCommands().length;

  if (opts.transport === "http") {
    const httpPort = await startHttp(handler, opts.port, opts.auth);
    installSignalShutdown((reason) => stopHttp(httpPort, reason));
    const authLabel = opts.auth ? ", OAuth enabled" : "";
    process.stderr.write(
      `unicli MCP server v${VERSION} — ${adapterCount} sites, ${commandCount} commands (${tools.length} tools registered, mode=${mode}, ${formatBrowserPolicy(browserPolicy)}${authLabel})\n`,
    );
    return;
  }

  if (opts.transport === "streamable") {
    // v0.213.3 P3: streamable-http.Handler now returns
    // `Promise<JsonRpcResponse | undefined>`, so the pre-P3 cast-adapt
    // is gone — the types match the `undefined`-for-notification contract.
    const streamablePort = await startStreamableHttp(opts.port, handler, {
      auth: opts.auth,
    });
    installSignalShutdown((reason) =>
      stopStreamableHttp(streamablePort, reason),
    );
    const authLabel = opts.auth ? ", OAuth enabled" : "";
    process.stderr.write(
      `unicli MCP server v${VERSION} — ${adapterCount} sites, ${commandCount} commands (${tools.length} tools, mode=${mode}, transport=streamable, ${formatBrowserPolicy(browserPolicy)}${authLabel})\n`,
    );
    return;
  }

  process.stderr.write(
    `unicli MCP server v${VERSION} — ${adapterCount} sites, ${commandCount} commands (${tools.length} tools registered, mode=${mode}, ${formatBrowserPolicy(browserPolicy)})\n`,
  );
  startStdioTransport(handler);
}

function installSignalShutdown(close: (reason: string) => Promise<void>): void {
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void close(`MCP server received ${signal}`).then(
      () => process.exit(0),
      (error: unknown) => {
        process.stderr.write(
          `Fatal: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function formatBrowserPolicy(
  policy: ReturnType<typeof createMcpBrowserPolicy>,
): string {
  return `browser=${policy.provider}/${policy.visibility}, partition=${policy.profilePartitionId}`;
}

main().catch((err) => {
  process.stderr.write(
    `Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
