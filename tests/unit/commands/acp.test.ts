/**
 * `unicli acp` CLI wiring tests — spawn the CLI as a subprocess and verify
 * the ACP server answers an `initialize` frame over stdio. This exercises
 * the full stack: cli.ts registration → commands/acp.ts handler →
 * protocol/acp.ts AcpServer → stdio transport.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, "..", "..", "..", "src", "main.ts");

/**
 * Send a single JSON-RPC frame to the subprocess and wait for the
 * response whose id matches. Mirrors the helper in mcp-server.test.ts.
 */
function sendRequest(
  proc: ChildProcess,
  request: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("ACP response timeout")),
      timeoutMs,
    );
    let buffer = "";
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          if (parsed.id === request.id) {
            clearTimeout(timeout);
            proc.stdout!.off("data", onData);
            resolve(parsed);
            return;
          }
        } catch {
          // Not a full JSON frame yet — keep buffering.
        }
      }
    };
    proc.stdout!.on("data", onData);
    proc.stdin!.write(JSON.stringify(request) + "\n");
  });
}

describe("unicli acp — CLI subprocess integration", () => {
  let proc: ChildProcess;

  beforeAll(async () => {
    proc = spawn("npx", ["tsx", CLI_PATH, "acp"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: join(__dirname, "..", "..", ".."),
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("ACP server start timeout")),
        20_000,
      );
      proc.stderr!.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("ACP server")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }, 30_000);

  afterAll(() => {
    if (proc && !proc.killed) proc.kill();
  });

  it("responds to initialize with serverInfo + capabilities", async () => {
    const response = await sendRequest(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(1);
    const result = response.result as Record<string, unknown>;
    expect(result.serverInfo).toEqual(
      expect.objectContaining({ name: "unicli" }),
    );
    expect(result.capabilities).toEqual(
      expect.objectContaining({ exec: true, mcp: true, search: true }),
    );
  });

  it("returns error envelope for an unknown method", async () => {
    const response = await sendRequest(proc, {
      jsonrpc: "2.0",
      id: 2,
      method: "definitely-not-a-method",
    });
    expect(response.error).toBeDefined();
    const err = response.error as { code: number };
    expect(err.code).toBe(-32601);
  });

  it("creates and lists sessions over stdio", async () => {
    await sendRequest(proc, {
      jsonrpc: "2.0",
      id: 3,
      method: "session/create",
      params: { id: "integration-session" },
    });
    const listRes = await sendRequest(proc, {
      jsonrpc: "2.0",
      id: 4,
      method: "session/list",
    });
    const result = listRes.result as {
      sessions: Array<{ id: string }>;
    };
    const ids = result.sessions.map((s) => s.id);
    expect(ids).toContain("integration-session");
  });
});
