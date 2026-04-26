import { describe, expect, it, vi } from "vitest";

const daemonMock = vi.hoisted(() => ({
  sendCommand: vi.fn(),
}));

vi.mock("../../src/browser/daemon-client.js", () => ({
  fetchDaemonStatus: vi.fn(),
  sendCommand: daemonMock.sendCommand,
}));

import { DaemonPage } from "../../src/browser/bridge.js";

describe("DaemonPage", () => {
  it("returns already-unwrapped exec results from evaluate", async () => {
    daemonMock.sendCommand.mockResolvedValueOnce("content");
    const page = new DaemonPage("test-workspace");

    await expect(page.evaluate("document.body.innerText")).resolves.toBe(
      "content",
    );
  });
});
