import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Command } from "commander";

import { registerEvolveCommand } from "../../../src/commands/evolve.js";
import { registerAdapter } from "../../../src/registry.js";
import { AdapterType, ExitCode } from "../../../src/types.js";

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

  it("lists an empty local evolution store through inspect", async () => {
    const capture = captureConsole();
    try {
      await createProgram().parseAsync(
        ["-f", "json", "evolve", "inspect", "--root", root],
        { from: "user" },
      );
    } finally {
      capture.restore();
    }

    const envelope = JSON.parse(capture.stdout().trim()) as {
      ok: boolean;
      command: string;
      data: {
        root: string;
        sessions: unknown[];
        invalid_sessions: unknown[];
      };
    };
    expect(envelope).toMatchObject({
      ok: true,
      command: "evolve.inspect",
      data: { root, sessions: [], invalid_sessions: [] },
    });
    expect(capture.stderr()).toBe("");
  });

  it("surfaces corrupt sessions instead of silently dropping them", async () => {
    const corruptRoot = join(root, "evo-corrupt");
    mkdirSync(corruptRoot, { recursive: true });
    writeFileSync(join(corruptRoot, "session.json"), "{}\n");
    const capture = captureConsole();
    try {
      await createProgram().parseAsync(
        ["-f", "json", "evolve", "inspect", "--root", root],
        { from: "user" },
      );
    } finally {
      capture.restore();
    }

    const envelope = JSON.parse(capture.stdout().trim()) as {
      data: {
        sessions: unknown[];
        invalid_sessions: Array<{
          session_id: string;
          code: string;
          message: string;
        }>;
      };
    };
    expect(envelope.data.sessions).toEqual([]);
    expect(envelope.data.invalid_sessions).toEqual([
      expect.objectContaining({
        session_id: "evo-corrupt",
        code: "invalid_session",
        message: expect.stringContaining("invalid evolution session manifest"),
      }),
    ]);
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

  it("reports evolution storage failures as internal errors", async () => {
    const fileRoot = join(root, "not-a-directory");
    writeFileSync(fileRoot, "fixture\n");
    const capture = captureConsole();
    try {
      await createProgram().parseAsync(
        ["-f", "json", "evolve", "inspect", "--root", fileRoot],
        { from: "user" },
      );
    } finally {
      capture.restore();
    }

    const envelope = JSON.parse(capture.stderr().trim()) as {
      error: { code: string; message: string };
    };
    expect(envelope.error).toMatchObject({
      code: "internal_error",
      message: expect.stringContaining("failed to list evolution artifact"),
    });
    expect(process.exitCode).toBe(ExitCode.GENERIC_ERROR);
  });

  it("reports an invalid evolution permission profile as input", async () => {
    const adapterPath = join(root, "probe.yaml");
    writeFileSync(
      adapterPath,
      [
        "site: evolve-command-fixture",
        "name: probe",
        "description: Probe invalid permission handling",
        "type: web-api",
        "strategy: public",
        "operation_effect: read",
        "pipeline:",
        "  - fetch:",
        "      url: https://example.com/status",
        "capabilities: [http.fetch]",
        "minimum_capability: http.fetch",
        "trust: public",
        "confidentiality: public",
        "quarantine: false",
        "schema_version: v2",
        "",
      ].join("\n"),
    );
    registerAdapter({
      name: "evolve-command-fixture",
      type: AdapterType.WEB_API,
      commands: {
        probe: {
          name: "probe",
          adapter_path: adapterPath,
          source_tier: "user",
          operation_effect: "read",
          pipeline: [{ fetch: { url: "https://example.com/status" } }],
        },
      },
    });
    const capture = captureConsole();
    try {
      await createProgram().parseAsync(
        [
          "-f",
          "json",
          "--permission-profile",
          "nonsense",
          "evolve",
          "adapter",
          "evolve-command-fixture",
          "probe",
          "--run",
          "missing",
          "--root",
          root,
        ],
        { from: "user" },
      );
    } finally {
      capture.restore();
    }

    const envelope = JSON.parse(capture.stderr().trim()) as {
      error: { code: string; message: string };
    };
    expect(envelope.error).toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("invalid permission profile"),
    });
    expect(process.exitCode).toBe(ExitCode.CONFIG_ERROR);
  });
});
