/**
 * @owner   tests::unit::local-event-log
 * @does    Proves privacy, corruption, retention, permissions, and failure visibility of the default local event store.
 * @needs   real temporary filesystem and src/runtime/local-event-log.ts
 * @feeds   local observability regression coverage
 * @breaks  Silent loss or permissive files would make production dogfood evidence untrustworthy.
 */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
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
  MAX_LOCAL_DAY_BYTES,
  MAX_LOCAL_TOTAL_BYTES,
  readLocalEvents,
} from "../../src/runtime/local-event-log.js";
import { withRecoverableFileStoreLock } from "../../src/runtime/recoverable-file-lock.js";

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

  function timestampForDayOffset(offset: number): string {
    return new Date(Date.now() + offset * 86_400_000).toISOString();
  }

  function dayForOffset(offset: number): string {
    return timestampForDayOffset(offset).slice(0, 10);
  }

  function event(timestamp = timestampForDayOffset(0)) {
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
      operation_role: "standalone",
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
    const path = localEventPath(store, timestampForDayOffset(0));
    expect(path).toBe(join(rootDir, `${dayForOffset(0)}.jsonl`));
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

  it("requires the complete schema and finite numeric fields", () => {
    const store = createLocalEventStore({ rootDir });
    const missingSeverity = { ...event() } as Record<string, unknown>;
    delete missingSeverity.severity_text;
    const incomplete = appendLocalEvent(missingSeverity as never, store);
    expect(incomplete.ok).toBe(false);
    if (!incomplete.ok) expect(incomplete.error.code).toBe("invalid_event");

    const nonFinite = appendLocalEvent(
      { ...event(), duration_ms: Number.NaN },
      store,
    );
    expect(nonFinite.ok).toBe(false);
    if (!nonFinite.ok) expect(nonFinite.error.code).toBe("invalid_event");
    expect(existsSync(rootDir)).toBe(false);
  });

  it("rejects adapter filesystem paths from the current schema", () => {
    const result = appendLocalEvent(
      {
        ...event(),
        adapter_path: "/Users/alice/.unicli/adapters/x/y.yaml",
      } as never,
      createLocalEventStore({ rootDir }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_event");
  });

  it("surfaces malformed complete JSONL with file and line", () => {
    const store = createLocalEventStore({ rootDir });
    expect(appendLocalEvent(event(), store).ok).toBe(true);
    appendFileSync(
      localEventPath(store, timestampForDayOffset(0)),
      "not-json\n",
    );

    expect(() => readLocalEvents(store)).toThrowError(
      expect.objectContaining<Partial<LocalEventLogError>>({
        code: "malformed_jsonl",
        line: 2,
      }),
    );
  });

  it("rejects oversized and symlinked day files before reading bytes", () => {
    mkdirSync(rootDir, { recursive: true });
    const store = createLocalEventStore({ rootDir });
    const dayPath = localEventPath(store, timestampForDayOffset(0));
    writeFileSync(dayPath, "");
    truncateSync(dayPath, MAX_LOCAL_DAY_BYTES + 1);
    expect(() => readLocalEvents(store)).toThrowError(
      expect.objectContaining<Partial<LocalEventLogError>>({
        code: "capacity_exceeded",
        path: dayPath,
      }),
    );

    if (process.platform === "win32") return;
    rmSync(dayPath);
    const external = join(tempDir, "external.jsonl");
    writeFileSync(external, `${JSON.stringify(event())}\n`);
    symlinkSync(external, dayPath);
    expect(() => readLocalEvents(store)).toThrowError(
      expect.objectContaining<Partial<LocalEventLogError>>({
        code: "io_error",
        path: dayPath,
      }),
    );
  });

  it("strictly reads legacy schema-v1 rows without writing new v1 rows", () => {
    mkdirSync(rootDir, { recursive: true });
    const current = event();
    const legacy = {
      ...current,
      schema_version: "1",
      adapter_path: "/Users/alice/.unicli/adapters/github/search.yaml",
    } as Record<string, unknown>;
    delete legacy.operation_role;
    delete legacy.parent_invocation_id;
    writeFileSync(
      join(rootDir, `${dayForOffset(0)}.jsonl`),
      `${JSON.stringify(legacy)}\n`,
    );

    expect(readLocalEvents(createLocalEventStore({ rootDir }))).toEqual([
      legacy,
    ]);
    expect(
      appendLocalEvent(legacy as never, createLocalEventStore({ rootDir })).ok,
    ).toBe(false);
  });

  it("filters retention before reading and ignores corrupt expired files", () => {
    mkdirSync(rootDir, { recursive: true });
    const expiredPath = join(rootDir, `${dayForOffset(-3)}.jsonl`);
    const retainedPath = join(rootDir, `${dayForOffset(-2)}.jsonl`);
    writeFileSync(expiredPath, "expired-corruption\n");
    writeFileSync(
      retainedPath,
      `${JSON.stringify(event(timestampForDayOffset(-2)))}\n`,
    );
    const store = createLocalEventStore({ rootDir, retentionDays: 3 });

    expect(readLocalEvents(store)).toHaveLength(1);
    expect(existsSync(expiredPath)).toBe(true);
  });

  it("prunes expired files before append and retries maintenance failures", () => {
    mkdirSync(rootDir, { recursive: true });
    const obstructingPath = join(rootDir, `${dayForOffset(-3)}.jsonl`);
    mkdirSync(obstructingPath);
    const store = createLocalEventStore({ rootDir, retentionDays: 3 });

    const first = appendLocalEvent(event(), store);
    expect(first.ok).toBe(false);
    rmSync(obstructingPath, { recursive: true });
    expect(appendLocalEvent(event(), store).ok).toBe(true);
  });

  it("reclaims a complete lock whose owner process no longer exists", () => {
    mkdirSync(rootDir, { recursive: true });
    const terminated = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    if (!terminated.pid) throw new Error("failed to observe terminated child");
    const candidateName = `.write.lock.candidate.${String(terminated.pid)}.stale-owner`;
    const owner = `${JSON.stringify({
      pid: terminated.pid,
      candidate_name: candidateName,
      acquired_at: new Date().toISOString(),
    })}\n`;
    writeFileSync(join(rootDir, candidateName), owner, { mode: 0o600 });
    linkSync(join(rootDir, candidateName), join(rootDir, ".write.lock"));
    writeFileSync(
      join(rootDir, `.write.lock.candidate.${String(terminated.pid)}.orphan`),
      "abandoned candidate\n",
      { mode: 0o600 },
    );
    const diagnosticEvent = event();
    const startedAt = Date.now();

    const result = appendLocalEvent(
      diagnosticEvent,
      createLocalEventStore({ rootDir }),
    );

    expect(result.ok).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(
      readdirSync(rootDir).filter((name) => name.startsWith(".write.lock")),
    ).toEqual([]);
  });

  it("retains both an operation failure and a lock-release failure", () => {
    mkdirSync(rootDir, { recursive: true });

    expect(() =>
      withRecoverableFileStoreLock(rootDir, () => {
        unlinkSync(join(rootDir, ".write.lock"));
        throw new Error("operation failed after acquiring the lock");
      }),
    ).toThrowError(
      expect.objectContaining<Partial<AggregateError>>({
        message: "file-store operation and lock release both failed",
        errors: expect.arrayContaining([
          expect.objectContaining({
            message: "operation failed after acquiring the lock",
          }),
          expect.objectContaining({ code: "ENOENT" }),
        ]),
      }),
    );
  });

  it("enforces hard daily and total byte ceilings", () => {
    mkdirSync(rootDir, { recursive: true });
    const store = createLocalEventStore({ rootDir, retentionDays: 30 });
    const todayPath = join(rootDir, `${dayForOffset(0)}.jsonl`);
    writeFileSync(todayPath, "");
    truncateSync(todayPath, MAX_LOCAL_DAY_BYTES);
    const daily = appendLocalEvent(event(), store);
    expect(daily.ok).toBe(false);
    if (!daily.ok) expect(daily.error.code).toBe("capacity_exceeded");

    rmSync(rootDir, { recursive: true });
    mkdirSync(rootDir, { recursive: true });
    const fileCount =
      Math.ceil(MAX_LOCAL_TOTAL_BYTES / MAX_LOCAL_DAY_BYTES) + 1;
    const bytesPerFile = Math.floor(MAX_LOCAL_TOTAL_BYTES / fileCount);
    let remainingBytes = MAX_LOCAL_TOTAL_BYTES;
    for (let index = 0; index < fileCount; index += 1) {
      const path = join(rootDir, `${dayForOffset(-index)}.jsonl`);
      writeFileSync(path, "");
      const fileBytes = index === fileCount - 1 ? remainingBytes : bytesPerFile;
      truncateSync(path, fileBytes);
      remainingBytes -= fileBytes;
    }
    const total = appendLocalEvent(event(), store);
    expect(total.ok).toBe(false);
    if (!total.ok) {
      expect(total.error.code).toBe("capacity_exceeded");
      expect(total.error.message).toContain("store exceeds");
    }
  });

  it("does not chmod an existing user-selected root", () => {
    if (process.platform === "win32") return;
    mkdirSync(rootDir, { recursive: true });
    chmodSync(rootDir, 0o755);

    expect(
      appendLocalEvent(event(), createLocalEventStore({ rootDir })).ok,
    ).toBe(true);
    expect(statSync(rootDir).mode & 0o777).toBe(0o755);
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
