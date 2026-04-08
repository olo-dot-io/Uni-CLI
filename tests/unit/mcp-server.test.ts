import { describe, it, expect, beforeAll } from "vitest";
import { ChildProcess, spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "..", "..", "src", "mcp", "server.ts");

/**
 * Send a JSON-RPC request to the MCP server and read the response.
 * Buffers stdout across chunks and splits on newlines to handle
 * large responses that arrive in multiple data events.
 */
function sendRequest(
  proc: ChildProcess,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("MCP response timeout")),
      10_000,
    );

    let buffer = "";

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();

      // Split on newlines — keep last (possibly incomplete) part in buffer
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
          // Incomplete or non-JSON line, skip
        }
      }
    };

    proc.stdout!.on("data", onData);
    proc.stdin!.write(JSON.stringify(request) + "\n");
  });
}

describe("MCP server", () => {
  let proc: ChildProcess;

  beforeAll(async () => {
    // The default mode in v0.208 expands every adapter into its own MCP tool.
    // This file pins the LAZY mode (`--lazy`) so the existing 2-tool contract
    // is exercised. Expanded mode is covered in `mcp-server-expanded.test.ts`.
    proc = spawn("npx", ["tsx", SERVER_PATH, "--lazy"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: join(__dirname, "..", ".."),
    });

    // Wait for server to start (stderr message)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Server start timeout")),
        15_000,
      );
      proc.stderr!.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("MCP server")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    return () => {
      proc.kill();
    };
  });

  it("responds to initialize with server info", async () => {
    const response = await sendRequest(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    });

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(1);

    const result = response.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe("2024-11-05");
    expect(result.serverInfo).toEqual(
      expect.objectContaining({ name: "unicli" }),
    );
    expect(result.capabilities).toEqual(expect.objectContaining({ tools: {} }));
  });

  it("lists exactly 2 core tools (lazy registration)", async () => {
    const response = await sendRequest(proc, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    const result = response.result as { tools: Array<{ name: string }> };
    expect(result.tools).toHaveLength(2);

    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(["list_adapters", "run_command"]);
  });

  it("list_adapters returns adapter catalog", { timeout: 15_000 }, async () => {
    const response = await sendRequest(proc, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "list_adapters",
        arguments: {},
      },
    });

    const result = response.result as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");

    const data = JSON.parse(result.content[0].text) as {
      total_sites: number;
      total_commands: number;
    };
    expect(data.total_sites).toBeGreaterThan(0);
    expect(data.total_commands).toBeGreaterThan(0);
  });

  it("list_adapters filters by site name", async () => {
    const response = await sendRequest(proc, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "list_adapters",
        arguments: { site: "hackernews" },
      },
    });

    const result = response.result as {
      content: Array<{ type: string; text: string }>;
    };
    const data = JSON.parse(result.content[0].text) as {
      total_sites: number;
      adapters: Array<{ site: string }>;
    };
    expect(data.total_sites).toBe(1);
    expect(data.adapters[0].site).toBe("hackernews");
  });

  it("run_command returns error for unknown command", async () => {
    const response = await sendRequest(proc, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "run_command",
        arguments: { site: "nonexistent", command: "nope" },
      },
    });

    const result = response.result as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };
    expect(result.isError).toBe(true);

    const data = JSON.parse(result.content[0].text) as { error: string };
    expect(data.error).toContain("Unknown command");
  });

  it("returns error for unknown tool name", async () => {
    const response = await sendRequest(proc, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "fake_tool",
        arguments: {},
      },
    });

    expect(response.error).toBeDefined();
    const error = response.error as { code: number; message: string };
    expect(error.code).toBe(-32601);
    expect(error.message).toContain("Unknown tool");
  });

  it("responds to ping", async () => {
    const response = await sendRequest(proc, {
      jsonrpc: "2.0",
      id: 7,
      method: "ping",
    });

    expect(response.result).toEqual({});
  });

  it("returns parse error for invalid JSON", async () => {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout")), 5_000);
      let buffer = "";
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString();
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          const trimmed = part.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed) as Record<string, unknown>;
            if (parsed.error) {
              clearTimeout(timeout);
              proc.stdout!.off("data", onData);
              const error = parsed.error as { code: number };
              expect(error.code).toBe(-32700);
              resolve();
              return;
            }
          } catch {
            // skip
          }
        }
      };
      proc.stdout!.on("data", onData);
      proc.stdin!.write("not json at all\n");
    });
  });
});
