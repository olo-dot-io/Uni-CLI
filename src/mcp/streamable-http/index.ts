/**
 * @owner       src::mcp::streamable-http
 * @does        Serve one MCP 2025-11-25 Streamable HTTP runtime with authenticated session ownership, cross-connection cancellation, and awaited teardown.
 * @needs       node:http, OAuth middleware, POST dispatcher, shared session state
 * @feeds       Uni-CLI MCP HTTP server and tests
 * @breaks      Returning from DELETE/server close before handler containment can discard a committed task result or let a detached mutation continue.
 * @invariants  Every route validates Origin; GET /mcp is 405 when no server stream exists; DELETE validates protocol/principal and removes authority before containment; explicit cancellation is session/id scoped; socket loss is not cancellation; server close stops intake and awaits requests plus tasks; no transport-private task protocol exists.
 * @side-effects Listens on loopback HTTP, owns one pruning timer/session registry, and awaits handler lifecycle hooks.
 * @perf        One HTTP server and one unref'd bounded pruning timer.
 * @concurrency Requests overlap on the event loop; shutdown is idempotent and represented by one shared Promise.
 * @test        tests/unit/streamable-http.test.ts, tests/unit/mcp-browser-invocation.test.ts
 * @stability   stable
 * @since       2026-04-01
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import { MCP_PROTOCOL_VERSION, VERSION } from "../../constants.js";
import {
  createOAuthMiddleware,
  getAuthenticatedPrincipal,
  handleOAuthRoute,
} from "../oauth.js";
import { handlePost } from "./handle-post.js";
import { StreamableRequestRegistry } from "./request-registry.js";
import {
  ALLOWED_ORIGINS,
  HEARTBEAT_MS,
  isOriginAllowed,
  jsonResponse,
  PRUNE_INTERVAL_MS,
  pruneStaleSessions,
  SESSION_TTL_MS,
  sessions,
  type Handler,
  type StreamableHttpOptions,
} from "./session.js";

interface StreamableHttpRuntime {
  readonly port: number;
  close(reason?: string): Promise<void>;
}

let activeServer: StreamableHttpRuntime | undefined;

async function handleDelete(
  req: IncomingMessage,
  res: ServerResponse,
  handler: Handler,
  activeRequests: StreamableRequestRegistry,
): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session) {
    jsonResponse(
      res,
      404,
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32_600, message: "Invalid or missing MCP-Session-Id" },
      },
      undefined,
      req,
    );
    return;
  }
  if (session.principalId !== getAuthenticatedPrincipal(req)) {
    jsonResponse(
      res,
      403,
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32_600,
          message: "MCP session belongs to a different authenticated client",
        },
      },
      undefined,
      req,
    );
    return;
  }
  const protocolVersion = req.headers["mcp-protocol-version"];
  if (protocolVersion !== MCP_PROTOCOL_VERSION) {
    jsonResponse(
      res,
      400,
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32_600,
          message:
            protocolVersion === undefined
              ? "Missing MCP-Protocol-Version header"
              : `Unsupported protocol version: ${String(protocolVersion)}`,
        },
      },
      undefined,
      req,
    );
    return;
  }
  sessions.delete(sessionId!);
  await Promise.all([
    activeRequests.closeSession(sessionId!, "MCP session terminated"),
    handler.closeSession?.(sessionId!, "MCP session terminated") ??
      Promise.resolve(),
  ]);
  res.writeHead(204);
  res.end();
}

function handleOptions(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  const allowedOrigin =
    origin && isOriginAllowed(req) ? origin : "http://localhost";
  res.writeHead(204, {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, MCP-Session-Id, MCP-Protocol-Version, Authorization, Accept",
    "Access-Control-Expose-Headers": "MCP-Session-Id, MCP-Protocol-Version",
    "Access-Control-Max-Age": "86400",
  });
  res.end();
}

function route(
  req: IncomingMessage,
  res: ServerResponse,
  handler: Handler,
  oauthMiddleware:
    | ((req: IncomingMessage, res: ServerResponse) => boolean)
    | null,
  auth: boolean | undefined,
  activeRequests: StreamableRequestRegistry,
): void {
  const method = req.method ?? "";
  const pathname = (req.url ?? "/").split("?")[0];
  if (!isOriginAllowed(req)) {
    jsonResponse(
      res,
      403,
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32_600, message: "Forbidden: invalid Origin" },
      },
      undefined,
      req,
    );
    return;
  }
  if (method === "OPTIONS") {
    handleOptions(req, res);
    return;
  }
  if (auth && handleOAuthRoute(req, res)) return;
  if (method === "GET" && (pathname === "/health" || pathname === "/")) {
    jsonResponse(
      res,
      200,
      {
        status: "ok",
        transport: "streamable-http",
        version: VERSION,
        sessions: sessions.size,
        protocolVersion: MCP_PROTOCOL_VERSION,
      },
      undefined,
      req,
    );
    return;
  }
  if (pathname === "/mcp") {
    if (oauthMiddleware?.(req, res)) return;
    if (method === "GET") {
      res.writeHead(405, {
        Allow: "POST, DELETE",
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    if (method === "POST") {
      void handlePost(req, res, handler, activeRequests).catch(
        (error: unknown) => {
          if (!res.writableEnded && !res.destroyed) {
            jsonResponse(
              res,
              500,
              {
                jsonrpc: "2.0",
                id: null,
                error: {
                  code: -32_603,
                  message: `Unexpected server error: ${error instanceof Error ? error.message : String(error)}`,
                },
              },
              undefined,
              req,
            );
          }
        },
      );
      return;
    }
    if (method === "DELETE") {
      void handleDelete(req, res, handler, activeRequests).catch(
        (error: unknown) => {
          if (!res.writableEnded && !res.destroyed) {
            jsonResponse(
              res,
              500,
              {
                jsonrpc: "2.0",
                id: null,
                error: {
                  code: -32_603,
                  message: `Session teardown failed: ${error instanceof Error ? error.message : String(error)}`,
                },
              },
              undefined,
              req,
            );
          }
        },
      );
      return;
    }
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}

export async function startStreamableHttp(
  port: number,
  handler: Handler,
  options?: StreamableHttpOptions,
): Promise<number> {
  if (activeServer) {
    throw new Error("A Streamable HTTP MCP server is already running");
  }
  sessions.clear();
  const activeRequests = new StreamableRequestRegistry();
  const oauthMiddleware = options?.auth ? createOAuthMiddleware() : null;
  const prune = (): void => {
    void pruneStaleSessions((sessionId, reason) =>
      Promise.all([
        activeRequests.closeSession(sessionId, reason),
        handler.closeSession?.(sessionId, reason) ?? Promise.resolve(),
      ]).then(() => undefined),
    ).catch((error: unknown) => {
      process.stderr.write(
        `MCP session expiry containment failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
  };
  const pruneTimer = setInterval(prune, PRUNE_INTERVAL_MS);
  pruneTimer.unref();
  const server = createServer((req, res) =>
    route(req, res, handler, oauthMiddleware, options?.auth, activeRequests),
  );
  try {
    await listen(server, port);
  } catch (error) {
    clearInterval(pruneTimer);
    throw error;
  }
  const address = server.address();
  const boundPort =
    address && typeof address === "object" ? address.port : port;
  let closePromise: Promise<void> | undefined;
  const runtime: StreamableHttpRuntime = {
    port: boundPort,
    close(reason = "MCP server stopped"): Promise<void> {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        clearInterval(pruneTimer);
        const stopped = closeNodeServer(server);
        sessions.clear();
        const containment = Promise.all([
          activeRequests.closeAll(reason),
          handler.closeAll?.(reason) ?? Promise.resolve(),
        ]);
        const [stopResult, containmentResult] = await Promise.allSettled([
          stopped,
          containment,
        ]);
        if (activeServer === runtime) activeServer = undefined;
        if (stopResult.status === "rejected") throw stopResult.reason;
        if (containmentResult.status === "rejected") {
          throw containmentResult.reason;
        }
      })();
      return closePromise;
    },
  };
  activeServer = runtime;

  process.stderr.write(
    `unicli MCP server v${VERSION} — Streamable HTTP transport on http://127.0.0.1:${boundPort}\n` +
      `  MCP endpoint: GET/POST/DELETE http://127.0.0.1:${boundPort}/mcp\n` +
      `  Health check: GET             http://127.0.0.1:${boundPort}/health\n` +
      `  Protocol:     ${MCP_PROTOCOL_VERSION}\n`,
  );
  return runtime.port;
}

export function stopStreamableHttp(
  port: number,
  reason = "MCP server stopped",
): Promise<void> {
  if (!activeServer) return Promise.resolve();
  if (activeServer.port !== port) {
    return Promise.reject(
      new Error(`No Streamable HTTP MCP server is running on port ${port}`),
    );
  }
  return activeServer.close(reason);
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (error: Error): void => reject(error);
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", fail);
      resolve();
    });
  });
}

function closeNodeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export type { Handler, StreamableHttpOptions } from "./session.js";

export const _test = {
  sessions,
  pruneStaleSessions,
  isOriginAllowed,
  ALLOWED_ORIGINS,
  SESSION_TTL_MS,
  HEARTBEAT_MS,
  MCP_PROTOCOL_VERSION,
} as const;
