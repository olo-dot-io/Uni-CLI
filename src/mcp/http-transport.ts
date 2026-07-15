/**
 * @owner       src/mcp/http-transport.ts
 * @does        Serve bounded request/response MCP JSON-RPC over loopback HTTP with origin and browser-session identity guards.
 * @needs       node:http/crypto, MCP handler/tools/oauth/origin guard, registry, constants
 * @feeds       simple `unicli mcp --http` clients and health probes
 * @breaks      Invalid origins, oversized/invalid bodies, and handler failures return bounded HTTP/JSON-RPC errors.
 * @invariants  POST bodies are capped at 1 MiB; every request carries an MCP session id into tool dispatch; foreign origins never route.
 * @side-effects Listens on a local HTTP socket, processes OAuth routes, and writes responses/stderr startup evidence.
 * @perf        One buffered parse and one handler dispatch per POST; no SSE/session-resume state.
 * @concurrency Node HTTP may overlap requests; per-request browser identity is passed explicitly.
 * @test        tests/unit/mcp/http-transport.test.ts, tests/unit/mcp-browser-invocation.test.ts
 * @stability   stable
 * @since       2026-04-01
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { getAllAdapters, listCommands } from "../registry.js";
import { isOriginAllowed } from "./origin-guard.js";
import { handleOAuthRoute, createOAuthMiddleware } from "./oauth.js";
import { VERSION } from "../constants.js";
import { buildDefaultTools } from "./tools.js";
import type { JsonRpcRequest, buildHandler } from "./handler.js";

const MAX_BODY = 1_048_576; // 1 MB

function writeJson(res: ServerResponse, code: number, payload: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function serveHealth(res: ServerResponse): void {
  const adapterCount = getAllAdapters().length;
  const commandCount = listCommands().length;
  const defaultToolCount = buildDefaultTools().length;
  const expandedCount = commandCount + defaultToolCount;
  writeJson(res, 200, {
    status: "ok",
    adapters: adapterCount,
    commands: commandCount,
    tools: { default: defaultToolCount, expanded: expandedCount },
    version: VERSION,
  });
}

async function consumeBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let bodySize = 0;
  return await new Promise<Buffer | null>((resolve) => {
    req.on("data", (chunk: Buffer) => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY) {
        writeJson(res, 413, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Request too large" },
        });
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(null));
  });
}

async function dispatchPost(
  req: IncomingMessage,
  res: ServerResponse,
  handler: ReturnType<typeof buildHandler>,
): Promise<void> {
  const bodyBuf = await consumeBody(req, res);
  if (!bodyBuf) return;
  const body = bodyBuf.toString("utf-8");
  let parsed: JsonRpcRequest;
  try {
    parsed = JSON.parse(body) as JsonRpcRequest;
  } catch {
    writeJson(res, 400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    return;
  }
  try {
    const response = await handler(parsed, {
      transport: "mcp-http",
      mcpSessionId:
        typeof req.headers["mcp-session-id"] === "string"
          ? req.headers["mcp-session-id"]
          : randomUUID(),
    });
    if (!response) {
      res.writeHead(204);
      res.end();
      return;
    }
    writeJson(res, 200, response);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeJson(res, 500, {
      jsonrpc: "2.0",
      id: parsed.id ?? null,
      error: { code: -32603, message: `Internal error: ${message}` },
    });
  }
}

export async function startHttp(
  handler: ReturnType<typeof buildHandler>,
  port: number,
  authEnabled = false,
): Promise<Server> {
  const oauthMiddleware = authEnabled ? createOAuthMiddleware() : null;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // DNS-rebinding guard: reject browser pages on a non-loopback origin
    // before any routing, so a malicious site cannot drive tools/call.
    if (!isOriginAllowed(req)) {
      writeJson(res, 403, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Forbidden: invalid Origin" },
      });
      return;
    }
    if (authEnabled && handleOAuthRoute(req, res)) return;
    if (
      req.method === "GET" &&
      (req.url === "/" || req.url === "/mcp" || req.url === "/health")
    ) {
      serveHealth(res);
      return;
    }
    if (req.method !== "POST" || req.url !== "/mcp") {
      writeJson(res, 404, { error: "POST /mcp" });
      return;
    }
    if (oauthMiddleware?.(req, res)) return;
    void dispatchPost(req, res, handler);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  const boundPort = addr && typeof addr === "object" ? addr.port : port;
  process.stderr.write(
    `unicli MCP server v${VERSION} — HTTP transport on http://127.0.0.1:${boundPort}/mcp\n`,
  );

  return server;
}
