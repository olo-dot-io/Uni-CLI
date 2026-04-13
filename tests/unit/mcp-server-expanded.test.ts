/**
 * MCP server — expanded mode (`--expanded` flag).
 *
 * In expanded mode the server registers one tool per adapter command
 * (`unicli_<site>_<command>`) plus the 3 default tools. This test verifies:
 *   - tool count grows with the loaded adapter catalog
 *   - tool names follow the expected normalization
 *   - input schemas are derived from adapter args
 *   - calling an expanded tool by its full name resolves and runs
 *   - descriptions are truncated to <=68 tokens
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ChildProcess, spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "..", "..", "src", "mcp", "server.ts");

function sendRequest(
  proc: ChildProcess,
  request: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("MCP response timeout")),
      timeoutMs,
    );

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
          if (parsed.id === request.id) {
            clearTimeout(timeout);
            proc.stdout!.off("data", onData);
            resolve(parsed);
            return;
          }
        } catch {
          // skip
        }
      }
    };
    proc.stdout!.on("data", onData);
    proc.stdin!.write(JSON.stringify(request) + "\n");
  });
}

describe("MCP server — expanded mode (--expanded)", () => {
  let proc: ChildProcess;

  beforeAll(async () => {
    proc = spawn("npx", ["tsx", SERVER_PATH, "--expanded"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: join(__dirname, "..", ".."),
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Server start timeout")),
        20_000,
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
  });

  afterAll(() => {
    proc.kill();
  });

  it("registers many tools (one per adapter command + 4 default)", async () => {
    const response = await sendRequest(proc, {
      jsonrpc: "2.0",
      id: 100,
      method: "tools/list",
      params: {},
    });

    const result = response.result as { tools: Array<{ name: string }> };
    // Default mode is exactly 4; expanded must be many more than that
    expect(result.tools.length).toBeGreaterThan(50);
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("unicli_list");
    expect(names).toContain("unicli_run");
    expect(names).toContain("unicli_search");
    expect(names).toContain("unicli_explore");
  });

  it("uses the unicli_<site>_<command> naming convention", async () => {
    const response = await sendRequest(proc, {
      jsonrpc: "2.0",
      id: 101,
      method: "tools/list",
      params: {},
    });
    const result = response.result as { tools: Array<{ name: string }> };
    const expanded = result.tools.filter((t) => t.name.startsWith("unicli_"));
    expect(expanded.length).toBeGreaterThan(0);
    // Names match alphanumeric + underscore only — Anthropic / Claude Desktop
    // accept this; rejected chars get normalized at build time.
    for (const t of expanded.slice(0, 20)) {
      expect(t.name).toMatch(/^[a-zA-Z0-9_]+$/);
    }
  });

  it("includes hackernews tools and they have valid input schema", async () => {
    const response = await sendRequest(proc, {
      jsonrpc: "2.0",
      id: 102,
      method: "tools/list",
      params: {},
    });
    const result = response.result as {
      tools: Array<{
        name: string;
        inputSchema: { type: string; properties: Record<string, unknown> };
      }>;
    };
    const hnTop = result.tools.find((t) => t.name === "unicli_hackernews_top");
    expect(hnTop).toBeDefined();
    expect(hnTop!.inputSchema.type).toBe("object");
    expect(hnTop!.inputSchema.properties.limit).toBeDefined();
  });

  it("translates required args into schema.required", async () => {
    const response = await sendRequest(proc, {
      jsonrpc: "2.0",
      id: 103,
      method: "tools/list",
      params: {},
    });
    const result = response.result as {
      tools: Array<{
        name: string;
        inputSchema: {
          required?: string[];
          properties: Record<string, unknown>;
        };
      }>;
    };
    const hnSearch = result.tools.find(
      (t) => t.name === "unicli_hackernews_search",
    );
    expect(hnSearch).toBeDefined();
    expect(hnSearch!.inputSchema.required).toContain("query");
    expect(hnSearch!.inputSchema.properties.query).toBeDefined();
  });

  it("tool descriptions are at most 68 tokens (~52 words)", async () => {
    const response = await sendRequest(proc, {
      jsonrpc: "2.0",
      id: 110,
      method: "tools/list",
      params: {},
    });
    const result = response.result as {
      tools: Array<{ name: string; description: string }>;
    };
    const expanded = result.tools.filter((t) => t.name.startsWith("unicli_"));
    for (const t of expanded) {
      const words = t.description.split(/\s+/).filter(Boolean).length;
      const approxTokens = Math.ceil(words * 1.3);
      // Allow slight overflow from the ellipsis character
      expect(approxTokens).toBeLessThanOrEqual(70);
    }
  });

  it("rejects an unknown expanded-form tool with a helpful message", async () => {
    const response = await sendRequest(proc, {
      jsonrpc: "2.0",
      id: 104,
      method: "tools/call",
      params: {
        name: "unicli_definitely_not_a_real_command",
        arguments: {},
      },
    });
    expect(response.error).toBeDefined();
    const error = response.error as { code: number; message: string };
    expect(error.code).toBe(-32602);
  });

  it("registers tools for commands with hyphens in the filename", async () => {
    // v0.208 ships adapters with hyphenated command filenames like
    // `hermes/skills-read.yaml`, `renderdoc/capture-list.yaml`. The tool
    // name normalizer collapses hyphens to underscores, but the dispatch
    // path must still resolve to the original command key via the
    // expandedRegistry lookup (not by reversing the normalization).
    const response = await sendRequest(proc, {
      jsonrpc: "2.0",
      id: 105,
      method: "tools/list",
      params: {},
    });
    const result = response.result as { tools: Array<{ name: string }> };
    const names = new Set(result.tools.map((t) => t.name));
    // All adapters register regardless of detect: — verify hyphenated names
    expect(names.has("unicli_hermes_skills_read")).toBe(true);
    expect(names.has("unicli_hermes_sessions_search")).toBe(true);
    expect(names.has("unicli_renderdoc_capture_list")).toBe(true);
    expect(names.has("unicli_motion_studio_component_get")).toBe(true);
    expect(names.has("unicli_godot_scene_export")).toBe(true);
  });

  it("dispatches a hyphenated command name via the registry lookup", async () => {
    // Verify the dispatcher resolves a tool and tries to execute it.
    // hermes adapter is always registered (detect: doesn't gate registration).
    const response = await sendRequest(proc, {
      jsonrpc: "2.0",
      id: 106,
      method: "tools/call",
      params: {
        name: "unicli_hermes_skills_list",
        arguments: {},
      },
    });
    // The call should NOT return an MCP error object; it returns a result
    // with either the adapter output or a pipeline error wrapped in text.
    // What matters: error must be undefined (no "Unknown tool").
    expect(response.error).toBeUndefined();
    expect(response.result).toBeDefined();
  });
});
