#!/usr/bin/env node

/**
 * MCP (Model Context Protocol) server entry point for Uni-CLI.
 *
 * Thin bootstrap: load adapters → build tool list → wire the transport →
 * start serving. The meat lives in sibling modules:
 *   - `./tools.ts`          — tool-definition builders (default/expanded/deferred)
 *   - `./dispatch.ts`       — kernel-backed tool-call dispatcher
 *   - `./handler.ts`        — JSON-RPC method dispatch
 *   - `./http-transport.ts` — POST /mcp transport
 *   - `./streamable-http.ts`— Streamable HTTP transport (MCP spec 2025-03-26)
 *
 * Three modes:
 *   - default   (~200 tokens)  — 4 meta-tools only
 *   - expanded  (~160K tokens) — one tool per adapter command
 *   - deferred  (~8K tokens)   — stubs for ToolSearch-aware clients
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

import { createInterface } from "node:readline";
import { loadAllAdapters, loadTsAdapters } from "../discovery/loader.js";
import { getAllAdapters, listCommands } from "../registry.js";
import { VERSION } from "../constants.js";
import {
  buildDefaultTools,
  buildExpandedTools,
  buildDeferredTools,
} from "./tools.js";
import {
  buildHandler,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./handler.js";
import { startHttp } from "./http-transport.js";
import { startStreamableHttp } from "./streamable-http.js";

export { annotateIfLarge } from "./dispatch.js";

interface ServerOptions {
  expanded: boolean;
  transport: "stdio" | "http" | "streamable";
  port: number;
  auth: boolean;
}

function parseArgs(argv: string[]): ServerOptions {
  const opts: ServerOptions = {
    expanded: false,
    transport: "stdio",
    port: 19826,
    auth: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--expanded") opts.expanded = true;
    else if (a === "--auth") opts.auth = true;
    else if (a === "--transport") {
      const v = argv[++i];
      if (v === "stdio" || v === "http" || v === "streamable") {
        opts.transport = v;
      } else if (v === "sse") {
        // Deprecated alias — SSE replaced by Streamable HTTP in spec 2025-03-26
        opts.transport = "streamable";
      }
    } else if (a === "--port") {
      const v = parseInt(argv[++i], 10);
      if (Number.isFinite(v)) opts.port = v;
    }
  }
  return opts;
}

function send(response: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(response) + "\n");
}

async function startStdio(
  handler: ReturnType<typeof buildHandler>,
): Promise<void> {
  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on("line", async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }

    try {
      const response = await handler(req);
      if (response) send(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send({
        jsonrpc: "2.0",
        id: req.id ?? null,
        error: { code: -32603, message: `Internal error: ${message}` },
      });
    }
  });

  rl.on("close", () => {
    process.exit(0);
  });
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  loadAllAdapters();
  await loadTsAdapters();

  const mode = opts.expanded ? "expanded" : "default";
  const tools = opts.expanded ? buildExpandedTools() : buildDefaultTools();
  // Streamable HTTP auto-activates deferred mode — remote clients benefit
  // most from searchHint-based discovery.
  if (opts.transport === "streamable" && !opts.expanded) {
    const deferredTools = buildDeferredTools();
    tools.length = 0;
    tools.push(...deferredTools);
  }
  const handler = buildHandler(tools);

  const adapterCount = getAllAdapters().length;
  const commandCount = listCommands().length;

  if (opts.transport === "http") {
    await startHttp(handler, opts.port, opts.auth);
    const authLabel = opts.auth ? ", OAuth enabled" : "";
    process.stderr.write(
      `unicli MCP server v${VERSION} — ${adapterCount} sites, ${commandCount} commands (${tools.length} tools registered, mode=${mode}${authLabel})\n`,
    );
    return;
  }

  if (opts.transport === "streamable") {
    // Streamable HTTP's Handler type still returns JsonRpcResponse (non-optional).
    // Our handler returns undefined for notifications — which streamable-http
    // guards against via `if (!response)` checks, but the types don't reflect
    // that yet. Cast-adapt until streamable-http.ts is refactored to widen.
    await startStreamableHttp(
      opts.port,
      handler as unknown as Parameters<typeof startStreamableHttp>[1],
      { auth: opts.auth },
    );
    const authLabel = opts.auth ? ", OAuth enabled" : "";
    process.stderr.write(
      `unicli MCP server v${VERSION} — ${adapterCount} sites, ${commandCount} commands (${tools.length} tools, mode=${mode}, transport=streamable${authLabel})\n`,
    );
    return;
  }

  await startStdio(handler);
  process.stderr.write(
    `unicli MCP server v${VERSION} — ${adapterCount} sites, ${commandCount} commands (${tools.length} tools registered, mode=${mode})\n`,
  );
}

main().catch((err) => {
  process.stderr.write(
    `Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
