/**
 * `unicli skills` envelope tests — covers the list success path (empty dir)
 * and the invoke not-found error path.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSkillsCommand } from "../../../src/commands/skills.js";
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

describe("unicli skills — v2 envelope", () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let origExit: typeof process.exit;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "unicli-skills-test-"));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
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
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function newProgram(): Command {
    const program = new Command();
    program.exitOverride();
    program.option("-f, --format <fmt>", "output format");
    registerSkillsCommand(program);
    return program;
  }

  it("skills invoke emits a not-found envelope for an unknown skill", async () => {
    const cap = captureStdout();
    let exitCode: number | null = null;
    try {
      const program = newProgram();
      try {
        await program.parseAsync(
          ["-f", "json", "skills", "invoke", "__no_such_skill__"],
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
    expect(env.command).toBe("skills.invoke");
    const e = env.error as { code: string } | undefined;
    expect(e?.code).toBe("not_found");
    validateEnvelope(env as Parameters<typeof validateEnvelope>[0]);
  });

  it("skills list emits an ok envelope (array data) even when no skills exist", async () => {
    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync(["-f", "json", "skills", "list"], {
        from: "user",
      });
    } finally {
      cap.restore();
    }
    const env = parseEnv(cap.getStdout());
    expect(env.ok).toBe(true);
    expect(env.command).toBe("skills.list");
    expect(Array.isArray(env.data)).toBe(true);
    validateEnvelope(env as Parameters<typeof validateEnvelope>[0]);
  });
});
