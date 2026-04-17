/**
 * `unicli eval` envelope tests — T5 wires eval list/run/ci onto the v2
 * envelope. `eval list` has no external dependencies; `eval run` / `eval ci`
 * spawn subprocesses and are covered by the existing eval.test.ts suite.
 *
 * We cover:
 *   - eval list success envelope (ok=true, command=eval.list)
 *   - eval run no-target error envelope (ok=false, code=invalid_input)
 */

import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { registerEvalCommand } from "../../../src/commands/eval.js";
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

describe("unicli eval — v2 envelope", () => {
  function newProgram(): Command {
    const program = new Command();
    program.exitOverride();
    program.option("-f, --format <fmt>", "output format");
    registerEvalCommand(program);
    return program;
  }

  it("eval list emits ok envelope with discovered files", async () => {
    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync(["-f", "json", "eval", "list"], {
        from: "user",
      });
    } finally {
      cap.restore();
    }

    const out = cap.getStdout().trim();
    const env = JSON.parse(out) as Record<string, unknown>;
    expect(env.ok).toBe(true);
    expect(env.schema_version).toBe("2");
    expect(env.command).toBe("eval.list");
    expect(Array.isArray(env.data)).toBe(true);
    validateEnvelope(env as Parameters<typeof validateEnvelope>[0]);
  });

  it("eval run with neither target nor --all emits invalid_input error envelope", async () => {
    const origExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`__EXIT__${code}`);
    }) as typeof process.exit;

    const cap = captureStdout();
    try {
      const program = newProgram();
      try {
        await program.parseAsync(["-f", "json", "eval", "run"], {
          from: "user",
        });
      } catch {
        /* process.exit raised */
      }
    } finally {
      cap.restore();
      process.exit = origExit;
    }

    const errText = cap.getStderr().trim();
    const env = JSON.parse(errText) as Record<string, unknown>;
    expect(env.ok).toBe(false);
    expect(env.schema_version).toBe("2");
    expect(env.command).toBe("eval.run");
    const e = env.error as { code: string } | undefined;
    expect(e?.code).toBe("invalid_input");
  });
});
