/**
 * @owner   tests::unit::local-event-log
 * @does    Proves privacy, corruption, retention, permissions, and failure visibility of the default local event store.
 * @needs   real temporary filesystem and src/runtime/local-event-log.ts
 * @feeds   local observability regression coverage
 * @breaks  Silent loss or permissive files would make production dogfood evidence untrustworthy.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetLocalEventLogForTests,
  appendLocalEvent,
  createLocalEvent,
  createLocalEventStore,
  LocalEventLogError,
  localEventPath,
  readLocalEvents,
} from "../../src/runtime/local-event-log.js";

const initialNoLog = process.env.UNICLI_NO_LOG;

describe("local event log", () => {
  let tempDir: string;
  let rootDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "unicli-local-log-"));
    rootDir = join(tempDir, "events");
    delete process.env.UNICLI_NO_LOG;
    delete process.env.UNICLI_NO_LEDGER;
    delete process.env.UNICLI_LOG_RETENTION_DAYS;
    _resetLocalEventLogForTests();
  });

  afterEach(() => {
    if (initialNoLog === undefined) delete process.env.UNICLI_NO_LOG;
    else process.env.UNICLI_NO_LOG = initialNoLog;
    delete process.env.UNICLI_NO_LEDGER;
    delete process.env.UNICLI_LOG_RETENTION_DAYS;
    rmSync(tempDir, { recursive: true, force: true });
  });

  function event(timestamp = "2026-07-18T12:34:56.000Z") {
    return createLocalEvent({
      event_name: "unicli.tool.call.completed",
      timestamp,
      invocation_id: "01KTEST0000000000000000000",
      trace_id: "01KTEST0000000000000000000",
      transport: "mcp",
      command: "github.search",
      site: "github",
      cmd: "search",
      strategy: "public",
      target_surface: "web",
      adapter_path: "src/adapters/github/search.yaml",
      outcome: "success",
      exit_code: 0,
      duration_ms: 42,
      result_count: 3,
      result_bytes: 512,
    });
  }

  it("appends one allowlisted event to an owner-only UTC day file", () => {
    const store = createLocalEventStore({ rootDir, retentionDays: 30 });
    const result = appendLocalEvent(event(), store);

    expect(result.ok).toBe(true);
    const path = localEventPath(store, "2026-07-18T12:34:56.000Z");
    expect(path).toBe(join(rootDir, "2026-07-18.jsonl"));
    expect(readLocalEvents(store)).toHaveLength(1);
    expect(readFileSync(path, "utf-8")).not.toContain("args");
    if (process.platform !== "win32") {
      expect(statSync(rootDir).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects non-allowlisted fields before they can persist", () => {
    const store = createLocalEventStore({ rootDir });
    const unsafe = { ...event(), args: { token: "secret" } };
    const result = appendLocalEvent(unsafe as never, store);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_event");
    expect(existsSync(rootDir)).toBe(false);
  });

  it("surfaces malformed complete JSONL with file and line", () => {
    const store = createLocalEventStore({ rootDir });
    expect(appendLocalEvent(event(), store).ok).toBe(true);
    appendFileSync(
      localEventPath(store, "2026-07-18T12:34:56.000Z"),
      "not-json\n",
    );

    expect(() => readLocalEvents(store)).toThrowError(
      expect.objectContaining<Partial<LocalEventLogError>>({
        code: "malformed_jsonl",
        line: 2,
      }),
    );
  });

  it("retains the configured UTC window and removes only expired day files", () => {
    mkdirSync(rootDir, { recursive: true });
    writeFileSync(join(rootDir, "2026-07-15.jsonl"), "expired\n");
    writeFileSync(join(rootDir, "2026-07-16.jsonl"), "retained\n");
    writeFileSync(join(rootDir, "notes.txt"), "untouched\n");
    const store = createLocalEventStore({ rootDir, retentionDays: 3 });

    expect(appendLocalEvent(event("2026-07-18T00:00:00.000Z"), store).ok).toBe(
      true,
    );
    expect(existsSync(join(rootDir, "2026-07-15.jsonl"))).toBe(false);
    expect(existsSync(join(rootDir, "2026-07-16.jsonl"))).toBe(true);
    expect(existsSync(join(rootDir, "notes.txt"))).toBe(true);
  });

  it("returns a typed write failure instead of silently swallowing it", () => {
    writeFileSync(rootDir, "not a directory");
    const result = appendLocalEvent(
      event(),
      createLocalEventStore({ rootDir }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("io_error");
      expect(result.error.message).toContain("failed to append local event");
    }
  });

  it.each(["UNICLI_NO_LOG", "UNICLI_NO_LEDGER"] as const)(
    "respects the %s privacy opt-out",
    (name) => {
      process.env[name] = "1";
      const result = appendLocalEvent(
        event(),
        createLocalEventStore({ rootDir }),
      );
      expect(result).toMatchObject({ ok: true, disabled: true });
      expect(existsSync(rootDir)).toBe(false);
    },
  );

  it("rejects invalid retention configuration rather than guessing", () => {
    process.env.UNICLI_LOG_RETENTION_DAYS = "forever";
    expect(() => createLocalEventStore({ rootDir })).toThrowError(
      expect.objectContaining<Partial<LocalEventLogError>>({
        code: "invalid_config",
      }),
    );
  });
});
