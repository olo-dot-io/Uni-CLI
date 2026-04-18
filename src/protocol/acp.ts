/**
 * ACP (Agent Client Protocol) server — JSON-RPC 2.0 over stdio.
 *
 * ACP is the protocol adopted by the Zed editor and Gemini CLI for agent ↔
 * editor integration. The canonical spec lives at
 * https://github.com/zed-industries/agent-client-protocol. Uni-CLI implements
 * a minimal ACP server so avante.nvim (and other ACP clients) can drive
 * `unicli` commands directly — the prompt is parsed for `unicli <site>
 * <cmd>` invocations and executed via the shared pipeline runner.
 *
 * Why a separate module from MCP:
 *   - ACP is editor-oriented (prompt/submit with streaming chunks, session
 *     lifecycle), MCP is tool-oriented (tools/list, tools/call).
 *   - ACP responses are natural-language chunks + final result; MCP is
 *     structured JSON only.
 *   - Keeping them orthogonal lets each evolve independently.
 *
 * Design assumptions (documented because the ACP schema is still evolving):
 *   - JSON-RPC 2.0 framing: newline-delimited frames on stdio. This matches
 *     `@agentclientprotocol/schema` convention and what Gemini CLI emits.
 *   - `initialize` returns `{capabilities, serverInfo, protocolVersion}` —
 *     mirrors MCP's shape for familiarity.
 *   - `prompt/submit` streams `content/updated` notifications for progress
 *     and returns a final `{content, sessionId, ok}` result.
 *   - `session/*` methods maintain an in-memory map keyed by client-chosen
 *     id. Sessions hold the last prompt + response for the client to resume
 *     or cancel. Persistence is out of scope for this shim.
 *
 * All non-protocol output (errors, logs) MUST go to stderr — stdout is
 * reserved for JSON-RPC frames only.
 */

import { createInterface, type Interface } from "node:readline";
import { randomUUID } from "node:crypto";
import { VERSION } from "../constants.js";
import { resolveCommand } from "../registry.js";
import {
  parseUnicliInvocation,
  runCommand,
  suggestCommands,
  summarizeResults,
} from "./acp-helpers.js";

// Re-export ACP pure helpers — callers that used to import them from
// `./acp.js` (tests, downstream tooling) keep working unchanged.
export {
  parseUnicliInvocation,
  runCommand,
  suggestCommands,
} from "./acp-helpers.js";
export type { ParsedInvocation } from "./acp-helpers.js";

// ── JSON-RPC types ──────────────────────────────────────────────────────────

export interface AcpRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface AcpRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface AcpRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

// ── Session state ───────────────────────────────────────────────────────────

export interface AcpSession {
  id: string;
  createdAt: number;
  lastPrompt?: string;
  lastResult?: unknown;
  cancelled?: boolean;
}

export interface AcpServerOptions {
  /** Logger for stderr output. Defaults to process.stderr.write. */
  log?: (message: string) => void;
  /** Emit a JSON-RPC response or notification frame. Defaults to stdout. */
  emit?: (frame: AcpRpcResponse | AcpRpcNotification) => void;
  /** Enable verbose debug logging to stderr. */
  debug?: boolean;
}

// ── Server ──────────────────────────────────────────────────────────────────

export class AcpServer {
  private sessions = new Map<string, AcpSession>();
  private log: (message: string) => void;
  private emit: (frame: AcpRpcResponse | AcpRpcNotification) => void;
  private debug: boolean;
  private initialized = false;

  constructor(opts: AcpServerOptions = {}) {
    this.log =
      opts.log ??
      ((m: string) => {
        process.stderr.write(m.endsWith("\n") ? m : m + "\n");
      });
    this.emit =
      opts.emit ??
      ((frame) => {
        process.stdout.write(JSON.stringify(frame) + "\n");
      });
    this.debug = opts.debug === true;
  }

