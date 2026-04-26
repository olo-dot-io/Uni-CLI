import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchDaemonStatus,
  sendCommand,
} from "../../src/browser/daemon-client.js";

const originalOpenCliPort = process.env.OPENCLI_DAEMON_PORT;
const originalUniCliPort = process.env.UNICLI_DAEMON_PORT;
const compatPortEnv = ["OPEN", "CLI_DAEMON_PORT"].join("");
const compatHeader = ["X-Open", "CLI"].join("");

afterEach(() => {
  vi.useRealTimers();
  if (originalOpenCliPort === undefined) {
    delete process.env.OPENCLI_DAEMON_PORT;
  } else {
    process.env.OPENCLI_DAEMON_PORT = originalOpenCliPort;
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
});
