/**
 * `unicli synthesize` envelope tests — covers the missing-explore-data error
 * path (the only synchronous error branch without mocking).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSynthesizeCommand } from "../../../src/commands/synthesize.js";
import { validateEnvelope } from "../../../src/output/envelope.js";
import { writeEndpointMemory } from "../../../src/browser/site-memory.js";

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

describe("unicli synthesize — v2 envelope", () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let origExit: typeof process.exit;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "unicli-synth-test-"));
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
    registerSynthesizeCommand(program);
    return program;
  }

  it("emits a not-found envelope when explore data is missing", async () => {
    const cap = captureStdout();
    let exitCode: number | null = null;
    try {
      const program = newProgram();
      try {
        await program.parseAsync(
          ["-f", "json", "synthesize", "__no_explore_site__"],
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
    expect(env.command).toBe("core.synthesize");
    const e = env.error as { code: string } | undefined;
    expect(e?.code).toBe("not_found");
    validateEnvelope(env as Parameters<typeof validateEnvelope>[0]);
  });

  it("falls back to reusable site memory when explore data is missing", async () => {
    writeEndpointMemory(
      "example",
      "feed",
      {
        url: "https://example.com/api/feed",
        method: "GET",
        response: {
          status: 200,
          contentType: "application/json",
          size: 42,
          fields: ["id", "title"],
          sample: { data: [{ id: "1", title: "First" }] },
        },
      },
      { baseDir: tmpHome, verifiedAt: "2026-04-24" },
    );

    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync(["-f", "json", "synthesize", "example"], {
        from: "user",
      });
    } finally {
      cap.restore();
    }

    const env = parseEnv(cap.getStdout()) as {
      ok: boolean;
      data: { candidate_count: number; candidates: Array<{ name: string }> };
    };
    expect(env.ok).toBe(true);
    expect(env.data.candidate_count).toBe(1);
    expect(env.data.candidates[0].name).toBe("feed");
  });
});
