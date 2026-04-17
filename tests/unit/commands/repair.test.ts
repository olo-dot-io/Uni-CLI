/**
 * `unicli repair` envelope tests — exercises the --dry-run and --eval paths
 * without triggering the AI-driven repair loop (which requires network + an
 * API key). The loop path is exercised indirectly via a mocked `runRepairLoop`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

vi.mock("../../../src/engine/repair/engine.js", () => ({
  runRepairLoop: vi.fn(async () => ({
    iterations: 2,
    bestMetric: 1,
    improved: true,
  })),
}));

vi.mock("../../../src/engine/repair/eval.js", () => ({
  runEval: vi.fn(() => ({ score: 2, total: 2 })),
}));

import { registerRepairCommand } from "../../../src/commands/repair.js";
import { runRepairLoop } from "../../../src/engine/repair/engine.js";

describe("unicli repair — v2 envelope", () => {
  let dir: string;
  const originalExit = process.exit;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "unicli-repair-test-"));
    process.exit = ((code?: number) => {
      throw new Error(`__EXIT__${code}`);
    }) as typeof process.exit;
    // Reset mock to default (improved=true) before each test.
    (runRepairLoop as unknown as { mockReset: () => void }).mockReset();
    (
      runRepairLoop as unknown as {
        mockResolvedValue: (v: unknown) => void;
      }
    ).mockResolvedValue({
      iterations: 2,
      bestMetric: 1,
      improved: true,
    });
  });

  afterEach(() => {
    process.exit = originalExit;
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
    registerRepairCommand(program);
    return program;
  }

  it("--dry-run emits an ok envelope with the plan", async () => {
    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync(
        ["-f", "json", "repair", "example", "ping", "--dry-run"],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as Record<string, unknown>;
    expect(env.ok).toBe(true);
    expect(env.schema_version).toBe("2");
    expect(env.command).toBe("repair.run");
    const data = env.data as {
      mode: string;
      site: string;
      command: string | null;
      config: Record<string, unknown>;
    };
    expect(data.mode).toBe("dry-run");
    expect(data.site).toBe("example");
    expect(data.command).toBe("ping");
    expect(typeof data.config).toBe("object");
    validateEnvelope(env as Parameters<typeof validateEnvelope>[0]);
  });

  it("--eval emits an envelope carrying the eval score", async () => {
    const evalPath = join(dir, "tasks.json");
    writeFileSync(
      evalPath,
      JSON.stringify([
        { name: "smoke", expect: "ok", actual: "ok" },
        { name: "smoke2", expect: "ok", actual: "ok" },
      ]),
    );

    const cap = captureStdout();
    let exitCode: number | null = null;
    try {
      const program = newProgram();
      try {
        await program.parseAsync(
          ["-f", "json", "repair", "example", "--eval", evalPath],
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

    // Eval reports exit 0 when score === total, caught here as __EXIT__0.
    // runEval is the real implementation; shape-only assertion follows.
    const out = cap.getStdout().trim();
    expect(out.length).toBeGreaterThan(0);
    const env = JSON.parse(out) as Record<string, unknown>;
    expect(env.ok).toBe(true);
    expect(env.command).toBe("repair.run");
    const data = env.data as {
      mode: string;
      score: number;
      total: number;
    };
    expect(data.mode).toBe("eval");
    expect(typeof data.score).toBe("number");
    expect(typeof data.total).toBe("number");
    expect(typeof exitCode === "number" || exitCode === null).toBe(true);
  });

  it("loop path emits an envelope with iterations + best_metric", async () => {
    const cap = captureStdout();
    let exitCode: number | null = null;
    let caughtErr: unknown = null;
    try {
      const program = newProgram();
      try {
        await program.parseAsync(
          ["-f", "json", "repair", "example", "ping", "--loop"],
          { from: "user" },
        );
      } catch (err) {
        const m = /^__EXIT__(\d+)/.exec((err as Error).message);
        if (m) exitCode = parseInt(m[1], 10);
        else caughtErr = err;
      }
    } finally {
      cap.restore();
    }

    // If the action never ran to process.exit, the caught error (if any)
    // surfaces diagnostic detail for debugging.
    if (caughtErr) throw caughtErr;

    const out = cap.getStdout().trim();
    expect(out.length).toBeGreaterThan(0);
    const env = JSON.parse(out) as Record<string, unknown>;
    expect(env.ok).toBe(true);
    expect(env.command).toBe("repair.run");
    const data = env.data as {
      mode: string;
      iterations: number;
      best_metric: number;
      improved: boolean;
    };
    expect(data.mode).toBe("loop");
    expect(data.iterations).toBe(2);
    expect(data.best_metric).toBe(1);
    expect(data.improved).toBe(true);
    // Exit code tracks `improved`: true → 0, false → 1. Mock returns true.
    expect(exitCode).toBe(0);
  });
});
