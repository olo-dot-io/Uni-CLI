/**
 * SubprocessTransport adapter tests.
 *
 * SubprocessTransport spawns OS subprocesses with the same contract as
 * the existing `exec` pipeline step (stdin/stdout/stderr/env/cwd).
 * Each action run must emit an envelope — `action()` never throws.
 */

import { describe, it, expect } from "vitest";
import { SubprocessTransport } from "../../../../src/transport/adapters/subprocess.js";
import { createTransportBus } from "../../../../src/transport/bus.js";
import type { TransportContext } from "../../../../src/transport/types.js";

function makeCtx(): TransportContext {
  return { vars: {}, bus: createTransportBus() };
}

describe("SubprocessTransport", () => {
  it("declares kind = subprocess", () => {
    const t = new SubprocessTransport();
    expect(t.kind).toBe("subprocess");
  });

  it("declares capability.steps includes exec, write_temp, download", () => {
    const t = new SubprocessTransport();
    expect(t.capability.steps).toEqual(
      expect.arrayContaining(["exec", "write_temp", "download"]),
    );
    expect(t.capability.mutatesHost).toBe(true);
  });

  it("runs echo successfully and returns stdout", async () => {
    const t = new SubprocessTransport();
    await t.open(makeCtx());
    const res = await t.action<{ stdout: string; exitCode: number }>({
      kind: "exec",
      params: { command: "echo", args: ["hello", "world"] },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.stdout).toMatch(/hello world/);
      expect(res.data.exitCode).toBe(0);
    }
  });

  it("returns err envelope for a non-zero exit", async () => {
    const t = new SubprocessTransport();
    await t.open(makeCtx());
    const res = await t.action({
      kind: "exec",
      params: { command: "sh", args: ["-c", "exit 3"] },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.transport).toBe("subprocess");
      expect(res.error.reason).toMatch(/3|exit/i);
    }
  });

  it("returns err envelope for missing command param", async () => {
    const t = new SubprocessTransport();
    await t.open(makeCtx());
    const res = await t.action({ kind: "exec", params: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.reason).toMatch(/command/i);
      expect(res.error.exit_code).toBe(2);
    }
  });

  it("never throws on unknown binary — returns err envelope", async () => {
    const t = new SubprocessTransport();
    await t.open(makeCtx());
    const res = await t.action({
      kind: "exec",
      params: { command: "this-binary-does-not-exist-xyz" },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.transport).toBe("subprocess");
    }
  });

  it("passes stdin to the child process", async () => {
    const t = new SubprocessTransport();
    await t.open(makeCtx());
    const res = await t.action<{ stdout: string }>({
      kind: "exec",
      params: { command: "cat", args: [], stdin: "piped-content" },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.stdout).toMatch(/piped-content/);
    }
  });

  it("unknown action returns err envelope", async () => {
    const t = new SubprocessTransport();
    await t.open(makeCtx());
    const res = await t.action({ kind: "not_a_step", params: {} });
    expect(res.ok).toBe(false);
  });

  it("close is idempotent", async () => {
    const t = new SubprocessTransport();
    await t.open(makeCtx());
    await t.close();
    await t.close();
  });

  it("stream yields stdout events during exec", async () => {
    const t = new SubprocessTransport();
    await t.open(makeCtx());
    const events: string[] = [];
    // Start streaming first, then fire an action.
    const streamTask = (async () => {
      // Stream captures events only until the adapter closes or emits EOF.
      // We stop after we've seen both an action completion and the stdout.
      const iter = t.stream?.();
      if (!iter) return;
      for await (const e of iter) {
        if (e.kind === "stdout") {
          events.push(String(e.payload));
        }
        if (events.length > 0) break;
      }
    })();
    // Run a cheap action that pushes stdout events.
    await t.action({
      kind: "exec",
      params: { command: "echo", args: ["stream-probe"] },
    });
    // Give stream loop a tick to consume events.
    await new Promise((r) => setTimeout(r, 50));
    await t.close();
    await streamTask;
    expect(events.some((e) => e.includes("stream-probe"))).toBe(true);
  });
});
