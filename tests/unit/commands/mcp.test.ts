/**
 * `unicli mcp` envelope tests — covers `mcp health` which emits a v2 envelope.
 * `mcp serve` is intentionally unchanged (stdio MCP protocol, not an envelope
 * surface) and therefore not exercised here.
 */

import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { registerMcpCommand } from "../../../src/commands/mcp.js";
import { validateEnvelope } from "../../../src/output/envelope.js";

function captureStdout(): {
  getStdout: () => string;
  getStderr: () => string;
  restore: () => void;
} {
  let out = "";
  let err = "";
  const origLog = console.log;
  const origError = console.error;
  console.log = ((...args: unknown[]) => {
    out += args.map(String).join(" ") + "\n";
  }) as typeof console.log;
  console.error = ((...args: unknown[]) => {
    err += args.map(String).join(" ") + "\n";
  }) as typeof console.error;
  return {
    getStdout: () => out,
    getStderr: () => err,
    restore: () => {
      console.log = origLog;
      console.error = origError;
    },
  };
}

describe("unicli mcp — v2 envelope", () => {
  function newProgram(): Command {
    const program = new Command();
    program.exitOverride();
    program.option("-f, --format <fmt>", "output format");
    registerMcpCommand(program);
    return program;
  }

  it("mcp health emits an ok envelope with adapter and command counts", async () => {
    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync(["-f", "json", "mcp", "health"], {
        from: "user",
      });
    } finally {
      cap.restore();
    }

    const out = cap.getStdout().trim();
    expect(out.length).toBeGreaterThan(0);
    const env = JSON.parse(out) as Record<string, unknown>;
    expect(env.ok).toBe(true);
    expect(env.schema_version).toBe("2");
    expect(env.command).toBe("mcp.health");
    const data = env.data as {
      status: string;
      adapters: number;
      commands: number;
      tools: { default: number; expanded: number };
      version: string;
    };
    expect(data.status).toBe("ok");
    expect(typeof data.adapters).toBe("number");
    expect(typeof data.commands).toBe("number");
    expect(data.tools.default).toBe(3);
    expect(data.tools.expanded).toBeGreaterThanOrEqual(3);
    expect(typeof data.version).toBe("string");
    validateEnvelope(env as Parameters<typeof validateEnvelope>[0]);
  });
});
