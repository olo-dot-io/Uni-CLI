import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn(() => true));

// REASON: process creation is the external boundary; the real launch-attempt state machine and process-tree retirement code remain under test.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));
// REASON: build artifact discovery is the filesystem boundary; path selection and unsupported-state behavior remain under test.
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: existsSyncMock,
}));

describe("browser broker launch lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    spawnMock.mockReset();
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValue(true);
  });

  it("retires a live never-ready child before a later caller spawns again", async () => {
    const kill = installNeverReadyChildren();
    const { ensureBrowserRuntimeBroker } =
      await import("../../src/browser/runtime-launch.js");
    const runtimeRoot = `/tmp/unicli-launch-never-ready-${String(process.pid)}-${String(Date.now())}`;

    await expect(
      ensureBrowserRuntimeBroker({ runtimeRoot, startupTimeoutMs: 1 }),
    ).rejects.toMatchObject({ code: "browser_broker_start_failed" });
    await expect(
      ensureBrowserRuntimeBroker({ runtimeRoot, startupTimeoutMs: 1 }),
    ).rejects.toMatchObject({ code: "browser_broker_start_failed" });

    expect(spawnMock).toHaveBeenCalledTimes(2);
    for (const call of spawnMock.mock.calls) {
      expect(call[0]).toBe(process.execPath);
      expect(call[1]).toEqual([
        expect.stringMatching(/runtime-broker-main\.js$/),
      ]);
      expect(JSON.stringify(call[1])).not.toContain("tsx");
    }
    expect(kill).toHaveBeenCalledTimes(2);
  });

  it("reports the exact source-mode recovery when no compiled broker exists", async () => {
    existsSyncMock.mockReturnValue(false);
    const { ensureBrowserRuntimeBroker } =
      await import("../../src/browser/runtime-launch.js");
    const runtimeRoot = `/tmp/unicli-launch-missing-build-${String(process.pid)}-${String(Date.now())}`;

    await expect(
      ensureBrowserRuntimeBroker({ runtimeRoot, startupTimeoutMs: 1 }),
    ).rejects.toMatchObject({
      code: "browser_broker_start_failed",
      message: expect.stringContaining("Run `npm run build`"),
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("does not let a short-budget waiter retire a launch shared by a longer waiter", async () => {
    const kill = installNeverReadyChildren();
    const { ensureBrowserRuntimeBroker } =
      await import("../../src/browser/runtime-launch.js");
    const runtimeRoot = `/tmp/unicli-launch-shared-budget-${String(process.pid)}-${String(Date.now())}`;

    const short = ensureBrowserRuntimeBroker({
      runtimeRoot,
      startupTimeoutMs: 1,
    });
    const long = ensureBrowserRuntimeBroker({
      runtimeRoot,
      startupTimeoutMs: 120,
    });

    await expect(short).rejects.toMatchObject({
      code: "browser_broker_start_failed",
    });
    expect(kill).not.toHaveBeenCalled();
    await expect(long).rejects.toMatchObject({
      code: "browser_broker_start_failed",
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("keeps probing after a candidate exits because another process may own the broker lock", async () => {
    const kill = installNeverReadyChildren();
    const { ensureBrowserRuntimeBroker } =
      await import("../../src/browser/runtime-launch.js");
    const runtimeRoot = `/tmp/unicli-launch-contended-${String(process.pid)}-${String(Date.now())}`;

    const connection = ensureBrowserRuntimeBroker({
      runtimeRoot,
      startupTimeoutMs: 25,
    });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    const child = spawnMock.mock.results[0]!.value as ChildProcess;
    Object.assign(child, { exitCode: 1 });
    child.emit("exit", 1, null);

    await expect(connection).rejects.toMatchObject({
      code: "browser_broker_start_failed",
      message: expect.stringContaining("did not become ready"),
    });
    expect(kill).toHaveBeenCalledTimes(1);
  });
});

function installNeverReadyChildren(): ReturnType<typeof vi.fn> {
  const children = new Map<number, ChildProcess>();
  const termination = vi.fn();
  let nextPid = 800_000;
  spawnMock.mockImplementation(() => {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      pid: nextPid++,
      exitCode: null,
      signalCode: null,
      unref: vi.fn(),
      kill: vi.fn(() => true),
    });
    children.set(child.pid!, child);
    return child;
  });
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    const child = children.get(Math.abs(pid));
    if (!child) return true;
    if (signal === 0) {
      if (child.signalCode === null) return true;
      const error = new Error(
        "process group does not exist",
      ) as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    }
    Object.assign(child, { signalCode: signal ?? "SIGTERM" });
    termination(pid, signal);
    return true;
  });
  return termination;
}
