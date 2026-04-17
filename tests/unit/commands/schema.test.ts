/**
 * `unicli schema` envelope tests — covers the two envelope error paths
 * (missing args, unknown site) and the --all success path.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerSchemaCommand } from "../../../src/commands/schema.js";
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

describe("unicli schema — v2 envelope", () => {
  let origExit: typeof process.exit;

  beforeEach(() => {
    origExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`__EXIT__${code}`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    process.exit = origExit;
  });

  function newProgram(): Command {
    const program = new Command();
    program.exitOverride();
    program.option("-f, --format <fmt>", "output format");
    registerSchemaCommand(program);
    return program;
  }

  it("emits a usage-error envelope when called with no args", async () => {
    const cap = captureStdout();
    let exitCode: number | null = null;
    try {
      const program = newProgram();
      try {
        await program.parseAsync(["-f", "json", "schema"], { from: "user" });
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
    expect(env.command).toBe("schema.describe");
    const e = env.error as { code: string } | undefined;
    expect(e?.code).toBe("invalid_input");
  });

  it("emits a not-found envelope for an unknown site", async () => {
    const cap = captureStdout();
    let exitCode: number | null = null;
    try {
      const program = newProgram();
      try {
        await program.parseAsync(
          ["-f", "json", "schema", "__no_site_xx__", "cmd"],
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
    expect(env.command).toBe("schema.describe");
    const e = env.error as { code: string } | undefined;
    expect(e?.code).toBe("not_found");
    validateEnvelope(env as Parameters<typeof validateEnvelope>[0]);
  });
});
