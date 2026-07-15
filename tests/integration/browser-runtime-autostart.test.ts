import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensureBrowserRuntimeBroker,
  probeBrowserRuntimeBroker,
} from "../../src/browser/runtime-launch.js";

let runtimeRoot: string | null = null;

afterEach(async () => {
  if (!runtimeRoot) return;
  try {
    const { client } = await probeBrowserRuntimeBroker({
      runtimeRoot,
      timeoutMs: 1_000,
    });
    await client.requestOrThrow({
      id: randomUUID(),
      action: "broker.shutdown",
    });
  } catch {
    // The assertion path may have stopped the broker already.
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(runtimeRoot, { recursive: true, force: true });
  runtimeRoot = null;
});

describe("browser broker lazy auto-start", () => {
  it("coalesces cold callers on one service without starting a browser", async () => {
    runtimeRoot = mkdtempSync(join(tmpdir(), "unicli-broker-autostart-"));
    const connections = await Promise.all(
      Array.from({ length: 8 }, () =>
        ensureBrowserRuntimeBroker({ runtimeRoot, timeoutMs: 10_000 }),
      ),
    );

    expect(
      new Set(connections.map(({ status }) => status.runtime_id)).size,
    ).toBe(1);
    expect(
      new Set(connections.map(({ status }) => status.broker_pid)).size,
    ).toBe(1);
    expect(connections.every(({ spawned }) => spawned)).toBe(true);
    expect(connections[0]?.status.providers.managed).toEqual([]);
    expect(connections[0]?.status.providers.chrome.connected).toBe(false);

    const warm = await ensureBrowserRuntimeBroker({ runtimeRoot });
    expect(warm.spawned).toBe(false);
    expect(warm.status.broker_pid).toBe(connections[0]?.status.broker_pid);
  });
});
