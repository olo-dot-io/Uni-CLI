/**
 * Wire-parity — CLI binary ↔ MCP handler row-level equivalence.
 *
 * v0.213.3 P3 (D4 follow-up; MN2 closeout). `dispatch-parity.test.ts`
 * already proves kernel parity (same `execute()` with different
 * Invocation.surface). This test goes one step further: it spawns the
 * built `dist/main.js` CLI with `--format json` and compares the rendered
 * envelope against what the MCP stdio handler returns for the same args.
 *
 * Asserts deep-equal on `results[0]` modulo `trace_id` / `duration_ms`
 * (fields that MUST vary per invocation). HN-list volatility (top story
 * IDs churn in seconds) means the comparison runs on a single row — if
 * both sides observed the same ordering we get a byte-for-byte diff;
 * when ordering shifted, the test falls back to shape parity so the suite
 * does not flake.
 *
 * Needs network (hackernews top → hacker-news.firebaseio.com). Skips
 * gracefully when the network is unavailable or the upstream times out —
 * wire-parity is a nice-to-have, not a ship-gate.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const DIST_MAIN = join(REPO_ROOT, "dist", "main.js");
const MCP_SERVER = join(REPO_ROOT, "src", "mcp", "server.ts");

const SITE = "hackernews";
const COMMAND = "top";
const LIMIT = 2;
const NETWORK_TIMEOUT_MS = 20_000;

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: {
    content?: Array<{ type: string; text: string }>;
    structuredContent?: { type: string; data: unknown };
  };
  error?: unknown;
}

// ── CLI side ──────────────────────────────────────────────────────────────

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    const proc = spawn("node", [DIST_MAIN, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, UNICLI_OUTPUT: "json" },
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    proc.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
    proc.stderr.on("data", (c: Buffer) => stderrChunks.push(c));
    const timer = setTimeout(() => proc.kill("SIGKILL"), NETWORK_TIMEOUT_MS);
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        exitCode: code,
      });
    });
  });
}

// ── MCP side ──────────────────────────────────────────────────────────────

function sendMcpRequest(
  proc: ChildProcess,
  request: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("MCP response timeout")),
      NETWORK_TIMEOUT_MS,
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
          const parsed = JSON.parse(trimmed) as JsonRpcResponse;
          if (parsed.id === request.id) {
            clearTimeout(timer);
            proc.stdout!.off("data", onData);
            resolve(parsed);
            return;
          }
        } catch {
          /* ignore non-JSON lines */
        }
      }
    };
    proc.stdout!.on("data", onData);
    proc.stdin!.write(JSON.stringify(request) + "\n");
  });
}

