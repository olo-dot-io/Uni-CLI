import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  createRunCompletedEvent,
  createRunEventSequence,
  createRunStartedEvent,
  type RunTraceMetadata,
} from "../../src/engine/session/events.js";
import {
  appendRunEvent,
  createRunStore,
  readRunEvents,
  RunStoreError,
  runTracePath,
  watchRunEvents,
} from "../../src/engine/session/store.js";

const metadata: RunTraceMetadata = {
  run_id: "run-store-01",
  trace_id: "01HXTRACESTORE000000000000",
  command: "demo.list",
  site: "demo",
  cmd: "list",
  adapter_path: "src/adapters/demo/list.yaml",
  permission_profile: "open",
  transport_surface: "cli",
  target_surface: "web",
  args_hash: "sha256:store",
  pipeline_steps: 0,
};

const originalRunRoot = process.env.UNICLI_RUN_ROOT;

describe("session JSONL store", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "unicli-session-store-"));
    delete process.env.UNICLI_RUN_ROOT;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (originalRunRoot === undefined) {
      delete process.env.UNICLI_RUN_ROOT;
    } else {
      process.env.UNICLI_RUN_ROOT = originalRunRoot;
    }
  });

  it("creates ~/.unicli/runs/<run_id>/trace.jsonl under an isolated home", async () => {
    const store = createRunStore({ homeDir: tmp });
    const sequence = createRunEventSequence();
    const event = createRunStartedEvent(metadata, sequence);

    await appendRunEvent(store, event);

    const tracePath = join(
      tmp,
      ".unicli",
      "runs",
      "run-store-01",
      "trace.jsonl",
    );
    expect(runTracePath(store, "run-store-01")).toBe(tracePath);
    expect(existsSync(tracePath)).toBe(true);
  });

  it("keeps an explicit home isolated from UNICLI_RUN_ROOT", async () => {
    const envRoot = join(tmp, "env-runs");
    process.env.UNICLI_RUN_ROOT = envRoot;
    const explicitHome = join(tmp, "explicit-home");
    const store = createRunStore({ homeDir: explicitHome });
    const sequence = createRunEventSequence();

    await appendRunEvent(store, createRunStartedEvent(metadata, sequence));

    const tracePath = join(
      explicitHome,
      ".unicli",
      "runs",
      "run-store-01",
      "trace.jsonl",
    );
    expect(runTracePath(store, "run-store-01")).toBe(tracePath);
    expect(existsSync(tracePath)).toBe(true);
    expect(existsSync(envRoot)).toBe(false);
  });

  it("creates run trace directories and files with private POSIX permissions", async () => {
    if (process.platform === "win32") return;
    const store = createRunStore({ rootDir: join(tmp, "runs") });
    const sequence = createRunEventSequence();
    const event = createRunStartedEvent(metadata, sequence, {
      secret: { token: "abc" },
    });

    await appendRunEvent(store, event);

    const tracePath = runTracePath(store, "run-store-01");
    expect(statSync(dirname(tracePath)).mode & 0o777).toBe(0o700);
    expect(statSync(tracePath).mode & 0o777).toBe(0o600);
  });

  it("appends exactly one JSON object per line and replays in append order", async () => {
    const store = createRunStore({ rootDir: join(tmp, "runs") });
    const sequence = createRunEventSequence();
    const first = createRunStartedEvent(metadata, sequence);
    const second = createRunStartedEvent(
      { ...metadata, run_id: "run-store-01" },
      sequence,
    );

    await appendRunEvent(store, first);
    const firstRaw = readFileSync(runTracePath(store, "run-store-01"), "utf-8");
    await appendRunEvent(store, second);

    const raw = readFileSync(runTracePath(store, "run-store-01"), "utf-8");
    const lines = raw.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(raw.startsWith(firstRaw)).toBe(true);
    expect(JSON.parse(lines[0])).toEqual(first);
    expect(JSON.parse(lines[1])).toEqual(second);

    await expect(readRunEvents(store, "run-store-01")).resolves.toEqual([
      first,
      second,
    ]);
  });

  it("reports malformed JSONL replay as a structured store error", async () => {
    const store = createRunStore({ rootDir: join(tmp, "runs") });
    const tracePath = runTracePath(store, "broken-run");
    mkdirSync(dirname(tracePath), { recursive: true });
    appendFileSync(tracePath, "not-json\n", "utf-8");

    await expect(readRunEvents(store, "broken-run")).rejects.toMatchObject({
      code: "malformed_jsonl",
      line: 1,
      path: tracePath,
    } satisfies Partial<RunStoreError>);
  });

  it("watches appended run events after a sequence until terminal", async () => {
    const store = createRunStore({ rootDir: join(tmp, "runs") });
    const sequence = createRunEventSequence();

    const streamed = (async () => {
      const names: string[] = [];
      for await (const event of watchRunEvents(store, "run-store-01", {
        afterSequence: 1,
        follow: true,
        pollIntervalMs: 5,
        timeoutMs: 500,
      })) {
        names.push(event.name);
      }
      return names;
    })();

    await appendRunEvent(store, createRunStartedEvent(metadata, sequence));
    await delay(20);
    await appendRunEvent(
      store,
      createRunCompletedEvent(metadata, sequence, { status: "ok" }),
    );

    await expect(streamed).resolves.toEqual(["run.completed"]);
  });
});
