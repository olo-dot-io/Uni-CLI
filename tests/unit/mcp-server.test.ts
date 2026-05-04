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

describe("MCP server — smart default mode", () => {
  let proc: ChildProcess;

  beforeAll(async () => {
    // Default mode (no flags) registers 4 tools: unicli_run, unicli_list, unicli_search, unicli_explore
    // `spawn("npx", …)` fails with ENOENT on Windows because the real
    // binary is `npx.cmd`; use the platform-appropriate name so the CI
    // matrix green-lights Windows too.
    const npxBin = process.platform === "win32" ? "npx.cmd" : "npx";
    proc = spawn(npxBin, ["tsx", SERVER_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: join(__dirname, "..", ".."),
      // Node 16+ rejects spawning `.cmd` / `.bat` files without a shell
      // for security reasons (CVE-2024-27980). The tsx binary has no
      // special-char args, so `shell: true` is safe here.
      shell: process.platform === "win32",
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
    expect(result.protocolVersion).toBe("2025-11-25");
    expect(result.serverInfo).toEqual(
      expect.objectContaining({ name: "unicli" }),
    );
    expect(result.capabilities).toEqual(
      expect.objectContaining({ tools: { listChanged: false } }),
    );
  });

  it("lists exactly 4 tools in smart default mode", async () => {
    const response = await sendRequest(proc, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    const result = response.result as { tools: Array<{ name: string }> };
    expect(result.tools).toHaveLength(4);

    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "unicli_explore",
      "unicli_list",
      "unicli_run",
      "unicli_search",
    ]);
  });

  it("unicli_list returns adapter catalog", { timeout: 15_000 }, async () => {
    const response = await sendRequest(proc, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "unicli_list",
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

  it("unicli_list filters by site name", async () => {
    const response = await sendRequest(proc, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "unicli_list",
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

  it("unicli_run returns error for unknown command", async () => {
    const response = await sendRequest(proc, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "unicli_run",
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

  it("backwards-compat: list_adapters still works", async () => {
    const response = await sendRequest(proc, {
      jsonrpc: "2.0",
      id: 50,
      method: "tools/call",
      params: {
        name: "list_adapters",
        arguments: {},
      },
    });

    const result = response.result as {
      content: Array<{ type: string; text: string }>;
    };
    const data = JSON.parse(result.content[0].text) as {
      total_sites: number;
    };
    expect(data.total_sites).toBeGreaterThan(0);
  });

  it("backwards-compat: run_command still works", async () => {
    const response = await sendRequest(proc, {
      jsonrpc: "2.0",
      id: 51,
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
    expect(error.code).toBe(-32602);
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

describe("MCP server — computer-use profile", () => {
  let proc: ChildProcess;

  beforeAll(async () => {
    const npxBin = process.platform === "win32" ? "npx.cmd" : "npx";
    proc = spawn(npxBin, ["tsx", SERVER_PATH, "--profile", "computer-use"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: join(__dirname, "..", ".."),
      shell: process.platform === "win32",
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Computer-use MCP server start timeout")),
        15_000,
      );
      proc.stderr!.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        if (text.includes("MCP server") && text.includes("mode=computer-use")) {
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

  it("advertises tools and prompts in initialize", async () => {
    const response = await sendRequest(proc, {
      jsonrpc: "2.0",
      id: 101,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    });

    const result = response.result as {
      capabilities: Record<string, unknown>;
    };
    expect(result.capabilities).toEqual(
      expect.objectContaining({
        tools: { listChanged: false },
        prompts: { listChanged: false },
      }),
    );
  });

  it("lists the 15 computer-use tools over stdio", async () => {
    const response = await sendRequest(proc, {
      jsonrpc: "2.0",
      id: 102,
      method: "tools/list",
      params: {},
    });

    const result = response.result as { tools: Array<{ name: string }> };
    expect(result.tools.map((tool) => tool.name)).toEqual([
      "computer-use.apps",
      "computer-use.windows",
      "computer-use.snapshot",
      "computer-use.find",
      "computer-use.click",
      "computer-use.type",
      "computer-use.press",
      "computer-use.scroll",
      "computer-use.launch",
      "computer-use.screenshot",
      "computer-use.attach",
      "computer-use.evaluate",
      "computer-use.wait",
      "computer-use.observe",
      "computer-use.assert",
    ]);
  });

  it("serves the computer-use operating prompt over stdio", async () => {
    const listed = await sendRequest(proc, {
      jsonrpc: "2.0",
      id: 103,
      method: "prompts/list",
      params: {},
    });
    expect(listed.result).toEqual({
      prompts: [
        expect.objectContaining({
          name: "computer-use",
          description: expect.stringContaining("desktop"),
        }),
      ],
    });

    const got = await sendRequest(proc, {
      jsonrpc: "2.0",
      id: 104,
      method: "prompts/get",
      params: { name: "computer-use" },
    });
    expect(got.result).toMatchObject({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: expect.stringContaining("compact accessibility snapshots"),
          },
        },
      ],
    });
  });
});

describe("MCP server — stdio shutdown", () => {
  it("drains an in-flight async tools/call before exiting on stdin close", async () => {
    const npxBin = process.platform === "win32" ? "npx.cmd" : "npx";
    const proc = spawn(npxBin, ["tsx", SERVER_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: join(__dirname, "..", ".."),
      shell: process.platform === "win32",
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    proc.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
    proc.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));

    proc.stdin!.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 90,
        method: "tools/call",
        params: {
          name: "unicli_search",
          arguments: { query: "hacker news", limit: 1 },
        },
      }) + "\n",
    );
    proc.stdin!.end();

    const code = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        proc.kill();
        reject(
          new Error(
            `MCP one-shot timeout; stderr=${Buffer.concat(stderr).toString("utf8")}`,
          ),
        );
      }, 15_000);
      proc.on("close", (exitCode) => {
        clearTimeout(timeout);
        resolve(exitCode);
      });
      proc.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    expect(code).toBe(0);
    const lines = Buffer.concat(stdout)
      .toString("utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    const response = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.id === 90);

    expect(response).toBeDefined();
    expect(response?.jsonrpc).toBe("2.0");
    const result = response?.result as
      | { structuredContent?: { data?: { count?: number } } }
      | undefined;
    expect(result?.structuredContent?.data?.count).toBe(1);
  }, 20_000);
});
