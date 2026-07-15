/**
 * `unicli status` envelope test — verifies the v2 envelope wraps the system
 * health snapshot (version/platform/broker/browser/adapter counts).
 *
 * The owner-only runtime probe is mocked to a deterministic stopped state.
 */

import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import { registerStatusCommand } from "../../../src/commands/status.js";
import { validateEnvelope } from "../../../src/output/envelope.js";

vi.mock("../../../src/browser/runtime-launch.js", () => {
  return {
    probeBrowserRuntimeBroker: vi.fn().mockRejectedValue(
      Object.assign(new Error("not running"), {
        code: "browser_broker_unavailable",
      }),
    ),
  };
});

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

function parseEnv(text: string): Record<string, unknown> {
  return JSON.parse(text.trim()) as Record<string, unknown>;
}

describe("unicli status — v2 envelope", () => {
  function newProgram(): Command {
    const program = new Command();
    program.exitOverride();
    program.option("-f, --format <fmt>", "output format");
    registerStatusCommand(program);
    return program;
  }

  it("emits an ok envelope with system health snapshot", async () => {
    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync(["-f", "json", "status"], { from: "user" });
    } finally {
      cap.restore();
    }
    const env = parseEnv(cap.getStdout());
    expect(env.ok).toBe(true);
    expect(env.command).toBe("status.run");
    const data = env.data as {
      version: string;
      platform: string;
      node: string;
      browser: { status: string };
      broker: { status: string; live_session_count: number };
      adapters: { total: number };
    };
    expect(typeof data.version).toBe("string");
    expect(typeof data.platform).toBe("string");
    expect(typeof data.node).toBe("string");
    expect(data.browser.status).toBe("stopped");
    expect(data.broker.status).toBe("stopped");
    expect(data.broker.live_session_count).toBe(0);
    expect(typeof data.adapters.total).toBe("number");
    validateEnvelope(env as Parameters<typeof validateEnvelope>[0]);
    // Timeout generous (60s) because `unicli status` walks all 896 YAML
    // adapters + probes external CLIs; under verify:clean concurrent test
    // runs this slows enough to cross a 15s bar intermittently.
  }, 60_000);
});
