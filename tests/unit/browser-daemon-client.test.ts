import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchDaemonPortConflict,
  fetchDaemonStatus,
  selectDaemonSpawnPort,
  sendCommand,
} from "../../src/browser/daemon-client.js";

const originalCompatPort = process.env.UNICLI_COMPAT_DAEMON_PORT;
const originalUniCliPort = process.env.UNICLI_DAEMON_PORT;
const compatPortEnv = "UNICLI_COMPAT_DAEMON_PORT";
const compatHeader = "X-Unicli-Compat";

afterEach(() => {
  vi.useRealTimers();
  if (originalCompatPort === undefined) {
    delete process.env.UNICLI_COMPAT_DAEMON_PORT;
  } else {
    process.env.UNICLI_COMPAT_DAEMON_PORT = originalCompatPort;
  }
  if (originalUniCliPort === undefined) {
    delete process.env.UNICLI_DAEMON_PORT;
  } else {
    process.env.UNICLI_DAEMON_PORT = originalUniCliPort;
  }
  vi.unstubAllGlobals();
});

describe("daemon client compatibility", () => {
  it("uses an existing compatibility daemon port and header when configured", async () => {
    delete process.env.UNICLI_DAEMON_PORT;
    process.env[compatPortEnv] = "19826";

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        pid: 123,
        uptime: 1,
        extensionConnected: true,
        pending: 0,
        lastCliRequestTime: 1,
        memoryMB: 1,
        port: 19826,
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const status = await fetchDaemonStatus({ timeout: 50 });

    expect(status?.port).toBe(19826);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:19826/status",
      expect.objectContaining({
        headers: { [compatHeader]: "1" },
      }),
    );
  });

  it("retries transient debugger-detach command failures", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: false,
          error: "Debugger detached while handling command",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          data: { clicked: true },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = sendCommand("click", { ref: "12", timeout: 5 });
    await vi.advanceTimersByTimeAsync(1500);

    await expect(result).resolves.toEqual({ clicked: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports incompatible daemon responses on the configured port", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({
        ok: false,
        error: "Forbidden: missing X-External-Daemon header",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchDaemonPortConflict({ timeout: 50 })).resolves.toContain(
      "non-Uni-CLI browser daemon",
    );
  });

  it("selects the next daemon port when the default port belongs to another product", async () => {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      json: async () =>
        url.includes(":19825")
          ? { ok: true, product: "external-daemon" }
          : { ok: true, product: "unicli" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(selectDaemonSpawnPort({ timeout: 50 })).resolves.toBe(19826);
  });

  it("does not treat an occupied non-OK ping port as free", async () => {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: !url.includes(":19825"),
      status: url.includes(":19825") ? 403 : 200,
      json: async () => ({ ok: true, product: "unicli" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(selectDaemonSpawnPort({ timeout: 50 })).resolves.toBe(19826);
  });

  it("rejects when every daemon candidate port is occupied by another product", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, product: "external-daemon" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(selectDaemonSpawnPort({ timeout: 50 })).rejects.toThrow(
      "No available Uni-CLI daemon port",
    );
  });
});
