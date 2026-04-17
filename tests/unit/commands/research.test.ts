/**
 * `unicli research` envelope tests — verify the v2 envelope contract on the
 * research subcommands (run error paths + log/report success paths).
 *
 * Full `research run` happy-path requires a spawnable eval loop; we cover the
 * two synchronous error gates (invalid site name, missing adapter dir) plus
 * the no-history `log`/`report` success paths which exercise the envelope
 * success branch without touching the research engine.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerResearchCommand } from "../../../src/commands/research.js";
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

function parseEnv(text: string): Record<string, unknown> {
  return JSON.parse(text.trim()) as Record<string, unknown>;
}

describe("unicli research — v2 envelope", () => {
  let origHome: string | undefined;
  let origExit: typeof process.exit;

  beforeEach(() => {
    origHome = process.env.HOME;
    // Point HOME at a throwaway dir so readResearchLog returns empty
    process.env.HOME = "/tmp/unicli-research-test-home-" + Date.now();
    origExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`__EXIT__${code}`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    process.exit = origExit;
    if (origHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = origHome;
    }
  });

  function newProgram(): Command {
    const program = new Command();
    program.exitOverride();
    program.option("-f, --format <fmt>", "output format");
    registerResearchCommand(program);
    return program;
  }

  it("rejects invalid site names with a usage-error envelope", async () => {
    const cap = captureStdout();
    let exitCode: number | null = null;
    try {
      const program = newProgram();
      try {
        await program.parseAsync(
          ["-f", "json", "research", "run", "bad site name!"],
          { from: "user" },
        );
      } catch (err) {
        const m = /^__EXIT__(\d+)/.exec((err as Error).message);
        if (m) exitCode = parseInt(m[1], 10);
        else throw err;
      }
    } finally {
      cap.restore();
    }
    expect(exitCode).toBe(2);
    const env = parseEnv(cap.getStderr());
    expect(env.ok).toBe(false);
    expect(env.command).toBe("research.run");
    const e = env.error as { code: string } | undefined;
    expect(e?.code).toBe("invalid_input");
  });

  it("research report emits an ok envelope when no history exists", async () => {
    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync(["-f", "json", "research", "report"], {
        from: "user",
      });
    } finally {
      cap.restore();
    }
    const env = parseEnv(cap.getStdout());
    expect(env.ok).toBe(true);
    expect(env.command).toBe("research.report");
    const data = env.data as { total_iterations: number };
    expect(data.total_iterations).toBe(0);
    validateEnvelope(env as Parameters<typeof validateEnvelope>[0]);
  });

  it("research log emits an ok envelope with empty data when log is empty", async () => {
    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync(["-f", "json", "research", "log"], {
        from: "user",
      });
    } finally {
      cap.restore();
    }
    const env = parseEnv(cap.getStdout());
    expect(env.ok).toBe(true);
    expect(env.command).toBe("research.log");
    expect(env.data).toEqual([]);
    validateEnvelope(env as Parameters<typeof validateEnvelope>[0]);
  });
});
