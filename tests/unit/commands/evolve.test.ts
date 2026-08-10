import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Command } from "commander";

import { registerEvolveCommand } from "../../../src/commands/evolve.js";
import { ExitCode } from "../../../src/types.js";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.option("-f, --format <fmt>", "output format");
  program.option("--permission-profile <name>", "permission profile");
  registerEvolveCommand(program);
  return program;
}

function captureConsole(): {
  stdout: () => string;
  stderr: () => string;
  restore: () => void;
} {
  let out = "";
  let err = "";
  const originalLog = console.log;
  const originalError = console.error;
  console.log = ((...values: unknown[]) => {
    out += `${values.map(String).join(" ")}\n`;
  }) as typeof console.log;
  console.error = ((...values: unknown[]) => {
    err += `${values.map(String).join(" ")}\n`;
  }) as typeof console.error;
  return {
    stdout: () => out,
    stderr: () => err,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

describe("unicli evolve command", () => {
  let root: string;
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "unicli-evolve-command-"));
    process.exitCode = undefined;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    process.exitCode = originalExitCode;
  });

  it("lists an empty local evolution store through a v2 envelope", async () => {
    const capture = captureConsole();
    try {
      await createProgram().parseAsync(
        ["-f", "json", "evolve", "list", "--root", root],
        { from: "user" },
      );
    } finally {
      capture.restore();
    }

    const envelope = JSON.parse(capture.stdout().trim()) as {
      ok: boolean;
      command: string;
      data: { root: string; sessions: unknown[] };
    };
    expect(envelope).toMatchObject({
      ok: true,
      command: "evolve.list",
      data: { root, sessions: [] },
    });
    expect(capture.stderr()).toBe("");
  });

  it("reports a missing session as a structured error", async () => {
    const capture = captureConsole();
    try {
      await createProgram().parseAsync(
        ["-f", "json", "evolve", "inspect", "evo-missing", "--root", root],
        { from: "user" },
      );
    } finally {
      capture.restore();
    }

    const envelope = JSON.parse(capture.stderr().trim()) as {
      ok: boolean;
      command: string;
      error: { code: string };
    };
    expect(envelope).toMatchObject({
      ok: false,
      command: "evolve.inspect",
      error: { code: "not_found" },
    });
    expect(capture.stdout()).toBe("");
    expect(process.exitCode).toBe(ExitCode.USAGE_ERROR);
  });
});
