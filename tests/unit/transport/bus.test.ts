/**
 * TransportBus tests.
 *
 * The bus is the composition layer: pipeline steps route through
 * `bus.require(step, platform)` which consults the capability matrix
 * and returns the correct transport, or throws a typed envelope error
 * when no transport supports the step on the current host.
 */

import { describe, it, expect } from "vitest";
import {
  createTransportBus,
  NoTransportForStepError,
} from "../../../src/transport/bus.js";
import type {
  TransportAdapter,
  TransportKind,
  Capability,
  ActionRequest,
  ActionResult,
  Snapshot,
  TransportContext,
} from "../../../src/transport/types.js";
import { ok } from "../../../src/core/envelope.js";

function makeStub(
  kind: TransportKind,
  steps: readonly string[],
  opts: { platforms?: Capability["platforms"] } = {},
): TransportAdapter {
  const capability: Capability = {
    steps,
    snapshotFormats: [],
    platforms: opts.platforms,
    mutatesHost: false,
  };
  return {
    kind,
    capability,
    async open(_ctx: TransportContext): Promise<void> {},
    async snapshot(): Promise<Snapshot> {
      return { format: "text", data: "" };
    },
    async action<T>(_req: ActionRequest): Promise<ActionResult<T>> {
      return ok(undefined as T);
    },
    async close(): Promise<void> {},
  };
}

describe("TransportBus.register + get", () => {
  it("registers and retrieves a transport by kind", () => {
    const bus = createTransportBus();
    const http = makeStub("http", ["fetch"]);
    bus.register(http);
    expect(bus.get("http")).toBe(http);
  });

  it("throws when retrieving an unregistered kind", () => {
    const bus = createTransportBus();
    expect(() => bus.get("cua")).toThrow();
  });

  it("replaces a transport when re-registering the same kind", () => {
    const bus = createTransportBus();
    const first = makeStub("http", ["fetch"]);
    const second = makeStub("http", ["fetch", "download"]);
    bus.register(first);
    bus.register(second);
    expect(bus.get("http")).toBe(second);
  });
});

describe("TransportBus.list", () => {
  it("returns all registered transports", () => {
    const bus = createTransportBus();
    const http = makeStub("http", ["fetch"]);
    const sub = makeStub("subprocess", ["exec"]);
    bus.register(http);
    bus.register(sub);
    const list = bus.list();
    expect(list).toHaveLength(2);
    expect(list.map((t) => t.kind).sort()).toEqual(["http", "subprocess"]);
  });

  it("returns empty array when no transports registered", () => {
    const bus = createTransportBus();
    expect(bus.list()).toEqual([]);
  });
});

describe("TransportBus.require", () => {
  it("returns the transport that declares support for a step", () => {
    const bus = createTransportBus();
    const http = makeStub("http", ["fetch"]);
    bus.register(http);
    expect(bus.require("fetch")).toBe(http);
  });

  it("prefers a registered transport listed in the capability matrix", () => {
    const bus = createTransportBus();
    const cdp = makeStub("cdp-browser", ["click"]);
    bus.register(cdp);
    expect(bus.require("click")).toBe(cdp);
  });

  it("throws a typed envelope error when step has no matching transport", () => {
    const bus = createTransportBus();
    try {
      bus.require("fetch");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(NoTransportForStepError);
      const err = e as NoTransportForStepError;
      expect(err.envelope.ok).toBe(false);
      expect(err.envelope.error?.reason).toMatch(/no transport.*fetch/i);
      expect(err.envelope.error?.minimum_capability).toBe("http.fetch");
      expect(err.envelope.error?.suggestion).toBeTruthy();
      expect(err.envelope.error?.action).toBe("fetch");
    }
  });

  it("platform-gates step errors mention the required platform", () => {
    const bus = createTransportBus();
    try {
      bus.require("applescript", "win32");
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as NoTransportForStepError;
      expect(err.envelope.error?.reason).toMatch(/applescript/);
      expect(err.envelope.error?.reason).toMatch(/win32/);
      expect(err.envelope.error?.minimum_capability).toBe(
        "desktop-ax.applescript",
      );
    }
  });

  it("unknown step throws with suggestion to check matrix", () => {
    const bus = createTransportBus();
    try {
      bus.require("not_a_real_step");
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as NoTransportForStepError;
      expect(err.envelope.error?.reason).toMatch(/unknown step/i);
    }
  });

  it("matches current platform when platform arg is omitted", () => {
    const bus = createTransportBus();
    const ax = makeStub("desktop-ax", ["applescript"], {
      platforms: ["darwin"],
    });
    bus.register(ax);
    // Should succeed only on darwin; on other platforms, throw.
    if (process.platform === "darwin") {
      expect(bus.require("applescript")).toBe(ax);
    } else {
      expect(() => bus.require("applescript")).toThrow();
    }
  });

  it("ignores unregistered transports even if matrix lists them", () => {
    // Matrix says cdp-browser supports click, but we don't register it.
    const bus = createTransportBus();
    const desktopAx = makeStub("desktop-ax", ["click"]);
    bus.register(desktopAx);
    // Should still find one — desktop-ax also supports click per matrix.
    expect(bus.require("click")).toBe(desktopAx);
  });
});

describe("NoTransportForStepError.envelope shape", () => {
  it("uses GENERIC_ERROR exit code by default", () => {
    const bus = createTransportBus();
    try {
      bus.require("fetch");
    } catch (e) {
      const err = e as NoTransportForStepError;
      expect(err.envelope.error?.exit_code).toBe(1);
      expect(err.envelope.error?.retryable).toBe(false);
    }
  });

  it("step=0, action=<step name>, transport=first-in-matrix", () => {
    const bus = createTransportBus();
    try {
      bus.require("fetch");
    } catch (e) {
      const err = e as NoTransportForStepError;
      expect(err.envelope.error?.step).toBe(0);
      expect(err.envelope.error?.action).toBe("fetch");
      // fetch is http-exclusive so transport is "http"
      expect(err.envelope.error?.transport).toBe("http");
    }
  });
});
