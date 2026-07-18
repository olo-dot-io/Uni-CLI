/**
 * @owner   tests::unit::cli-invocation-log
 * @does    Proves process-boundary CLI events correlate envelopes without persisting raw argv.
 * @needs   temporary local event store and CLI invocation observer
 * @feeds   core/fast-path/adapter logging regression coverage
 * @breaks  Argument leakage or missing terminal events would invalidate default local diagnostics.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetCliInvocationLogForTests,
  beginCliInvocationLogging,
  completeCliInvocation,
  observeCliOutput,
  observeCliTrace,
} from "../../src/runtime/cli-invocation-log.js";
import {
  _resetLocalEventLogForTests,
  createLocalEventStore,
  readLocalEvents,
} from "../../src/runtime/local-event-log.js";

const initialNoLog = process.env.UNICLI_NO_LOG;

describe("CLI invocation log", () => {
  let tempDir: string;
  let logRoot: string;
  let originalLogRoot: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "unicli-cli-log-"));
    logRoot = join(tempDir, "events");
    originalLogRoot = process.env.UNICLI_LOG_ROOT;
    process.env.UNICLI_LOG_ROOT = logRoot;
    delete process.env.UNICLI_NO_LOG;
    delete process.env.UNICLI_NO_LEDGER;
    _resetCliInvocationLogForTests();
    _resetLocalEventLogForTests();
  });

  afterEach(() => {
    _resetCliInvocationLogForTests();
    _resetLocalEventLogForTests();
    if (initialNoLog === undefined) delete process.env.UNICLI_NO_LOG;
    else process.env.UNICLI_NO_LOG = initialNoLog;
    if (originalLogRoot === undefined) delete process.env.UNICLI_LOG_ROOT;
    else process.env.UNICLI_LOG_ROOT = originalLogRoot;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("uses the rendered command and trace while excluding positional data", () => {
    beginCliInvocationLogging({
      argv: [
        "node",
        "unicli",
        "-f",
        "json",
        "github",
        "search",
        "must-not-persist",
      ],
      startedAt: Date.now() - 20,
      registerProcessHooks: false,
    });
    observeCliTrace("01KTRACE000000000000000000");
    observeCliOutput(
      {
        command: "github.search",
        duration_ms: 12,
        surface: "web",
      },
      321,
    );

    expect(completeCliInvocation(0)).toBeUndefined();
    const events = readLocalEvents(createLocalEventStore());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_name: "unicli.cli.invocation.completed",
      trace_id: "01KTRACE000000000000000000",
      transport: "cli",
      command: "github.search",
      target_surface: "web",
      outcome: "success",
      exit_code: 0,
      result_bytes: 321,
    });
    expect(JSON.stringify(events)).not.toContain("must-not-persist");
  });

  it("records typed error semantics from the rendered envelope", () => {
    beginCliInvocationLogging({
      argv: ["node", "unicli", "usage", "report"],
      registerProcessHooks: false,
    });
    observeCliOutput(
      {
        command: "core.usage",
        duration_ms: 1,
        surface: "system",
        error: {
          code: "invalid_input",
          message: "bad --since",
          step: 0,
          retryable: false,
        },
      },
      64,
    );

    completeCliInvocation(2);
    expect(readLocalEvents(createLocalEventStore())[0]).toMatchObject({
      command: "core.usage",
      target_surface: "system",
      outcome: "error",
      error_type: "invalid_input",
      error_step: 0,
      retryable: false,
    });
  });

  it("returns a visible warning when the terminal event cannot be written", () => {
    const blockedRoot = join(tempDir, "blocked");
    writeFileSync(blockedRoot, "not a directory");
    process.env.UNICLI_LOG_ROOT = blockedRoot;
    beginCliInvocationLogging({
      argv: ["node", "unicli", "list"],
      registerProcessHooks: false,
    });

    expect(completeCliInvocation(0)).toContain(
      "[local-log] failed to append local event",
    );
  });
});
