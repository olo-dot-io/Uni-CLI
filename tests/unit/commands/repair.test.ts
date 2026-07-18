import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Command } from "commander";
import { registerRepairCommand } from "../../../src/commands/repair.js";
import { registerAdapter } from "../../../src/registry.js";
import { AdapterType } from "../../../src/types.js";
import { validateEnvelope } from "../../../src/output/envelope.js";

function captureConsole(): {
  stdout: () => string;
  stderr: () => string;
  restore: () => void;
} {
  let stdout = "";
  let stderr = "";
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => {
    stdout += `${args.map(String).join(" ")}\n`;
  };
  console.error = (...args: unknown[]) => {
    stderr += `${args.map(String).join(" ")}\n`;
  };
  return {
    stdout: () => stdout,
    stderr: () => stderr,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

function program(): Command {
  const command = new Command();
  command.exitOverride();
  command.configureOutput({ writeErr: () => undefined });
  command.option("-f, --format <format>");
  command.option("--args-file <path>");
  registerRepairCommand(command);
  return command;
}

beforeAll(() => {
  registerAdapter({
    name: "repair-unit-fixture",
    type: AdapterType.WEB_API,
    commands: {
      ping: {
        name: "ping",
        adapter_path: "src/adapters/repair-unit-fixture/ping.yaml",
        pipeline: [],
      },
    },
  });
  registerAdapter({
    name: "repair-required-fixture",
    type: AdapterType.WEB_API,
    commands: {
      read: {
        name: "read",
        adapter_path: "src/adapters/repair-required-fixture/read.yaml",
        adapterArgs: [
          { name: "url", type: "str", required: true, positional: true },
        ],
        pipeline: [],
      },
    },
  });
});

afterEach(() => {
  process.exitCode = undefined;
});

describe("unicli repair command truth contract", () => {
  it("emits a mutation-free dry-run envelope", async () => {
    const capture = captureConsole();
    process.exitCode = 75;
    try {
      await program().parseAsync(
        ["-f", "json", "repair", "repair-unit-fixture", "ping", "--dry-run"],
        { from: "user" },
      );
    } finally {
      capture.restore();
    }

    const envelope = JSON.parse(capture.stdout().trim());
    validateEnvelope(envelope);
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toBe("repair.plan");
    expect(envelope.data).toMatchObject({
      mode: "verification-plan",
      mutates_source: false,
      target: {
        site: "repair-unit-fixture",
        command: "ping",
        adapter_path: "src/adapters/repair-unit-fixture/ping.yaml",
      },
      repair_budget: { max_attempts: 3 },
    });
    expect(process.exitCode).toBe(0);
  });

  it("returns an error envelope and usage exit for an unknown target", async () => {
    const capture = captureConsole();
    try {
      await program().parseAsync(
        ["-f", "json", "repair", "missing-site", "missing-command"],
        { from: "user" },
      );
    } finally {
      capture.restore();
    }

    const envelope = JSON.parse(capture.stderr().trim());
    validateEnvelope(envelope);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("invalid_input");
    expect(envelope.error.exit_code).toBe(2);
    expect(process.exitCode).toBe(2);
  });

  it("requires the original argv before verifying a parameterized command", async () => {
    const capture = captureConsole();
    try {
      await program().parseAsync(
        ["-f", "json", "repair", "repair-required-fixture", "read"],
        { from: "user" },
      );
    } finally {
      capture.restore();
    }

    const envelope = JSON.parse(capture.stderr().trim());
    validateEnvelope(envelope);
    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: "invalid_input",
        exit_code: 2,
      },
    });
    expect(envelope.error.message).toContain(
      "requires original arguments: url",
    );
    expect(envelope.error.suggestion).toContain("--target-args");
    expect(process.exitCode).toBe(2);
  });

  it("rejects the removed autonomous loop surface", async () => {
    const capture = captureConsole();
    try {
      await expect(
        program().parseAsync(
          ["repair", "repair-unit-fixture", "ping", "--loop"],
          { from: "user" },
        ),
      ).rejects.toMatchObject({ code: "commander.unknownOption" });
    } finally {
      capture.restore();
    }
  });
});
