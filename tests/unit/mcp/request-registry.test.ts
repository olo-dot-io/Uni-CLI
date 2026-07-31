import { describe, expect, it } from "vitest";

import { StreamableRequestRegistry } from "../../../src/mcp/streamable-http/request-registry.js";

describe("StreamableRequestRegistry", () => {
  it("isolates identical request ids across stateless senders", () => {
    const registry = new StreamableRequestRegistry();
    const first = registry.register(undefined, 1, "tools/call");
    const second = registry.register(undefined, 1, "tools/call");

    expect(first).not.toBeInstanceOf(Error);
    expect(second).not.toBeInstanceOf(Error);
    if (!(first instanceof Error)) first.finish();
    if (!(second instanceof Error)) second.finish();
  });

  it("rejects duplicate active ids inside one legacy session", () => {
    const registry = new StreamableRequestRegistry();
    const first = registry.register("session-a", 1, "tools/call");
    const duplicate = registry.register("session-a", 1, "tools/call");

    expect(first).not.toBeInstanceOf(Error);
    expect(duplicate).toBeInstanceOf(Error);
    if (!(first instanceof Error)) first.finish();
  });
});
