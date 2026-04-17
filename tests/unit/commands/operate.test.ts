/**
 * `unicli operate` envelope tests.
 *
 * The happy paths require a live daemon-backed browser, which is out of scope
 * for a unit test. We instead mock `BrowserBridge` to (a) return a stub page
 * for an ack-only action (keys) and (b) fail connection for the error path.
 * Both branches must emit a v2 envelope on stdout / stderr.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
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

// Mock BrowserBridge to intercept daemon connection attempts. Hoisted by Vitest.
vi.mock("../../../src/browser/bridge.js", () => {
  const connectFn = vi.fn();
  class MockBridge {
    connect = connectFn;
  }
  class MockDaemonPage {}
  class BridgeConnectionError extends Error {
    suggestion = "start daemon";
    retryable = true;
    alternatives: string[] = [];
    constructor(message: string) {
      super(message);
      this.name = "BridgeConnectionError";
    }
  }
  return {
    BrowserBridge: MockBridge,
    DaemonPage: MockDaemonPage,
    BridgeConnectionError,
    __connectFn: connectFn,
  };
});

import { registerOperateCommands } from "../../../src/commands/operate.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — pulled from mock return
import * as bridgeMock from "../../../src/browser/bridge.js";

describe("unicli operate — v2 envelope", () => {
  beforeEach(() => {
    // Default: connection fails so every command hits the error path, which is
    // sufficient for envelope shape tests without a live daemon.
    (
      bridgeMock as unknown as { __connectFn: ReturnType<typeof vi.fn> }
    ).__connectFn.mockReset();
    (
      bridgeMock as unknown as { __connectFn: ReturnType<typeof vi.fn> }
    ).__connectFn.mockRejectedValue(new Error("daemon failed: offline (test)"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function newProgram(): Command {
    const program = new Command();
    program.exitOverride();
    program.option("-f, --format <fmt>", "output format");
    registerOperateCommands(program);
    return program;
  }

  it("operate back emits an error envelope when daemon is unavailable", async () => {
    const cap = captureStdout();
    const origExitCode = process.exitCode;
    try {
      const program = newProgram();
      await program.parseAsync(["-f", "json", "operate", "back"], {
        from: "user",
      });
    } finally {
      cap.restore();
      process.exitCode = origExitCode;
    }

    const errText = cap.getStderr().trim();
    expect(errText.length).toBeGreaterThan(0);
    const env = JSON.parse(errText) as Record<string, unknown>;
    expect(env.ok).toBe(false);
    expect(env.schema_version).toBe("2");
    expect(env.command).toBe("operate.back");
    const e = env.error as { code: string } | undefined;
    expect(typeof e?.code).toBe("string");
  });

  it("operate keys emits an envelope with ok data when page accepts the press", async () => {
    const pressFn = vi.fn().mockResolvedValue(undefined);
    (
      bridgeMock as unknown as { __connectFn: ReturnType<typeof vi.fn> }
    ).__connectFn.mockResolvedValue({
      press: pressFn,
    });

    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync(["-f", "json", "operate", "keys", "Enter"], {
        from: "user",
      });
    } finally {
      cap.restore();
    }

    const out = cap.getStdout().trim();
    expect(out.length).toBeGreaterThan(0);
    const env = JSON.parse(out) as Record<string, unknown>;
    expect(env.ok).toBe(true);
    expect(env.command).toBe("operate.keys");
    const data = env.data as { ok: boolean; key: string };
    expect(data.ok).toBe(true);
    expect(data.key).toBe("Enter");
    validateEnvelope(env as Parameters<typeof validateEnvelope>[0]);
    expect(pressFn).toHaveBeenCalledWith("Enter");
  });
});
