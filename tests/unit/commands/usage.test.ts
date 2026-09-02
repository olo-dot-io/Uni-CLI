/**
 * @owner   tests::unit::commands::usage
 * @does    Exercises the real Commander registration and structured success/error envelopes for usage reports.
 * @needs   temporary legacy/event paths and output formatter
 * @feeds   CLI usage-report acceptance contract
 * @breaks  Wrong exits, stdout/stderr routing, or surface metadata mislead agents consuming diagnostics.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerUsageCommands } from "../../../src/commands/usage.js";

describe("usage report command", () => {
  let tempDir: string;
  let ledgerPath: string;
  let logDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "unicli-usage-command-"));
    ledgerPath = join(tempDir, "usage.jsonl");
    logDir = join(tempDir, "events");
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = originalExitCode;
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function run(...args: string[]): Promise<void> {
    const program = new Command();
    program.exitOverride();
    program.option("-f, --format <format>");
    registerUsageCommands(program);
    await program.parseAsync(
      [
        "usage",
        "report",
        "--ledger",
        ledgerPath,
        "--log-dir",
        logDir,
        "--json",
        ...args,
      ],
      { from: "user" },
    );
  }

  it("renders an empty system-surface report with explicit source counts", async () => {
    await run();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledOnce();
    const envelope = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(envelope).toMatchObject({
      ok: true,
      command: "core.usage",
      meta: { surface: "system" },
      data: {
        records: 0,
        window: "all",
        sources: { legacy: 0, events: 0 },
        rows: [],
      },
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("rejects invalid windows and limits with exit 2 on stderr", async () => {
    await run("--since", "7days");
    expect(logSpy).not.toHaveBeenCalled();
    let envelope = JSON.parse(String(errorSpy.mock.calls[0][0]));
    expect(envelope).toMatchObject({
      ok: false,
      command: "core.usage",
      meta: { surface: "system" },
      error: { code: "invalid_input", retryable: false },
    });
    expect(process.exitCode).toBe(2);

    errorSpy.mockClear();
    process.exitCode = undefined;
    await run("--limit", "20junk");
    envelope = JSON.parse(String(errorSpy.mock.calls[0][0]));
    expect(envelope.error.message).toContain("--limit");
    expect(process.exitCode).toBe(2);
  });

  it("surfaces corrupt legacy evidence with exit 78 and its line", async () => {
    writeFileSync(ledgerPath, "not-json\n");
    await run();

    const envelope = JSON.parse(String(errorSpy.mock.calls[0][0]));
    expect(envelope.error).toMatchObject({
      code: "local_log_corrupt",
      retryable: false,
    });
    expect(envelope.error.message).toContain("line 1");
    expect(process.exitCode).toBe(78);
  });

  it("surfaces corrupt event evidence instead of silently dropping it", async () => {
    const eventLogFile = new Date().toISOString().slice(0, 10) + ".jsonl";
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, eventLogFile), "not-json\n");
    await run();

    const envelope = JSON.parse(String(errorSpy.mock.calls[0][0]));
    expect(envelope.error.code).toBe("local_log_corrupt");
    expect(envelope.error.message).toContain(eventLogFile);
    expect(envelope.error.message).toContain("line 1");
    expect(process.exitCode).toBe(78);
  });
});
