/**
 * DesktopAtspiTransport stub tests.
 *
 * Mirrors desktop-uia.test.ts — the stub must envelope every call so
 * self-repair agents see a consistent signal.
 */

import { describe, it, expect } from "vitest";
import { DesktopAtspiTransport } from "../../../../src/transport/adapters/desktop-atspi.js";
import { createTransportBus } from "../../../../src/transport/bus.js";
import type { TransportContext } from "../../../../src/transport/types.js";

function makeCtx(): TransportContext {
  return { vars: {}, bus: createTransportBus() };
}

describe("DesktopAtspiTransport stub", () => {
  it("declares kind = desktop-atspi and linux platform gate", () => {
    const t = new DesktopAtspiTransport();
    expect(t.kind).toBe("desktop-atspi");
    expect(t.capability.platforms).toContain("linux");
    expect(t.capability.steps).toContain("atspi_activate");
  });

  it("every action returns service_unavailable envelope", async () => {
    const t = new DesktopAtspiTransport();
    await t.open(makeCtx());
    const res = await t.action({ kind: "atspi_activate", params: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.transport).toBe("desktop-atspi");
      expect(res.error.exit_code).toBe(69);
      expect(res.error.minimum_capability).toBe("desktop-atspi.atspi_activate");
      expect(res.error.suggestion).toMatch(/contribute|PR/i);
    }
  });

  it("close is idempotent", async () => {
    const t = new DesktopAtspiTransport();
    await t.open(makeCtx());
    await t.close();
    await t.close();
  });
});
