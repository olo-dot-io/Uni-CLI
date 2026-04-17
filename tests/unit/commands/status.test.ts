/**
 * `unicli status` envelope test — verifies the v2 envelope wraps the system
 * health snapshot (version/platform/daemon/browser/adapter counts).
 *
 * The daemon and Chrome probes are left un-mocked; they return "stopped" or
 * "unknown" in CI, and the envelope shape is what we test here.
 */

import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import { registerStatusCommand } from "../../../src/commands/status.js";
import { validateEnvelope } from "../../../src/output/envelope.js";

// Daemon + Chrome probes mocked to deterministic "stopped"/"unknown" so the
// test doesn't race real network calls under verify:clean concurrency. The
// envelope-shape assertions below still verify the v2 contract end-to-end.
vi.mock("../../../src/browser/daemon-client.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/browser/daemon-client.js")
  >("../../../src/browser/daemon-client.js");
  return { ...actual, fetchDaemonStatus: vi.fn().mockResolvedValue(null) };
});
vi.mock("../../../src/browser/launcher.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/browser/launcher.js")
  >("../../../src/browser/launcher.js");
  return {
    ...actual,
    isCDPAvailable: vi.fn().mockResolvedValue(false),
    getCDPPort: vi.fn().mockReturnValue(9222),
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
      daemon: { status: string };
      adapters: { total: number };
    };
    expect(typeof data.version).toBe("string");
    expect(typeof data.platform).toBe("string");
    expect(typeof data.node).toBe("string");
    expect(["running", "stopped", "unknown"]).toContain(data.browser.status);
    expect(["running", "stopped", "unknown"]).toContain(data.daemon.status);
    expect(typeof data.adapters.total).toBe("number");
    validateEnvelope(env as Parameters<typeof validateEnvelope>[0]);
    // Timeout generous (60s) because `unicli status` walks all 896 YAML
    // adapters + probes external CLIs; under verify:clean concurrent test
    // runs this slows enough to cross a 15s bar intermittently.
  }, 60_000);
});
