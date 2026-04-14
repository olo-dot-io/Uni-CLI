/**
 * DesktopUiaTransport stub tests.
 *
 * The stub is intentionally bodyless; these tests enforce its envelope
 * contract so self-repair agents always see a consistent signal.
 */

import { describe, it, expect } from "vitest";
import { DesktopUiaTransport } from "../../../../src/transport/adapters/desktop-uia.js";
import { createTransportBus } from "../../../../src/transport/bus.js";
import type { TransportContext } from "../../../../src/transport/types.js";

function makeCtx(): TransportContext {
  return { vars: {}, bus: createTransportBus() };
}

describe("DesktopUiaTransport stub", () => {
  it("declares kind = desktop-uia and win32 platform gate", () => {
    const t = new DesktopUiaTransport();
    expect(t.kind).toBe("desktop-uia");
    expect(t.capability.platforms).toContain("win32");
    expect(t.capability.steps).toContain("uia_invoke");
  });

  it("every action returns service_unavailable envelope", async () => {
    const t = new DesktopUiaTransport();
    await t.open(makeCtx());
    const res = await t.action({ kind: "uia_invoke", params: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.transport).toBe("desktop-uia");
      expect(res.error.exit_code).toBe(69);
      expect(res.error.minimum_capability).toBe("desktop-uia.uia_invoke");
      expect(res.error.suggestion).toMatch(/contribute|PR/i);
    }
  });

  it("close is idempotent", async () => {
    const t = new DesktopUiaTransport();
    await t.open(makeCtx());
    await t.close();
    await t.close();
  });
});
