/**
 * Simple JSON-RPC over HTTP transport for MCP.
 *
 * POST /mcp accepts a single JSON-RPC envelope and returns a single JSON
 * response. GET /mcp returns server info — handy for health checks from a
 * browser.
 *
 * Note: this is intentionally NOT a full MCP Streamable HTTP transport —
 * no SSE event stream, no session resume. See `./streamable-http.ts` for
 * that. Most clients that "speak HTTP" to MCP only need request/response,
 * and starting with the simpler shape means zero new dependencies and a
 * tiny attack surface.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { getAllAdapters, listCommands } from "../registry.js";
import { handleOAuthRoute, createOAuthMiddleware } from "./oauth.js";
import { VERSION } from "../constants.js";
import type { JsonRpcRequest, buildHandler } from "./handler.js";

const MAX_BODY = 1_048_576; // 1 MB

function writeJson(res: ServerResponse, code: number, payload: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function serveHealth(res: ServerResponse): void {
  const adapterCount = getAllAdapters().length;
  const commandCount = listCommands().length;
  let expandedCount = 3;
  for (const adapter of getAllAdapters()) {
    expandedCount += Object.keys(adapter.commands).length;
  }
  writeJson(res, 200, {
    status: "ok",
    adapters: adapterCount,
    commands: commandCount,
    tools: { default: 3, expanded: expandedCount },
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
    const response = await handler(parsed);
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
): Promise<void> {
  const oauthMiddleware = authEnabled ? createOAuthMiddleware() : null;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
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

  process.stderr.write(
    `unicli MCP server v${VERSION} — HTTP transport on http://127.0.0.1:${port}/mcp\n`,
  );
}
