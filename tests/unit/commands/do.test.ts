/**
 * `unicli do <intent>` — plan-only natural-language router tests.
 *
 * Exercises the real BM25 search backend with the CORE_SEARCH_DOCUMENTS
 * corpus (always available, no manifest.json required), so no mocking of
 * owned modules (rule 03).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerDoCommand } from "../../../src/commands/do.js";
import { validateEnvelope } from "../../../src/output/envelope.js";
import { loadAllAdapters } from "../../../src/discovery/loader.js";

// Ensure the YAML adapter registry is populated so that `do` can enrich
// matches with args_schema / example_stdin via describeCommand.
beforeAll(() => {
  loadAllAdapters();
});

function captureStdout(): {
  getStdout: () => string;
  restore: () => void;
} {
  let out = "";
  const origLog = console.log;
  console.log = ((...args: unknown[]) => {
    out += args.map(String).join(" ") + "\n";
  }) as typeof console.log;
  return {
    getStdout: () => out,
    restore: () => {
      console.log = origLog;
    },
  };
}

function newProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.option("-f, --format <fmt>", "output format");
  registerDoCommand(program);
  return program;
}

beforeEach(() => {
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
});

describe("unicli do — happy path", () => {
  it("returns a valid envelope for a recognizable intent", async () => {
    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync([
        "node",
        "unicli",
        "do",
        "browser",
        "click",
        "-f",
        "json",
      ]);
    } finally {
      cap.restore();
    }
    const env = JSON.parse(cap.getStdout());
    validateEnvelope(env);
    expect(env.ok).toBe(true);
    expect(env.command).toBe("core.do");
    expect(env.data.intent).toBe("browser click");
    expect(env.data.match).not.toBeNull();
    expect(env.data.match.invocation).toMatch(/^unicli \S+ \S+$/);
    expect(env.data.candidates.length).toBeGreaterThan(0);
  });

  it("includes args_schema by default and omits it under --no-schema", async () => {
    // with schema — query a YAML-backed adapter so describeCommand has args to surface
    let cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync([
        "node",
        "unicli",
        "do",
        "huggingface",
        "papers",
        "-f",
        "json",
      ]);
    } finally {
      cap.restore();
    }
    const envWith = JSON.parse(cap.getStdout());
    const hasSchema = (
      envWith.data.candidates as Array<Record<string, unknown>>
    ).some((m) => "args_schema" in m);
    expect(hasSchema).toBe(true);

    // without schema
    cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync([
        "node",
        "unicli",
        "do",
        "huggingface",
        "papers",
        "--no-schema",
        "-f",
        "json",
      ]);
    } finally {
      cap.restore();
    }
    const envSlim = JSON.parse(cap.getStdout());
    const hasSchemaSlim = (
      envSlim.data.candidates as Array<Record<string, unknown>>
    ).some((m) => "args_schema" in m);
    expect(hasSchemaSlim).toBe(false);
  });

  it("clamps --top to [1, 25] and respects requested top", async () => {
    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync([
        "node",
        "unicli",
        "do",
        "browser",
        "--top",
        "2",
        "-f",
        "json",
      ]);
    } finally {
      cap.restore();
    }
    const env = JSON.parse(cap.getStdout());
    expect((env.data.candidates as unknown[]).length).toBeLessThanOrEqual(2);
  });

  it("emits next_actions with the top match's invocation first", async () => {
    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync([
        "node",
        "unicli",
        "do",
        "browser",
        "click",
        "-f",
        "json",
      ]);
    } finally {
      cap.restore();
    }
    const env = JSON.parse(cap.getStdout());
    const actions = env.next_actions as Array<{ command: string }>;
    expect(actions.length).toBeGreaterThanOrEqual(2);
    expect(actions[0].command).toBe(env.data.match.invocation);
    const hasDescribe = actions.some((a) =>
      a.command.startsWith("unicli describe "),
    );
    expect(hasDescribe).toBe(true);
    const hasStdin = actions.some(
      (a) =>
        /\bunicli \S+ \S+\b/.test(a.command) && a.command.startsWith("echo"),
    );
    expect(hasStdin).toBe(true);
  });
});

describe("unicli do — empty path", () => {
  it("emits empty_result envelope on a no-signal query", async () => {
    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync([
        "node",
        "unicli",
        "do",
        "qqqqqqzzzzzzthisisnotacommand",
        "-f",
        "json",
      ]);
    } finally {
      cap.restore();
    }
    const env = JSON.parse(cap.getStdout());
    validateEnvelope(env);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("empty_result");
    expect(env.error.retryable).toBe(false);
    expect(process.exitCode).toBe(66);
    // next_actions should suggest broadening
    const acts = env.next_actions as Array<{ command: string }>;
    expect(acts.some((a) => a.command.startsWith("unicli search"))).toBe(true);
  });
});

describe("unicli do — invalid input", () => {
  it("emits invalid_input envelope when --top is non-numeric", async () => {
    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync([
        "node",
        "unicli",
        "do",
        "huggingface",
        "papers",
        "--top",
        "abc",
        "-f",
        "json",
      ]);
    } finally {
      cap.restore();
    }
    const env = JSON.parse(cap.getStdout());
    validateEnvelope(env);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("invalid_input");
    expect(env.error.message).toMatch(/--top/);
    expect(process.exitCode).toBe(2);
  });

  it("emits invalid_input envelope when --top exceeds hard limit", async () => {
    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync([
        "node",
        "unicli",
        "do",
        "huggingface",
        "papers",
        "--top",
        "999",
        "-f",
        "json",
      ]);
    } finally {
      cap.restore();
    }
    const env = JSON.parse(cap.getStdout());
    validateEnvelope(env);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("invalid_input");
    expect(env.error.message).toMatch(/exceeds hard limit/);
    expect(process.exitCode).toBe(2);
  });
});
