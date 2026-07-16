import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ManagedBrowserProvider,
  type ManagedBrowserTarget,
  type ManagedBrowserTargetRequest,
} from "../../src/browser/managed-browser.js";
import { BrowserRuntimeBroker } from "../../src/browser/runtime-broker.js";

describe("BrowserRuntimeBroker target acquisition cancellation", () => {
  it("ends the turn when a provider ignores cancellation and never settles", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const provider = new (class extends ManagedBrowserProvider {
      override acquireTarget(
        _request: ManagedBrowserTargetRequest,
        _signal?: AbortSignal,
      ): Promise<ManagedBrowserTarget> {
        markStarted();
        return new Promise(() => undefined);
      }
    })();
    const broker = new BrowserRuntimeBroker({ provider });
    const context = {
      agent_session_id: "hung-acquisition-agent",
      turn_id: "hung-acquisition-turn",
      transport: "mcp" as const,
    };
    const controller = new AbortController();

    await expect(
      broker.dispatch({
        id: randomUUID(),
        action: "session.start",
        context,
      }),
    ).resolves.toMatchObject({ ok: true });
    const command = broker.dispatch(
      {
        id: randomUUID(),
        action: "target.command",
        context,
        provider: "managed",
        visibility: "hidden",
        profile_partition_id: "hung-acquisition-partition",
        isolated: false,
        ephemeral: true,
        command: { method: "title" },
      },
      controller.signal,
    );
    await started;
    controller.abort(new Error("request disconnected"));

    await expect(settlesWithin(command)).resolves.toMatchObject({
      ok: false,
      error: { code: "browser_command_canceled" },
    });
    await expect(
      settlesWithin(
        broker.dispatch({
          id: randomUUID(),
          action: "turn.end",
          context,
        }),
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(broker.status().sessions).toMatchObject({
      target_leases: [],
      sessions: [
        expect.objectContaining({
          active_turn_ids: [],
          ending_turn_ids: [],
        }),
      ],
    });

    await broker.close();
  });
});

async function settlesWithin<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("operation did not settle within 250ms")),
          250,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
