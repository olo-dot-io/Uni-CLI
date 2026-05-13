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
 *   - `./streamable-http/`  — Streamable HTTP transport (MCP spec 2025-11-25)
 *
 * Three modes:
 *   - default   (~200 tokens)  — 4 meta-tools only
 *   - deferred  (~8K tokens)   — stubs for ToolSearch-aware clients
 *   - expanded  (~160K tokens) — one tool per adapter command
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
  buildExpandedTools,
  buildDeferredTools,
  selectPrompts,
  selectTools,
} from "./tools.js";
import {
  buildHandler,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./handler.js";
import { startHttp } from "./http-transport.js";
import { startStreamableHttp } from "./streamable-http/index.js";

export { annotateIfLarge } from "./dispatch.js";

interface ServerOptions {
  expanded: boolean;
  transport: "stdio" | "http" | "streamable";
  port: number;
  auth: boolean;
  profile: string;
}

function parseArgs(argv: string[]): ServerOptions {
  const opts: ServerOptions = {
    expanded: false,
    transport: "stdio",
    port: 19826,
    auth: false,
    profile: "default",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--expanded") opts.expanded = true;
    else if (a === "--auth") opts.auth = true;
    else if (a === "--profile") {
      opts.profile = argv[++i] || "default";
      if (opts.profile === "expanded") opts.expanded = true;
    } else if (a === "--transport") {
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
  let pending = 0;
  let inputClosed = false;

  const exitIfDrained = () => {
    if (inputClosed && pending === 0) {
      process.exit(0);
    }
  };

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

    pending++;
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
    } finally {
      pending--;
      exitIfDrained();
    }
  });

  rl.on("close", () => {
    inputClosed = true;
    exitIfDrained();
  });
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
  const handler = buildHandler(tools, prompts);

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
    // v0.213.3 P3: streamable-http.Handler now returns
    // `Promise<JsonRpcResponse | undefined>`, so the pre-P3 cast-adapt
    // is gone — the types match the `undefined`-for-notification contract.
    await startStreamableHttp(opts.port, handler, { auth: opts.auth });
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
