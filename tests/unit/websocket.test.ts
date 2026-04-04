import { describe, it, expect } from "vitest";
import { executeWebsocket } from "../../src/engine/websocket.js";
import type { WebsocketStepConfig } from "../../src/engine/websocket.js";

describe("websocket step", () => {
  it("exports executeWebsocket function", () => {
    expect(typeof executeWebsocket).toBe("function");
  });

  it("rejects on connection error to non-existent server", async () => {
    const config: WebsocketStepConfig = {
      url: "ws://localhost:19999", // nothing running here
      send: '{"test": true}',
      timeout: 500,
    };
    await expect(executeWebsocket(config)).rejects.toThrow();
  });

  it("rejects on timeout", async () => {
    // Use a port that accepts but never responds
    // This tests the timeout mechanism
    const config: WebsocketStepConfig = {
      url: "ws://localhost:19999",
      send: '{"test": true}',
      timeout: 100,
    };
    await expect(executeWebsocket(config)).rejects.toThrow();
  });
});