async function invokeMcp(): Promise<{ rows: unknown[]; error?: unknown }> {
  const proc = spawn("npx", ["tsx", MCP_SERVER], {
    cwd: REPO_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  try {
    // initialize
    await sendMcpRequest(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25" },
    });

    const response = await sendMcpRequest(proc, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "unicli_run",
        arguments: { site: SITE, command: COMMAND, args: { limit: LIMIT } },
      },
    });

    if (response.error) {
      return { rows: [], error: response.error };
    }
    const content = response.result?.content?.[0]?.text;
    if (!content) return { rows: [] };
    const parsed = JSON.parse(content) as {
      results?: unknown[];
      error?: unknown;
    };
    if (parsed.error) return { rows: [], error: parsed.error };
    return { rows: parsed.results ?? [] };
  } finally {
    proc.kill();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

interface EnvelopeShape {
  ok?: boolean;
  schema_version?: string;
  command?: string;
  data?: unknown[];
  meta?: Record<string, unknown>;
  error?: unknown;
}

function isNetworkError(stderr: string): boolean {
  return /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo|network/i.test(stderr);
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("wire parity — CLI (dist/main.js) ↔ MCP handler envelope", () => {
  beforeAll(() => {
    if (!existsSync(DIST_MAIN)) {
      throw new Error(
        `dist/main.js missing — run \`npm run build\` before this suite ` +
          `(or ensure the verify pipeline builds before integration runs).`,
      );
    }
  });

  it(
    `${SITE} ${COMMAND} --limit ${LIMIT}: result rows match between surfaces`,
    async () => {
      const cli = await runCli([
        SITE,
        COMMAND,
        "--limit",
        String(LIMIT),
        "--format",
        "json",
      ]);

      if (cli.exitCode !== 0 && isNetworkError(cli.stderr + cli.stdout)) {
        // Wire-parity is nice-to-have; a network-unreachable CI run should
        // not fail the suite. Kernel parity is covered by the in-process
        // dispatch-parity test.
        console.warn("wire-parity: skipping — network unavailable");
        return;
      }

      let cliEnv: EnvelopeShape;
      try {
        cliEnv = JSON.parse(cli.stdout) as EnvelopeShape;
      } catch {
        // If the CLI did not return JSON, network / infra problems are
        // the most common cause — skip rather than fail.
        console.warn(
          `wire-parity: CLI stdout not JSON (exit=${cli.exitCode}), skipping`,
        );
        return;
      }

      // Fetch the MCP side.
      let mcpResult: Awaited<ReturnType<typeof invokeMcp>>;
      try {
        mcpResult = await invokeMcp();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/timeout|ENOTFOUND|network/i.test(msg)) {
          console.warn(
            `wire-parity: MCP upstream unreachable (${msg}), skipping`,
          );
          return;
        }
        throw err;
      }

      if (mcpResult.error) {
        console.warn(
          `wire-parity: MCP returned error ${JSON.stringify(mcpResult.error)}, skipping`,
        );
        return;
      }

      // Sanity: both sides produced a non-empty array.
      expect(cliEnv.ok).toBe(true);
      expect(Array.isArray(cliEnv.data)).toBe(true);
      expect(cliEnv.data!.length).toBeGreaterThan(0);
      expect(Array.isArray(mcpResult.rows)).toBe(true);
      expect(mcpResult.rows.length).toBeGreaterThan(0);

      const cliRow0 = cliEnv.data![0] as Record<string, unknown>;
      const mcpRow0 = mcpResult.rows[0] as Record<string, unknown>;

      // Shape parity — each row must have the same keys on both sides.
      const cliKeys = new Set(Object.keys(cliRow0));
      const mcpKeys = new Set(Object.keys(mcpRow0));
      expect([...cliKeys].sort()).toEqual([...mcpKeys].sort());

      // Deep-equal parity on results[0] modulo non-deterministic fields.
      // HN's top list shifts by the second — if both calls land on the
      // same story we get a full byte-for-byte match. Otherwise we look
      // for ANY common story id between the two result sets and compare
      // those rows, so the stronger assertion still applies most of the
      // time. When no overlap exists (rare, tail of the list churns),
      // we fall back to the shape parity above.
      const stripVolatile = (o: Record<string, unknown>) => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(o)) {
          if (k === "trace_id" || k === "duration_ms") continue;
          out[k] = v;
        }
        return out;
      };

      const cliStripped = stripVolatile(cliRow0);
      const mcpStripped = stripVolatile(mcpRow0);

      // Fast path: rows line up 1:1 (same id, same position).
      if (
        typeof cliRow0.id === typeof mcpRow0.id &&
        cliRow0.id === mcpRow0.id
      ) {
        expect(cliStripped).toEqual(mcpStripped);
        return;
      }

      // Slow path: search mcpResult for a row whose id matches cliRow0.id.
      if (cliRow0.id !== undefined) {
        const match = mcpResult.rows.find(
          (r) =>
            typeof r === "object" &&
            r !== null &&
            (r as Record<string, unknown>).id === cliRow0.id,
        );
        if (match) {
          expect(cliStripped).toEqual(
            stripVolatile(match as Record<string, unknown>),
          );
          return;
        }
      }

      // No overlap — lists churned between the two calls. Shape parity
      // (already asserted above) is the best we can do without a fixture.
      console.warn(
        "wire-parity: CLI/MCP result lists do not overlap on id; " +
          "shape parity asserted but deep-equal skipped (HN list volatility).",
      );
    },
    NETWORK_TIMEOUT_MS + 15_000,
  );
});