  /**
   * Handle a single JSON-RPC frame. Returns the response to emit, or
   * `undefined` for notifications (no id → no reply).
   *
   * Public so the stdio loop and tests can drive the dispatch directly.
   */
  async handle(req: AcpRpcRequest): Promise<AcpRpcResponse | undefined> {
    const id = req.id ?? null;

    // Notifications have no id — we still dispatch them but return nothing.
    const isNotification = req.id === undefined || req.id === null;

    if (this.debug) {
      this.log(`[acp] → ${req.method}`);
    }

    try {
      switch (req.method) {
        case "initialize":
          return this.handleInitialize(id, req.params ?? {});
        case "initialized":
        case "notifications/initialized":
          // No response expected for the initialized notification.
          return undefined;
        case "authenticate":
          return this.handleAuthenticate(id, req.params ?? {});
        case "prompt/submit":
        case "sendUserMessage":
          // Accept both the canonical ACP name and the Zed legacy alias.
          return await this.handlePromptSubmit(id, req.params ?? {});
        case "session/create":
        case "newSession":
          return this.handleSessionCreate(id, req.params ?? {});
        case "session/cancel":
        case "cancelSendMessage":
          return this.handleSessionCancel(id, req.params ?? {});
        case "session/list":
          return this.handleSessionList(id);
        case "ping":
          return { jsonrpc: "2.0", id, result: {} };
        case "shutdown":
          return { jsonrpc: "2.0", id, result: {} };
        default:
          if (isNotification) return undefined;
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: `Method not found: ${req.method}`,
            },
          };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`[acp] handler error: ${message}`);
      if (isNotification) return undefined;
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: `Internal error: ${message}` },
      };
    }
  }

  // ── Method handlers ──────────────────────────────────────────────────────

  private handleInitialize(
    id: number | string | null,
    _params: Record<string, unknown>,
  ): AcpRpcResponse {
    this.initialized = true;
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2026-03-27",
        capabilities: {
          /** This server can execute `unicli <site> <cmd>` invocations. */
          exec: true,
          /** Prompts may reference MCP tools (passed through to MCP gateway). */
          mcp: true,
          /** Prompts may request a semantic search over the adapter catalog. */
          search: true,
          /** Streaming text chunks via `content/updated` notifications. */
          streaming: true,
        },
        serverInfo: {
          name: "unicli",
          version: VERSION,
        },
      },
    };
  }

  private handleAuthenticate(
    id: number | string | null,
    _params: Record<string, unknown>,
  ): AcpRpcResponse {
    // ACP requires an authenticate method even when the server has no real
    // auth. We accept any payload and return success — cookie-backed adapters
    // resolve creds per-call through ~/.unicli/cookies.
    return {
      jsonrpc: "2.0",
      id,
      result: { ok: true, method: "none" },
    };
  }

  private handleSessionCreate(
    id: number | string | null,
    params: Record<string, unknown>,
  ): AcpRpcResponse {
    const providedId =
      typeof params.id === "string" && params.id.length > 0
        ? params.id
        : randomUUID();
    const session: AcpSession = {
      id: providedId,
      createdAt: Date.now(),
    };
    this.sessions.set(providedId, session);
    return {
      jsonrpc: "2.0",
      id,
      result: { sessionId: providedId, createdAt: session.createdAt },
    };
  }

  private handleSessionCancel(
    id: number | string | null,
    params: Record<string, unknown>,
  ): AcpRpcResponse {
    const sessionId = params.sessionId as string | undefined;
    if (!sessionId) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: "sessionId required" },
      };
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `Unknown session: ${sessionId}` },
      };
    }
    session.cancelled = true;
    return { jsonrpc: "2.0", id, result: { cancelled: true } };
  }

  private handleSessionList(id: number | string | null): AcpRpcResponse {
    const sessions = Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      cancelled: s.cancelled === true,
      hasResult: s.lastResult !== undefined,
    }));
    return { jsonrpc: "2.0", id, result: { sessions } };
  }

  private async handlePromptSubmit(
    id: number | string | null,
    params: Record<string, unknown>,
  ): Promise<AcpRpcResponse> {
    const prompt =
      typeof params.prompt === "string"
        ? params.prompt
        : typeof params.text === "string"
          ? params.text
          : "";
    const sessionId = this.ensureSession(
      params.sessionId as string | undefined,
    );

    if (!prompt.trim()) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: "prompt is required" },
      };
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: `Session missing: ${sessionId}` },
      };
    }
    session.lastPrompt = prompt;

    // Notify the client that we started processing.
    this.emit({
      jsonrpc: "2.0",
      method: "content/updated",
      params: {
        sessionId,
        chunk: { type: "text", text: `unicli: running "${prompt}"…\n` },
      },
    });

    const parsed = parseUnicliInvocation(prompt);
    if (!parsed) {
      const hint = suggestCommands(prompt);
      session.lastResult = { ok: false, error: "no unicli invocation" };
      this.emit({
        jsonrpc: "2.0",
        method: "content/updated",
        params: {
          sessionId,
          chunk: {
            type: "text",
            text: `No \`unicli <site> <command>\` invocation found in prompt.\nSuggestions:\n${hint}\n`,
          },
        },
      });
      return {
        jsonrpc: "2.0",
        id,
        result: {
          sessionId,
          ok: false,
          content: [
            {
              type: "text",
              text: `No \`unicli <site> <command>\` invocation found.`,
            },
          ],
          suggestions: hint.split("\n").filter((l) => l.length > 0),
        },
      };
    }

    const { site, command, args } = parsed;
    const resolved = resolveCommand(site, command);
    if (!resolved) {
      session.lastResult = { ok: false, error: "unknown command" };
      this.emit({
        jsonrpc: "2.0",
        method: "content/updated",
        params: {
          sessionId,
          chunk: {
            type: "text",
            text: `Unknown command: ${site} ${command}\n`,
          },
        },
      });
      return {
        jsonrpc: "2.0",
        id,
        result: {
          sessionId,
          ok: false,
          content: [
            {
              type: "text",
              text: `Unknown command: \`unicli ${site} ${command}\`. Run \`unicli list --site ${site}\`.`,
            },
          ],
        },
      };
    }

    const { adapter, command: cmd } = resolved;

    this.emit({
      jsonrpc: "2.0",
      method: "tool/progress",
      params: {
        sessionId,
        tool: `unicli ${site} ${command}`,
        state: "running",
      },
    });

    try {
      const results = await runCommand(adapter, cmd, args);
      session.lastResult = results;

      const summary = summarizeResults(results, site, command);

      this.emit({
        jsonrpc: "2.0",
        method: "content/updated",
        params: {
          sessionId,
          chunk: { type: "text", text: summary + "\n" },
        },
      });
      this.emit({
        jsonrpc: "2.0",
        method: "tool/progress",
        params: {
          sessionId,
          tool: `unicli ${site} ${command}`,
          state: "done",
        },
      });

      return {
        jsonrpc: "2.0",
        id,
        result: {
          sessionId,
          ok: true,
          content: [{ type: "text", text: summary }],
          data: results,
          count: Array.isArray(results) ? results.length : undefined,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      session.lastResult = { ok: false, error: message };
      this.emit({
        jsonrpc: "2.0",
        method: "tool/progress",
        params: {
          sessionId,
          tool: `unicli ${site} ${command}`,
          state: "error",
          error: message,
        },
      });
      return {
        jsonrpc: "2.0",
        id,
        result: {
          sessionId,
          ok: false,
          content: [{ type: "text", text: `Error: ${message}` }],
          error: message,
        },
      };
    }
  }

  // ── Utility ──────────────────────────────────────────────────────────────

  private ensureSession(maybeId: string | undefined): string {
    if (maybeId && this.sessions.has(maybeId)) return maybeId;
    const newId = maybeId && maybeId.length > 0 ? maybeId : randomUUID();
    this.sessions.set(newId, { id: newId, createdAt: Date.now() });
    return newId;
  }

  /** Primarily for tests — surface the in-memory sessions. */
  getSessions(): AcpSession[] {
    return Array.from(this.sessions.values());
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Start reading JSON-RPC frames from stdin until EOF. Resolves when
   * stdin closes. Errors in individual frames are reported as JSON-RPC
   * error envelopes; fatal I/O errors reject the returned promise.
   */
  async startStdio(
    input: NodeJS.ReadableStream = process.stdin,
  ): Promise<void> {
    const rl: Interface = createInterface({
      input,
      terminal: false,
    });

    return new Promise<void>((resolve, reject) => {
      rl.on("line", async (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        let req: AcpRpcRequest;
        try {
          req = JSON.parse(trimmed) as AcpRpcRequest;
        } catch {
          this.emit({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          });
          return;
        }

        try {
          const response = await this.handle(req);
          if (response) this.emit(response);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.emit({
            jsonrpc: "2.0",
            id: req.id ?? null,
            error: { code: -32603, message: `Internal error: ${message}` },
          });
        }
      });

      rl.on("close", () => resolve());
      rl.on("error", (err) => reject(err));
    });
  }
}
