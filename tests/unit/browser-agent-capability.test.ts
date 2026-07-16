import { describe, expect, it } from "vitest";

import { BrowserRuntimeBroker } from "../../src/browser/runtime-broker.js";

describe("browser agent-presence capability admission", () => {
  it.each([
    { provider: "managed" as const, visibility: "hidden" as const },
    { provider: "remote" as const, visibility: "hidden" as const },
    { provider: "chrome" as const, visibility: "background" as const },
  ])(
    "rejects $provider/$visibility before acquiring a target",
    async ({ provider, visibility }) => {
      const broker = new BrowserRuntimeBroker();
      const context = {
        agent_session_id: `agent-${provider}`,
        turn_id: "turn-1",
        transport: "cli" as const,
        profile_partition_id: "default",
      };
      await broker.dispatch({ id: "start", action: "session.start", context });

      const result = await broker.dispatch({
        id: "presence",
        action: "target.command",
        context,
        provider,
        visibility,
        profile_partition_id: "default",
        ...(provider === "managed" ? { isolated: false, ephemeral: true } : {}),
        command: { method: "agent_presence", visible: true },
      });

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "browser_capability_unavailable",
          retryable: false,
          suggestion: expect.stringContaining("foreground"),
        },
      });
      expect(broker.status().sessions.target_leases).toEqual([]);
      expect(broker.status().providers.managed).toEqual([]);
      broker.close();
    },
  );
});
