import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchDaemonStatus } from "../../src/browser/daemon-client.js";

const originalOpenCliPort = process.env.OPENCLI_DAEMON_PORT;
const originalUniCliPort = process.env.UNICLI_DAEMON_PORT;

afterEach(() => {
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
  it("uses an existing OpenCLI daemon port and header when configured", async () => {
    delete process.env.UNICLI_DAEMON_PORT;
    process.env.OPENCLI_DAEMON_PORT = "19826";

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
        headers: { "X-OpenCLI": "1" },
      }),
    );
  });
});
