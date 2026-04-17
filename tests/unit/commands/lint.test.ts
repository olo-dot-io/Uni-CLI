/**
 * `unicli lint` envelope tests — verify the v2 envelope contract on the lint
 * command (success and error paths).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerLintCommand } from "../../../src/commands/lint.js";
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

function parseEnvelope(text: string): Record<string, unknown> {
  return JSON.parse(text.trim()) as Record<string, unknown>;
}

describe("unicli lint — v2 envelope", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "unicli-lint-test-"));
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function newProgram(): Command {
    const program = new Command();
    program.exitOverride();
    program.option("-f, --format <fmt>", "output format");
    registerLintCommand(program);
    return program;
  }

  it("emits an ok envelope on a clean adapter directory", async () => {
    // Write a minimal v2-compliant adapter
    writeFileSync(
      join(dir, "example.yaml"),
      `site: example
name: ping
type: web-api
strategy: public
schema_version: v2
capabilities: ["http.fetch"]
minimum_capability: http.fetch
trust: public
confidentiality: public
quarantine: false
pipeline:
  - fetch: { url: "https://example.com/" }
`,
    );

    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync(["-f", "json", "lint", dir], { from: "user" });
    } finally {
      cap.restore();
    }

    const env = parseEnvelope(cap.getStdout());
    expect(env.ok).toBe(true);
    expect(env.schema_version).toBe("2");
    expect(env.command).toBe("lint.run");
    const data = env.data as {
      scanned: number;
      passed: number;
      failed: number;
      issues: unknown[];
    };
    expect(data.scanned).toBe(1);
    expect(data.passed).toBe(1);
    expect(data.failed).toBe(0);
    expect(Array.isArray(data.issues)).toBe(true);
    validateEnvelope(env as Parameters<typeof validateEnvelope>[0]);
  });

  it("emits an error envelope when target does not exist", async () => {
    const origExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`__EXIT__${code}`);
    }) as typeof process.exit;

    const cap = captureStdout();
    let exitCode: number | null = null;
    try {
      const program = newProgram();
      try {
        await program.parseAsync(
          ["-f", "json", "lint", join(dir, "__does_not_exist__")],
          { from: "user" },
        );
      } catch (err) {
        const m = /^__EXIT__(\d+)/.exec((err as Error).message);
        if (m) exitCode = parseInt(m[1], 10);
        else throw err;
      }
    } finally {
      cap.restore();
      process.exit = origExit;
    }

    // CONFIG_ERROR = 78
    expect(exitCode).toBe(78);
    const parsed = JSON.parse(cap.getStderr().trim()) as Record<
      string,
      unknown
    >;
    expect(parsed.ok).toBe(false);
    expect(parsed.command).toBe("lint.run");
    const e = parsed.error as { code: string } | undefined;
    expect(e?.code).toBe("invalid_input");
  });
});
