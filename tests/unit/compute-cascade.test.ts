import { describe, expect, it, vi } from "vitest";

import { CDPCommandTransportError } from "../../src/browser/cdp-client.js";
import { BrowserBrokerClientError } from "../../src/browser/runtime-transport.js";
import { err, ok } from "../../src/core/envelope.js";
import { CdpBrowserTransport } from "../../src/transport/adapters/cdp-browser.js";
import type { IPage } from "../../src/types.js";
import { createTransportBus, RefAllocator } from "../../src/transport/bus.js";
import {
  enrichComputeRequestFromRefs,
  preferenceFor,
  tryCascade,
} from "../../src/transport/cascade.js";
import type {
  ActionRequest,
  ActionResult,
  Capability,
  Snapshot,
  TransportAdapter,
  TransportContext,
  TransportKind,
} from "../../src/transport/types.js";

class StubTransport implements TransportAdapter {
  readonly capability: Capability;
  readonly calls: ActionRequest[] = [];
  readonly snapshots: Array<{
    format?: string;
    fresh?: boolean;
    params?: Record<string, unknown>;
  }> = [];
  snapshotResult: Snapshot = { format: "text", data: "" };
  snapshotFactory: (() => Snapshot) | undefined;
  snapshotFailure: unknown;
  onOpen: (() => void) | undefined;
  openCount = 0;

  constructor(
    readonly kind: TransportKind,
    steps: readonly string[],
    private readonly result: ActionResult<unknown>,
  ) {
    this.capability = {
      steps,
      snapshotFormats: [],
      mutatesHost: true,
    };
  }

  async open(_ctx: TransportContext): Promise<void> {
    this.openCount++;
    this.onOpen?.();
  }

  async snapshot(opts?: {
    format?: string;
    fresh?: boolean;
    params?: Record<string, unknown>;
  }): Promise<Snapshot> {
    this.snapshots.push({
      format: opts?.format,
      ...(opts?.fresh === undefined ? {} : { fresh: opts.fresh }),
      ...(opts?.params ? { params: opts.params } : {}),
    });
    if (this.snapshotFailure) throw this.snapshotFailure;
    return this.snapshotFactory?.() ?? this.snapshotResult;
  }

  async action<T = unknown>(req: ActionRequest): Promise<ActionResult<T>> {
    this.calls.push(req);
    return this.result as ActionResult<T>;
  }

  async close(): Promise<void> {}
}

function failure(kind: TransportKind, action: string): ActionResult<unknown> {
  return err({
    transport: kind,
    step: 0,
    action,
    reason: `${kind} unavailable`,
    minimum_capability: `${kind}.${action}`,
    exit_code: 69,
  });
}

const EXACT_AX_REF_TARGET = {
  app: "Calculator",
  pid: 42,
  windowId: 4242,
} as const;

describe("compute cascade", () => {
  it("never replays a structurally ambiguous CDP mutation on a fallback transport", async () => {
    const bus = createTransportBus();
    const ambiguity = new CDPCommandTransportError(
      "cdp_connection_lost",
      "CDP disconnected after click dispatch",
      { outcomeAmbiguous: true, targetUnusable: true },
    );
    const close = vi.fn().mockResolvedValue(undefined);
    // REASON: the CDP page is the external browser boundary; the real adapter, bus, and cascade remain integrated.
    const cdp = new CdpBrowserTransport({
      pageFactory: async () =>
        ({
          click: async () => {
            throw ambiguity;
          },
          close,
        }) as IPage,
    });
    const visual = new StubTransport(
      "visual",
      ["visual_click"],
      ok({ transport: "visual" }),
    );
    bus.register(cdp);
    bus.register(visual);

    await expect(
      tryCascade(
        bus,
        { kind: "compute_click", params: { selector: "#submit" } },
        "darwin",
      ),
    ).rejects.toBe(ambiguity);
    expect(close).toHaveBeenCalledTimes(1);
    expect(visual.calls).toEqual([]);
  });

  it.each(["browser_command_outcome_ambiguous", "browser_command_canceled"])(
    "never replays broker %s after dispatch",
    async (code) => {
      const bus = createTransportBus();
      const ambiguity = new BrowserBrokerClientError({
        code,
        message: "Broker lost mutation settlement after dispatch",
        suggestion: "Inspect page state before continuing on a fresh target",
        retryable: false,
      });
      const cdp = new CdpBrowserTransport({
        pageFactory: async () =>
          ({
            click: async () => {
              throw ambiguity;
            },
            close: async () => {},
          }) as IPage,
      });
      const visual = new StubTransport(
        "visual",
        ["visual_click"],
        ok({ transport: "visual" }),
      );
      bus.register(cdp);
      bus.register(visual);

      await expect(
        tryCascade(
          bus,
          { kind: "compute_click", params: { selector: "#submit" } },
          "linux",
        ),
      ).rejects.toMatchObject({
        outcome_ambiguous: true,
        target_unusable: true,
        retryable: false,
      });
      expect(visual.calls).toEqual([]);
    },
  );

  it("marks cancellation of an unsettled mutation ambiguous and never falls through", async () => {
    const bus = createTransportBus();
    const controller = new AbortController();
    const cancellation = new Error("cancel compute mutation");
    let startAction: (() => void) | undefined;
    const actionStarted = new Promise<void>((resolve) => {
      startAction = resolve;
    });
    const cdp: TransportAdapter = {
      kind: "cdp-browser",
      capability: {
        steps: ["click"],
        snapshotFormats: [],
        mutatesHost: true,
      },
      async open(ctx) {
        expect(ctx.signal).toBe(controller.signal);
      },
      async snapshot() {
        return { format: "text", data: "" };
      },
      action(req) {
        expect(req.signal).toBe(controller.signal);
        startAction?.();
        return new Promise((_resolve, reject) => {
          req.signal?.addEventListener(
            "abort",
            () => reject(req.signal?.reason),
            {
              once: true,
            },
          );
        });
      },
      async close() {},
    };
    const visual = new StubTransport(
      "visual",
      ["visual_click"],
      ok({ transport: "visual" }),
    );
    bus.register(cdp);
    bus.register(visual);
    const execution = tryCascade(
      bus,
      {
        kind: "compute_click",
        params: {
          ref: "cdp-browser:page:#submit",
          port: 9333,
          webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/target-a",
        },
        signal: controller.signal,
      },
      "linux",
      {
        vars: {},
        bus,
        refs: bus.refs,
        signal: controller.signal,
      },
    );
    await actionStarted;

    controller.abort(cancellation);

    await expect(execution).rejects.toMatchObject({
      name: "OperationOutcomeAmbiguousError",
      operation: "compute_click",
      cancellationReason: cancellation,
      outcome_ambiguous: true,
    });
    expect(visual.calls).toHaveLength(0);
  });

  it("keeps cancellation exact when adapter setup aborts before action dispatch", async () => {
    const bus = createTransportBus();
    const controller = new AbortController();
    const cancellation = new Error("cancel during adapter setup");
    const cdp: TransportAdapter = {
      kind: "cdp-browser",
      capability: {
        steps: ["click"],
        snapshotFormats: [],
        mutatesHost: true,
      },
      async open() {
        controller.abort(cancellation);
        throw cancellation;
      },
      async snapshot() {
        return { format: "text", data: "" };
      },
      async action() {
        throw new Error("action must not be dispatched");
      },
      async close() {},
    };
    bus.register(cdp);

    await expect(
      tryCascade(
        bus,
        {
          kind: "compute_click",
          params: { selector: "#submit" },
          signal: controller.signal,
        },
        "linux",
      ),
    ).rejects.toBe(cancellation);
  });

  it("keeps an authoritative mutation success when cancellation arrives as it settles", async () => {
    const bus = createTransportBus();
    const controller = new AbortController();
    const cancellation = new Error("late cancellation");
    const cdp: TransportAdapter = {
      kind: "cdp-browser",
      capability: {
        steps: ["click"],
        snapshotFormats: [],
        mutatesHost: true,
      },
      async open() {},
      async snapshot() {
        return { format: "text", data: "" };
      },
      async action<T = unknown>() {
        controller.abort(cancellation);
        return ok({
          transport: "cdp-browser",
          committed: true,
        }) as ActionResult<T>;
      },
      async close() {},
    };
    const visual = new StubTransport(
      "visual",
      ["visual_click"],
      ok({ transport: "visual" }),
    );
    bus.register(cdp);
    bus.register(visual);

    await expect(
      tryCascade(
        bus,
        {
          kind: "compute_click",
          params: { selector: "#submit" },
          signal: controller.signal,
        },
        "darwin",
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: { committed: true },
    });
    expect(visual.calls).toEqual([]);
  });

  it("derives launch cancellation ambiguity from the command contract", async () => {
    const bus = createTransportBus();
    const controller = new AbortController();
    const cancellation = new Error("cancel launched app");
    let actionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      actionStarted = resolve;
    });
    const subprocess: TransportAdapter = {
      kind: "subprocess",
      capability: {
        steps: ["launch_app"],
        snapshotFormats: [],
        mutatesHost: true,
      },
      async open() {},
      async snapshot() {
        return { format: "text", data: "" };
      },
      action(req) {
        actionStarted();
        return new Promise((_resolve, reject) => {
          req.signal?.addEventListener(
            "abort",
            () => reject(req.signal?.reason),
            {
              once: true,
            },
          );
        });
      },
      async close() {},
    };
    bus.register(subprocess);
    const execution = tryCascade(
      bus,
      {
        kind: "compute_launch",
        params: { app: "Example" },
        signal: controller.signal,
      },
      "darwin",
    );
    await started;

    controller.abort(cancellation);

    await expect(execution).rejects.toMatchObject({
      operation: "compute_launch",
      cancellationReason: cancellation,
      outcome_ambiguous: true,
    });
  });

  it("filters native desktop transports by host platform", () => {
    expect(preferenceFor("compute_click", "darwin")).toEqual([
      "desktop-ax",
      "cdp-browser",
      "visual",
    ]);
    expect(preferenceFor("compute_click", "win32")).toEqual([
      "cdp-browser",
      "desktop-uia",
      "visual",
    ]);
    expect(preferenceFor("compute_click", "linux")).toEqual([
      "cdp-browser",
      "desktop-atspi",
      "visual",
    ]);
  });

  it("uses macOS AX first for compute_click on darwin", async () => {
    const bus = createTransportBus();
    const ax = new StubTransport(
      "desktop-ax",
      ["ax_press"],
      ok({
        transport: "desktop-ax",
      }),
    );
    const visual = new StubTransport(
      "visual",
      ["visual_click"],
      ok({ transport: "visual" }),
    );
    bus.register(ax);
    bus.register(visual);

    const result = await tryCascade(
      bus,
      {
        kind: "compute_click",
        params: {
          ref: "desktop-ax:window-4242:AXWindow[0]/AXButton[0]",
          app: "Calculator",
          windowId: 4242,
        },
      },
      "darwin",
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ transport: "desktop-ax" });
    expect(ax.calls.map((call) => call.kind)).toEqual(["ax_press"]);
    expect(visual.calls).toHaveLength(0);
  });

  it("defaults mutating compute actions to non-focusing mode", async () => {
    const bus = createTransportBus();
    const ax = new StubTransport(
      "desktop-ax",
      ["ax_press"],
      ok({ transport: "desktop-ax" }),
    );
    bus.register(ax);

    const result = await tryCascade(
      bus,
      {
        kind: "compute_click",
        params: {
          ref: "desktop-ax:window-4242:AXWindow[0]/AXButton[0]",
          app: "Calculator",
          windowId: 4242,
        },
      },
      "darwin",
    );

    expect(result.ok).toBe(true);
    expect(ax.calls[0]?.params).toMatchObject({ focus: false });
  });

  it("normalizes explicit background mode before transport dispatch", async () => {
    const bus = createTransportBus();
    const ax = new StubTransport(
      "desktop-ax",
      ["ax_press"],
      ok({ transport: "desktop-ax" }),
    );
    bus.register(ax);

    const result = await tryCascade(
      bus,
      {
        kind: "compute_click",
        params: {
          ref: "desktop-ax:window-4242:AXWindow[0]/AXButton[0]",
          app: "Calculator",
          windowId: 4242,
          background: true,
        },
      },
      "darwin",
    );

    expect(result.ok).toBe(true);
    expect(ax.calls[0]?.params).toMatchObject({ focus: false });
    expect(ax.calls[0]?.params).not.toHaveProperty("background");
  });

  it("rejects contradictory focus modes before transport dispatch", async () => {
    const bus = createTransportBus();
    const ax = new StubTransport(
      "desktop-ax",
      ["ax_press"],
      ok({ transport: "desktop-ax" }),
    );
    bus.register(ax);

    const result = await tryCascade(
      bus,
      {
        kind: "compute_click",
        params: {
          ref: "desktop-ax:window-4242:AXWindow[0]/AXButton[0]",
          app: "Calculator",
          windowId: 4242,
          background: true,
          focus: true,
        },
      },
      "darwin",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        minimum_capability: "compute.compute_click.invalid_input",
        exit_code: 2,
      });
    }
    expect(ax.calls).toHaveLength(0);
  });

  it("routes a stable macOS ref only through its AX owner", async () => {
    const bus = createTransportBus();
    const ax = new StubTransport(
      "desktop-ax",
      ["ax_scroll"],
      ok({ transport: "desktop-ax" }),
    );
    const visual = new StubTransport(
      "visual",
      ["visual_scroll"],
      ok({ transport: "visual" }),
    );
    bus.register(ax);
    bus.register(visual);

    const result = await tryCascade(
      bus,
      {
        kind: "compute_scroll",
        params: {
          ref: "desktop-ax:window-4242:AXWindow[0]",
          direction: "down",
          app: "Calculator",
          windowId: 4242,
        },
      },
      "darwin",
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ transport: "desktop-ax" });
    expect(ax.calls).toHaveLength(1);
    expect(ax.calls[0]).toMatchObject({
      kind: "ax_scroll",
      params: { direction: "down", focus: false },
    });
    expect(visual.calls).toHaveLength(0);
  });

  it("routes macOS compute_press to pid-addressed background press before Visual", async () => {
    const bus = createTransportBus();
    const ax = new StubTransport(
      "desktop-ax",
      ["ax_background_press"],
      ok({ transport: "desktop-ax" }),
    );
    const visual = new StubTransport(
      "visual",
      ["visual_key"],
      ok({ transport: "visual" }),
    );
    bus.register(ax);
    bus.register(visual);

    const result = await tryCascade(
      bus,
      { kind: "compute_press", params: { app: "TextEdit", combo: "cmd+s" } },
      "darwin",
    );

    expect(result.ok).toBe(true);
    expect(ax.calls).toHaveLength(1);
    expect(ax.calls[0]).toMatchObject({
      kind: "ax_background_press",
      params: { app: "TextEdit", combo: "cmd+s", focus: false },
    });
    expect(visual.calls).toHaveLength(0);
  });

  it("uses CDP screenshots before Visual visual fallback", async () => {
    const bus = createTransportBus();
    const cdp = new StubTransport(
      "cdp-browser",
      ["screenshot"],
      ok({ transport: "cdp-browser" }),
    );
    const visual = new StubTransport(
      "visual",
      ["visual_snapshot"],
      ok({ transport: "visual" }),
    );
    bus.register(cdp);
    bus.register(visual);

    const result = await tryCascade(
      bus,
      { kind: "compute_screenshot", params: {} },
      "darwin",
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ transport: "cdp-browser" });
    expect(cdp.calls.map((call) => call.kind)).toEqual(["screenshot"]);
    expect(visual.calls).toHaveLength(0);
  });

  it("uses macOS AX screenshots before Visual visual fallback", async () => {
    const bus = createTransportBus();
    const ax = new StubTransport(
      "desktop-ax",
      ["ax_screenshot"],
      ok({ transport: "desktop-ax" }),
    );
    const visual = new StubTransport(
      "visual",
      ["visual_snapshot"],
      ok({ transport: "visual" }),
    );
    bus.register(ax);
    bus.register(visual);

    const result = await tryCascade(
      bus,
      { kind: "compute_screenshot", params: { path: "/tmp/shot.png" } },
      "darwin",
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ transport: "desktop-ax" });
    expect(ax.calls.map((call) => call.kind)).toEqual(["ax_screenshot"]);
    expect(visual.calls).toHaveLength(0);
  });

  it("maps compute_assert to native desktop sidecar assert verbs", async () => {
    const winBus = createTransportBus();
    const uia = new StubTransport(
      "desktop-uia",
      ["uia_assert"],
      ok({ transport: "desktop-uia" }),
    );
    winBus.register(uia);

    const winResult = await tryCascade(
      winBus,
      { kind: "compute_assert", params: { text: "Settings" } },
      "win32",
    );

    expect(winResult.ok).toBe(true);
    expect(uia.calls.map((call) => call.kind)).toEqual(["uia_assert"]);

    const linuxBus = createTransportBus();
    const atspi = new StubTransport(
      "desktop-atspi",
      ["atspi_assert"],
      ok({ transport: "desktop-atspi" }),
    );
    linuxBus.register(atspi);

    const linuxResult = await tryCascade(
      linuxBus,
      { kind: "compute_assert", params: { text: "Settings" } },
      "linux",
    );

    expect(linuxResult.ok).toBe(true);
    expect(atspi.calls.map((call) => call.kind)).toEqual(["atspi_assert"]);
  });

  it("maps compute_launch to subprocess launch_app before native fallbacks", async () => {
    const bus = createTransportBus();
    const subprocess = new StubTransport(
      "subprocess",
      ["launch_app"],
      ok({ transport: "subprocess" }),
    );
    const ax = new StubTransport(
      "desktop-ax",
      ["launch_app"],
      ok({ transport: "desktop-ax" }),
    );
    bus.register(subprocess);
    bus.register(ax);

    const result = await tryCascade(
      bus,
      { kind: "compute_launch", params: { app: "Calculator" } },
      "darwin",
    );

    expect(result.ok).toBe(true);
    expect(subprocess.calls).toEqual([
      {
        kind: "launch_app",
        params: { app: "Calculator" },
        canMutate: true,
      },
    ]);
    expect(ax.calls).toHaveLength(0);
  });

  it("maps compute_launch to native sidecar launch_app after subprocess fails", async () => {
    const winBus = createTransportBus();
    const winSubprocess = new StubTransport(
      "subprocess",
      ["launch_app"],
      failure("subprocess", "launch_app"),
    );
    const uia = new StubTransport(
      "desktop-uia",
      ["launch_app"],
      ok({ transport: "desktop-uia" }),
    );
    winBus.register(winSubprocess);
    winBus.register(uia);

    const winResult = await tryCascade(
      winBus,
      { kind: "compute_launch", params: { app: "Code.exe", debugPort: 9230 } },
      "win32",
    );

    expect(winResult.ok).toBe(true);
    expect(uia.calls).toEqual([
      {
        kind: "launch_app",
        params: { app: "Code.exe", debugPort: 9230 },
        canMutate: true,
      },
    ]);

    const linuxBus = createTransportBus();
    const linuxSubprocess = new StubTransport(
      "subprocess",
      ["launch_app"],
      failure("subprocess", "launch_app"),
    );
    const atspi = new StubTransport(
      "desktop-atspi",
      ["launch_app"],
      ok({ transport: "desktop-atspi" }),
    );
    linuxBus.register(linuxSubprocess);
    linuxBus.register(atspi);

    const linuxResult = await tryCascade(
      linuxBus,
      {
        kind: "compute_launch",
        params: { app: "code.desktop", debugPort: 9230 },
      },
      "linux",
    );

    expect(linuxResult.ok).toBe(true);
    expect(atspi.calls).toEqual([
      {
        kind: "launch_app",
        params: { app: "code.desktop", debugPort: 9230 },
        canMutate: true,
      },
    ]);
  });

  it("prefers CDP for actions against CDP-scoped refs", async () => {
    const bus = createTransportBus();
    const alloc = new RefAllocator();
    alloc.alloc({
      stable: "cdp-browser:vscode:button[aria-label=Run]",
      role: "button",
      name: "Run",
      cdpEndpoint: {
        port: 9333,
        webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/vscode",
      },
    });
    bus.refs.put(alloc.freeze("cdp-browser", "vscode"));
    const ax = new StubTransport(
      "desktop-ax",
      ["ax_press"],
      ok({ transport: "desktop-ax" }),
    );
    const cdp = new StubTransport(
      "cdp-browser",
      ["click"],
      ok({ transport: "cdp-browser" }),
    );
    bus.register(ax);
    bus.register(cdp);

    const result = await tryCascade(
      bus,
      { kind: "compute_click", params: { ref: "@e1" } },
      "darwin",
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ transport: "cdp-browser" });
    expect(cdp.calls.map((call) => call.kind)).toEqual(["click"]);
    expect(ax.calls).toHaveLength(0);
  });

  it("never replays a bound ref through a different transport owner", async () => {
    const bus = createTransportBus();
    const alloc = new RefAllocator();
    alloc.alloc({
      stable: "cdp-browser:renderer:#submit",
      role: "button",
      name: "Submit",
      bounds: { x: 20, y: 30, w: 80, h: 30 },
      cdpEndpoint: {
        port: 9333,
        webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/submit",
      },
    });
    bus.refs.put(alloc.freeze("cdp-browser", "renderer"));
    const cdp = new StubTransport(
      "cdp-browser",
      ["click"],
      failure("cdp-browser", "click"),
    );
    const visual = new StubTransport(
      "visual",
      ["visual_click"],
      ok({ transport: "visual" }),
    );
    bus.register(cdp);
    bus.register(visual);

    const result = await tryCascade(
      bus,
      { kind: "compute_click", params: { ref: "@e1" } },
      "darwin",
    );

    expect(result.ok).toBe(false);
    expect(cdp.calls).toHaveLength(1);
    expect(visual.openCount).toBe(0);
  });

  it.each(["cdp-browser:renderer:#submit", "cdp:renderer:#submit"])(
    "dispatches direct stable CDP ref %s as the adapter stable selector",
    async (ref) => {
      const bus = createTransportBus();
      const cdp = new StubTransport(
        "cdp-browser",
        ["click"],
        ok({ transport: "cdp-browser" }),
      );
      bus.register(cdp);

      const result = await tryCascade(
        bus,
        {
          kind: "compute_click",
          params: {
            ref,
            port: 9333,
            webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/target-a",
          },
        },
        "linux",
      );

      expect(result.ok).toBe(true);
      expect(cdp.calls).toEqual([
        {
          kind: "click",
          params: {
            ref,
            stable: ref,
            focus: false,
            port: 9333,
            webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/target-a",
          },
          canMutate: true,
        },
      ]);
    },
  );

  it("rejects an explicit CDP endpoint that conflicts with a persisted ref", async () => {
    const bus = createTransportBus();
    const alloc = new RefAllocator();
    alloc.alloc({
      stable: "cdp-browser:renderer:#submit",
      role: "button",
      name: "Submit",
      cdpEndpoint: {
        port: 9333,
        webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/target-a",
      },
    });
    bus.refs.put(alloc.freeze("cdp-browser", "renderer"));
    const cdp = new StubTransport(
      "cdp-browser",
      ["click"],
      ok({ transport: "cdp-browser" }),
    );
    bus.register(cdp);

    const result = await tryCascade(
      bus,
      {
        kind: "compute_click",
        params: {
          ref: "@e1",
          port: 9444,
          webSocketDebuggerUrl: "ws://127.0.0.1:9444/devtools/page/target-b",
        },
      },
      "linux",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.minimum_capability).toBe(
        "compute.compute_click.ref_target_mismatch",
      );
      expect(result.error.reason).toContain("target-b");
    }
    expect(cdp.calls).toEqual([]);
  });

  it("rejects a legacy persisted CDP ref without exact renderer identity", async () => {
    const bus = createTransportBus();
    const alloc = new RefAllocator();
    alloc.alloc({
      stable: "cdp-browser:renderer:#submit",
      role: "button",
      name: "Submit",
    });
    bus.refs.put(alloc.freeze("cdp-browser", "renderer"));
    const cdp = new StubTransport(
      "cdp-browser",
      ["click"],
      ok({ transport: "cdp-browser" }),
    );
    bus.register(cdp);

    const result = await tryCascade(
      bus,
      {
        kind: "compute_click",
        params: {
          ref: "@e1",
          port: 9333,
          webSocketDebuggerUrl:
            "ws://127.0.0.1:9333/devtools/page/current-target",
        },
      },
      "linux",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.minimum_capability).toBe(
        "compute.compute_click.ref_expired",
      );
      expect(result.error.reason).toContain("predates exact renderer binding");
    }
    expect(cdp.calls).toEqual([]);
  });

  it("rejects a legacy persisted macOS ref without exact window identity", async () => {
    const bus = createTransportBus();
    const alloc = new RefAllocator();
    alloc.alloc({
      stable: "desktop-ax:window-4242:AXWindow[0]/AXButton[0]",
      role: "AXButton",
      name: "One",
      app: "Calculator",
    });
    bus.refs.put(alloc.freeze("desktop-ax", "calc"));
    const ax = new StubTransport(
      "desktop-ax",
      ["ax_press"],
      ok({ transport: "desktop-ax" }),
    );
    bus.register(ax);

    const result = await tryCascade(
      bus,
      { kind: "compute_click", params: { ref: "@e1" } },
      "darwin",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.minimum_capability).toBe(
        "compute.compute_click.ref_expired",
      );
      expect(result.error.reason).toContain("predates exact window binding");
    }
    expect(ax.calls).toEqual([]);
  });

  it("prefers UIA for actions against UIA-scoped refs on win32", async () => {
    const bus = createTransportBus();
    const alloc = new RefAllocator();
    alloc.alloc({
      stable: "desktop-uia:window-0x2:Window[0]/Button[1]",
      role: "Button",
      name: "Eight",
      app: "Calculator",
      pid: 42,
      windowId: "0x2",
      bounds: { x: 100, y: 200, w: 30, h: 40 },
    });
    bus.refs.put(alloc.freeze("desktop-uia", "window-0x2"));
    const cdp = new StubTransport(
      "cdp-browser",
      ["click"],
      ok({ transport: "cdp-browser" }),
    );
    const uia = new StubTransport(
      "desktop-uia",
      ["uia_invoke"],
      ok({ transport: "desktop-uia" }),
    );
    bus.register(cdp);
    bus.register(uia);

    const result = await tryCascade(
      bus,
      { kind: "compute_click", params: { ref: "@e1" } },
      "win32",
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ transport: "desktop-uia" });
    expect(uia.calls.map((call) => call.kind)).toEqual(["uia_invoke"]);
    expect(cdp.calls).toHaveLength(0);
  });

  it("prefers UIA for direct stable UIA refs on win32", async () => {
    const bus = createTransportBus();
    const cdp = new StubTransport(
      "cdp-browser",
      ["click"],
      ok({ transport: "cdp-browser" }),
    );
    const uia = new StubTransport(
      "desktop-uia",
      ["uia_invoke"],
      ok({ transport: "desktop-uia" }),
    );
    bus.register(cdp);
    bus.register(uia);

    const result = await tryCascade(
      bus,
      {
        kind: "compute_click",
        params: { ref: "desktop-uia:window-0x2:Window[0]/Button[1]" },
      },
      "win32",
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ transport: "desktop-uia" });
    expect(uia.calls.map((call) => call.kind)).toEqual(["uia_invoke"]);
    expect(cdp.calls).toHaveLength(0);
  });

  it("allows direct stable UIA refs when unrelated ref buckets exist", async () => {
    const bus = createTransportBus();
    const alloc = new RefAllocator();
    alloc.alloc({
      stable: "desktop-uia:window-0x7:Window[0]/Button[0]",
      role: "Button",
      name: "Seven",
    });
    bus.refs.put(alloc.freeze("desktop-uia", "pid-7"));
    const uia = new StubTransport(
      "desktop-uia",
      ["uia_invoke"],
      ok({ transport: "desktop-uia" }),
    );
    bus.register(uia);

    const result = await tryCascade(
      bus,
      {
        kind: "compute_click",
        params: { ref: "desktop-uia:window-0x2:Window[0]/Button[1]" },
      },
      "win32",
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ transport: "desktop-uia" });
    expect(uia.calls.map((call) => call.kind)).toEqual(["uia_invoke"]);
  });

  it("keeps UIA stable refs ahead of unrelated CDP session hints", async () => {
    const bus = createTransportBus();
    const cdp = new StubTransport(
      "cdp-browser",
      ["click"],
      ok({ transport: "cdp-browser" }),
    );
    const uia = new StubTransport(
      "desktop-uia",
      ["uia_invoke"],
      ok({ transport: "desktop-uia" }),
    );
    bus.register(cdp);
    bus.register(uia);

    const result = await tryCascade(
      bus,
      {
        kind: "compute_click",
        params: {
          ref: "desktop-uia:window-0x2:Window[0]/Button[1]",
          port: 9222,
        },
      },
      "win32",
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ transport: "desktop-uia" });
    expect(uia.calls.map((call) => call.kind)).toEqual(["uia_invoke"]);
    expect(cdp.calls).toHaveLength(0);
  });

  it("prefers AT-SPI for actions against AT-SPI-scoped refs on linux", async () => {
    const bus = createTransportBus();
    const alloc = new RefAllocator();
    alloc.alloc({
      stable: "desktop-atspi:window-0x03a00007:Window[0]/push_button[1]",
      role: "push_button",
      name: "Eight",
      app: "Calculator",
      pid: 1234,
      windowId: "0x03a00007",
      bounds: { x: 100, y: 200, w: 30, h: 40 },
    });
    bus.refs.put(alloc.freeze("desktop-atspi", "window-0x03a00007"));
    const cdp = new StubTransport(
      "cdp-browser",
      ["click"],
      ok({ transport: "cdp-browser" }),
    );
    const atspi = new StubTransport(
      "desktop-atspi",
      ["atspi_invoke"],
      ok({ transport: "desktop-atspi" }),
    );
    bus.register(cdp);
    bus.register(atspi);

    const result = await tryCascade(
      bus,
      { kind: "compute_click", params: { ref: "@e1" } },
      "linux",
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ transport: "desktop-atspi" });
    expect(atspi.calls.map((call) => call.kind)).toEqual(["atspi_invoke"]);
    expect(cdp.calls).toHaveLength(0);
  });

  it("prefers AT-SPI for direct stable AT-SPI refs on linux", async () => {
    const bus = createTransportBus();
    const cdp = new StubTransport(
      "cdp-browser",
      ["click"],
      ok({ transport: "cdp-browser" }),
    );
    const atspi = new StubTransport(
      "desktop-atspi",
      ["atspi_invoke"],
      ok({ transport: "desktop-atspi" }),
    );
    bus.register(cdp);
    bus.register(atspi);

    const result = await tryCascade(
      bus,
      {
        kind: "compute_click",
        params: {
          ref: "desktop-atspi:window-0x03a00007:Window[0]/push_button[1]",
        },
      },
      "linux",
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ transport: "desktop-atspi" });
    expect(atspi.calls.map((call) => call.kind)).toEqual(["atspi_invoke"]);
    expect(cdp.calls).toHaveLength(0);
  });

  it("allows direct stable AT-SPI refs when unrelated ref buckets exist", async () => {
    const bus = createTransportBus();
    const alloc = new RefAllocator();
    alloc.alloc({
      stable: "desktop-atspi:window-0x7:Window[0]/push_button[0]",
      role: "push_button",
      name: "Seven",
    });
    bus.refs.put(alloc.freeze("desktop-atspi", "pid-7"));
    const atspi = new StubTransport(
      "desktop-atspi",
      ["atspi_invoke"],
      ok({ transport: "desktop-atspi" }),
    );
    bus.register(atspi);

    const result = await tryCascade(
      bus,
      {
        kind: "compute_click",
        params: {
          ref: "desktop-atspi:window-0x03a00007:Window[0]/push_button[1]",
        },
      },
      "linux",
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ transport: "desktop-atspi" });
    expect(atspi.calls.map((call) => call.kind)).toEqual(["atspi_invoke"]);
  });

  it("keeps AT-SPI stable refs ahead of unrelated CDP session hints", async () => {
    const bus = createTransportBus();
    const cdp = new StubTransport(
      "cdp-browser",
      ["click"],
      ok({ transport: "cdp-browser" }),
    );
    const atspi = new StubTransport(
      "desktop-atspi",
      ["atspi_invoke"],
      ok({ transport: "desktop-atspi" }),
    );
    bus.register(cdp);
    bus.register(atspi);

    const result = await tryCascade(
      bus,
      {
        kind: "compute_click",
        params: {
          ref: "desktop-atspi:window-0x03a00007:Window[0]/push_button[1]",
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/test",
        },
      },
      "linux",
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ transport: "desktop-atspi" });
    expect(atspi.calls.map((call) => call.kind)).toEqual(["atspi_invoke"]);
    expect(cdp.calls).toHaveLength(0);
  });

  it("enriches action params from a persisted element ref", async () => {
    const bus = createTransportBus();
    const alloc = new RefAllocator();
    alloc.alloc({
      ...EXACT_AX_REF_TARGET,
      stable: "desktop-ax:window-4242:AXWindow[0]/AXButton[4]",
      role: "AXButton",
      name: "5",
      app: "Calculator",
      bounds: { x: 10, y: 20, w: 30, h: 40 },
      screenIndex: 2,
    });
    bus.refs.put(alloc.freeze("desktop-ax", "window-4242"));
    const ax = new StubTransport(
      "desktop-ax",
      ["ax_press"],
      ok({ transport: "desktop-ax" }),
    );
    bus.register(ax);

    const result = await tryCascade(
      bus,
      { kind: "compute_click", params: { ref: "@e1" } },
      "darwin",
    );

    expect(result.ok).toBe(true);
    expect(ax.calls[0]).toMatchObject({
      kind: "ax_press",
      params: {
        ref: "@e1",
        app: "Calculator",
        windowId: 4242,
        role: "AXButton",
        title: "5",
        x: 25,
        y: 40,
        coordinateSpace: "screen",
        screenIndex: 2,
      },
    });
  });

  it("exposes ref enrichment for evidence without adapting transport steps", () => {
    const bus = createTransportBus();
    const alloc = new RefAllocator();
    alloc.alloc({
      ...EXACT_AX_REF_TARGET,
      stable: "desktop-ax:window-4242:AXWindow[0]/AXButton[4]",
      role: "AXButton",
      name: "5",
      app: "Calculator",
      bounds: { x: 10, y: 20, w: 30, h: 40 },
      screenIndex: 2,
    });
    bus.refs.put(alloc.freeze("desktop-ax", "window-4242"));

    const enriched = enrichComputeRequestFromRefs(bus, {
      kind: "compute_click",
      params: { ref: "@e1" },
    });

    expect(enriched).toMatchObject({
      kind: "compute_click",
      params: {
        ref: "@e1",
        app: "Calculator",
        windowId: 4242,
        role: "AXButton",
        title: "5",
        stable: "desktop-ax:window-4242:AXWindow[0]/AXButton[4]",
        x: 25,
        y: 40,
        coordinateSpace: "screen",
        screenIndex: 2,
      },
    });
  });

  it("returns ref_ambiguous instead of selecting the oldest duplicate alias", async () => {
    const bus = createTransportBus();
    const left = new RefAllocator();
    left.alloc({
      stable: "desktop-ax:left:AXWindow[0]/AXButton[0]",
      role: "AXButton",
      name: "Left",
    });
    const right = new RefAllocator();
    right.alloc({
      stable: "desktop-ax:right:AXWindow[0]/AXButton[0]",
      role: "AXButton",
      name: "Right",
    });
    bus.refs.put(left.freeze("desktop-ax", "left"));
    bus.refs.put(right.freeze("desktop-ax", "right"));
    const ax = new StubTransport(
      "desktop-ax",
      ["ax_press"],
      ok({ transport: "desktop-ax" }),
    );
    bus.register(ax);

    const result = await tryCascade(
      bus,
      { kind: "compute_click", params: { ref: "@e1" } },
      "darwin",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.minimum_capability).toBe(
        "compute.compute_click.ref_ambiguous",
      );
      expect(result.error.reason).toContain("desktop-ax/left");
      expect(result.error.reason).toContain("desktop-ax/right");
      expect(result.error.suggestion).toContain("stable ref");
    }
    expect(ax.openCount).toBe(0);
    expect(ax.calls).toEqual([]);
  });

  it("uses an exact native window hint to disambiguate a short alias", async () => {
    const bus = createTransportBus();
    const left = new RefAllocator();
    left.alloc({
      ...EXACT_AX_REF_TARGET,
      stable: "desktop-ax:window-4242:AXWindow[0]/AXButton[0]",
      role: "AXButton",
      name: "Left",
    });
    const right = new RefAllocator();
    right.alloc({
      ...EXACT_AX_REF_TARGET,
      windowId: 5252,
      stable: "desktop-ax:window-5252:AXWindow[0]/AXButton[0]",
      role: "AXButton",
      name: "Right",
    });
    bus.refs.put(left.freeze("desktop-ax", "window-4242"));
    bus.refs.put(right.freeze("desktop-ax", "window-5252"));
    const ax = new StubTransport(
      "desktop-ax",
      ["ax_press"],
      ok({ transport: "desktop-ax" }),
    );
    bus.register(ax);

    const result = await tryCascade(
      bus,
      {
        kind: "compute_click",
        params: {
          ref: "@e1",
          app: "Calculator",
          windowId: 5252,
        },
      },
      "darwin",
    );

    expect(result.ok).toBe(true);
    expect(ax.calls[0]).toMatchObject({
      params: {
        stable: "desktop-ax:window-5252:AXWindow[0]/AXButton[0]",
        windowId: 5252,
        title: "Right",
      },
    });
  });

  it("rejects a short alias when its explicit window target has no match", async () => {
    const bus = createTransportBus();
    const alloc = new RefAllocator();
    alloc.alloc({
      ...EXACT_AX_REF_TARGET,
      stable: "desktop-ax:window-4242:AXWindow[0]/AXButton[0]",
      role: "AXButton",
      name: "Left",
    });
    bus.refs.put(alloc.freeze("desktop-ax", "window-4242"));
    const ax = new StubTransport(
      "desktop-ax",
      ["ax_press"],
      ok({ transport: "desktop-ax" }),
    );
    bus.register(ax);

    const result = await tryCascade(
      bus,
      {
        kind: "compute_click",
        params: { ref: "@e1", app: "Calculator", windowId: 9999 },
      },
      "darwin",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.minimum_capability).toBe(
        "compute.compute_click.ref_target_mismatch",
      );
      expect(result.error.reason).toContain("windowId=9999");
    }
    expect(ax.calls).toEqual([]);
  });

  it("returns ref_expired when adapter setup replaces the bound generation", async () => {
    const bus = createTransportBus();
    const first = new RefAllocator();
    first.alloc({
      ...EXACT_AX_REF_TARGET,
      stable: "desktop-ax:window-4242:AXWindow[0]/AXButton[0]",
      role: "AXButton",
      name: "1",
    });
    bus.refs.put(first.freeze("desktop-ax", "window-4242"));
    const ax = new StubTransport(
      "desktop-ax",
      ["ax_press"],
      ok({ transport: "desktop-ax" }),
    );
    ax.onOpen = () => {
      const replacement = new RefAllocator();
      replacement.alloc({
        ...EXACT_AX_REF_TARGET,
        stable: "desktop-ax:window-4242:AXWindow[0]/AXButton[1]",
        role: "AXButton",
        name: "2",
      });
      bus.refs.put(replacement.freeze("desktop-ax", "window-4242"));
    };
    bus.register(ax);

    const result = await tryCascade(
      bus,
      { kind: "compute_click", params: { ref: "@e1" } },
      "darwin",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.minimum_capability).toBe(
        "compute.compute_click.ref_expired",
      );
      expect(result.error.reason).toContain("binding changed");
    }
    expect(ax.openCount).toBe(1);
    expect(ax.calls).toEqual([]);
  });

  it("returns a ref_expired envelope before dispatching unknown element refs", async () => {
    const bus = createTransportBus();
    const ax = new StubTransport(
      "desktop-ax",
      ["ax_press"],
      ok({ transport: "desktop-ax" }),
    );
    bus.register(ax);

    const result = await tryCascade(
      bus,
      { kind: "compute_click", params: { ref: "@e99" } },
      "darwin",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.minimum_capability).toBe(
        "compute.compute_click.ref_expired",
      );
      expect(result.error.remedy).toMatchObject({
        command: "unicli compute snapshot",
      });
      expect(result.error.exit_code).toBe(66);
    }
    expect(ax.calls).toHaveLength(0);
  });

  it("returns a foreign_ref envelope before dispatching OLo-owned refs", async () => {
    const bus = createTransportBus();
    const ax = new StubTransport(
      "desktop-ax",
      ["ax_press"],
      ok({ transport: "desktop-ax" }),
    );
    bus.register(ax);

    const result = await tryCascade(
      bus,
      {
        kind: "compute_click",
        params: { ref: "olo:accessibility:example" },
      },
      "darwin",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.minimum_capability).toBe(
        "compute.compute_click.foreign_ref",
      );
      expect(result.error.reason).toContain("olo.accessibility");
      expect(result.error.suggestion).toContain("OLo");
      expect(result.error.exit_code).toBe(2);
    }
    expect(ax.calls).toHaveLength(0);
  });

  it("returns a foreign_ref envelope for browser-owned refs", async () => {
    const bus = createTransportBus();
    const visual = new StubTransport(
      "visual",
      ["visual_click"],
      ok({ transport: "visual" }),
    );
    bus.register(visual);

    const result = await tryCascade(
      bus,
      {
        kind: "compute_click",
        params: { ref: "browser:dom:button-1" },
      },
      "darwin",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.minimum_capability).toBe(
        "compute.compute_click.foreign_ref",
      );
      expect(result.error.suggestion).toContain("owning provider");
      expect(result.error.exit_code).toBe(2);
    }
    expect(visual.calls).toHaveLength(0);
  });

  it("returns an unresolvable_ref envelope for unsupported stable namespaces", async () => {
    const bus = createTransportBus();
    const visual = new StubTransport(
      "visual",
      ["visual_click"],
      ok({ transport: "visual" }),
    );
    bus.register(visual);

    const result = await tryCascade(
      bus,
      {
        kind: "compute_click",
        params: { ref: "unknown-provider:button-1" },
      },
      "darwin",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.minimum_capability).toBe(
        "compute.compute_click.unresolvable_ref",
      );
      expect(result.error.suggestion).toContain("desktop-ax");
      expect(result.error.exit_code).toBe(2);
    }
    expect(visual.calls).toHaveLength(0);
  });

  it("returns a ref_expired envelope for stale persisted buckets", async () => {
    const bus = createTransportBus();
    const alloc = new RefAllocator();
    alloc.alloc({
      ...EXACT_AX_REF_TARGET,
      stable: "desktop-ax:window-4242:AXWindow[0]/AXButton[4]",
      role: "AXButton",
      name: "5",
    });
    const bucket = alloc.freeze("desktop-ax", "window-4242");
    bus.refs.put({
      ...bucket,
      createdAt: Date.now() - 3_601_000,
    });
    const ax = new StubTransport(
      "desktop-ax",
      ["ax_press"],
      ok({ transport: "desktop-ax" }),
    );
    bus.register(ax);

    const result = await tryCascade(
      bus,
      { kind: "compute_click", params: { ref: "@e1" } },
      "darwin",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.minimum_capability).toBe(
        "compute.compute_click.ref_expired",
      );
      expect(result.error.reason).toContain("expired");
      expect(result.error.exit_code).toBe(66);
    }
    expect(ax.calls).toHaveLength(0);
  });

  it("returns an element_disabled envelope before dispatching disabled refs", async () => {
    const bus = createTransportBus();
    const alloc = new RefAllocator();
    alloc.alloc({
      ...EXACT_AX_REF_TARGET,
      stable: "desktop-ax:window-4242:AXWindow[0]/AXButton[9]",
      role: "AXButton",
      name: "Equals",
      states: ["disabled"],
    });
    bus.refs.put(alloc.freeze("desktop-ax", "window-4242"));
    const ax = new StubTransport(
      "desktop-ax",
      ["ax_press"],
      ok({ transport: "desktop-ax" }),
    );
    bus.register(ax);

    const result = await tryCascade(
      bus,
      { kind: "compute_click", params: { ref: "@e1" } },
      "darwin",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.minimum_capability).toBe(
        "compute.compute_click.element_disabled",
      );
      expect(result.error.remedy).toMatchObject({
        command: "unicli compute wait --state enabled",
      });
      expect(result.error.exit_code).toBe(66);
    }
    expect(ax.calls).toHaveLength(0);
  });

  it("returns an element_off_screen envelope before dispatching off-screen refs", async () => {
    const bus = createTransportBus();
    const alloc = new RefAllocator();
    alloc.alloc({
      ...EXACT_AX_REF_TARGET,
      stable: "desktop-ax:window-4242:AXWindow[0]/AXButton[10]",
      role: "AXButton",
      name: "Hidden",
      bounds: { x: -200, y: 20, w: 50, h: 30 },
    });
    bus.refs.put(alloc.freeze("desktop-ax", "window-4242"));
    const ax = new StubTransport(
      "desktop-ax",
      ["ax_press"],
      ok({ transport: "desktop-ax" }),
    );
    bus.register(ax);

    const result = await tryCascade(
      bus,
      { kind: "compute_click", params: { ref: "@e1" } },
      "darwin",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.minimum_capability).toBe(
        "compute.compute_click.element_off_screen",
      );
      expect(result.error.remedy).toMatchObject({
        command: "unicli compute snapshot",
      });
      expect(result.error.exit_code).toBe(66);
    }
    expect(ax.calls).toHaveLength(0);
  });

  it("returns a window_minimized envelope before dispatching hidden refs", async () => {
    const bus = createTransportBus();
    const alloc = new RefAllocator();
    alloc.alloc({
      ...EXACT_AX_REF_TARGET,
      stable: "desktop-ax:window-4242:AXWindow[0]/AXButton[11]",
      role: "AXButton",
      name: "Hidden",
      states: ["minimized"],
    });
    bus.refs.put(alloc.freeze("desktop-ax", "window-4242"));
    const ax = new StubTransport(
      "desktop-ax",
      ["ax_press"],
      ok({ transport: "desktop-ax" }),
    );
    bus.register(ax);

    const result = await tryCascade(
      bus,
      { kind: "compute_click", params: { ref: "@e1" } },
      "darwin",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.minimum_capability).toBe(
        "compute.compute_click.window_minimized",
      );
      expect(result.error.remedy?.message).toContain("Restore or focus");
      expect(result.error.exit_code).toBe(66);
    }
    expect(ax.calls).toHaveLength(0);
  });

  it("post-processes desktop AX snapshots into requested compact encoding", async () => {
    const bus = createTransportBus();
    const ax = new StubTransport(
      "desktop-ax",
      ["ax_snapshot"],
      ok({ raw: true }),
    );
    ax.snapshotResult = {
      format: "text",
      encoding: "compact",
      data: '@e1 window "Calculator"\n@e2 button "7"',
      refs: { count: 2, scope: "calc" },
    };
    bus.register(ax);

    const result = await tryCascade(
      bus,
      {
        kind: "compute_snapshot",
        params: { app: "Calculator", format: "compact" },
      },
      "darwin",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({
        format: "text",
        encoding: "compact",
        data: '@e1 window "Calculator"\n@e2 button "7"',
        refs: { count: 2, scope: "calc" },
      });
    }
    expect(ax.calls.map((call) => call.kind)).toEqual(["ax_snapshot"]);
    expect(ax.snapshots).toEqual([
      {
        format: "compact",
        params: { app: "Calculator", format: "compact" },
      },
    ]);
  });

  it("does not replace an explicit desktop app with an unbound browser or screen", async () => {
    const bus = createTransportBus();
    const ax = new StubTransport(
      "desktop-ax",
      ["ax_snapshot"],
      failure("desktop-ax", "ax_snapshot"),
    );
    const cdp = new StubTransport(
      "cdp-browser",
      ["snapshot"],
      ok({ transport: "cdp-browser" }),
    );
    cdp.snapshotResult = {
      format: "text",
      encoding: "compact",
      data: '@e1 document "about:blank"',
    };
    const visual = new StubTransport(
      "visual",
      ["visual_snapshot"],
      ok({ transport: "visual" }),
    );
    bus.register(ax);
    bus.register(cdp);
    bus.register(visual);

    const result = await tryCascade(
      bus,
      {
        kind: "compute_snapshot",
        params: { app: "__missing_desktop_app__", format: "compact" },
      },
      "darwin",
    );

    expect(result.ok).toBe(false);
    expect(ax.openCount).toBe(1);
    expect(cdp.openCount).toBe(0);
    expect(visual.openCount).toBe(0);
  });

  it("never falls from an explicit CDP endpoint onto a native app target", async () => {
    const bus = createTransportBus();
    const cdp = new StubTransport(
      "cdp-browser",
      ["snapshot"],
      ok({ transport: "cdp-browser" }),
    );
    cdp.snapshotFailure = new Error("explicit renderer disconnected");
    const ax = new StubTransport(
      "desktop-ax",
      ["ax_snapshot"],
      ok({ transport: "desktop-ax" }),
    );
    bus.register(cdp);
    bus.register(ax);

    const result = await tryCascade(
      bus,
      {
        kind: "compute_snapshot",
        params: { app: "Code", port: 9333, format: "json" },
      },
      "darwin",
    );

    expect(result.ok).toBe(false);
    expect(cdp.openCount).toBe(1);
    expect(ax.openCount).toBe(0);
  });

  it.each([
    {
      port: 9222,
      webSocketDebuggerUrl: "http://127.0.0.1:9222/devtools/page/one",
    },
    {
      port: 9222,
      webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/one",
    },
  ])("rejects an invalid or contradictory CDP target %#", async (params) => {
    const bus = createTransportBus();
    const cdp = new StubTransport(
      "cdp-browser",
      ["snapshot"],
      ok({ transport: "cdp-browser" }),
    );
    const visual = new StubTransport(
      "visual",
      ["visual_snapshot"],
      ok({ transport: "visual" }),
    );
    bus.register(cdp);
    bus.register(visual);

    const result = await tryCascade(
      bus,
      { kind: "compute_snapshot", params },
      "linux",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.minimum_capability).toBe(
        "compute.compute_snapshot.invalid_input",
      );
      expect(result.error.exit_code).toBe(2);
    }
    expect(cdp.openCount).toBe(0);
    expect(visual.openCount).toBe(0);
  });

  it("never falls from an explicit native pid onto CDP or Visual", async () => {
    const bus = createTransportBus();
    const atspi = new StubTransport(
      "desktop-atspi",
      ["atspi_snapshot"],
      failure("desktop-atspi", "atspi_snapshot"),
    );
    atspi.snapshotFailure = new Error("requested pid is unavailable");
    const cdp = new StubTransport(
      "cdp-browser",
      ["snapshot"],
      ok({ transport: "cdp-browser" }),
    );
    const visual = new StubTransport(
      "visual",
      ["visual_snapshot"],
      ok({ transport: "visual" }),
    );
    bus.register(atspi);
    bus.register(cdp);
    bus.register(visual);

    const result = await tryCascade(
      bus,
      { kind: "compute_snapshot", params: { pid: 4242 } },
      "linux",
    );

    expect(result.ok).toBe(false);
    expect(atspi.openCount).toBe(1);
    expect(cdp.openCount).toBe(0);
    expect(visual.openCount).toBe(0);
  });

  it("post-processes native sidecar snapshots into requested compact encoding", async () => {
    const bus = createTransportBus();
    const atspi = new StubTransport(
      "desktop-atspi",
      ["atspi_snapshot"],
      ok({ raw: true }),
    );
    atspi.snapshotResult = {
      format: "text",
      encoding: "compact",
      data: '@e1 window "Terminal"',
      refs: { count: 1, scope: "pid-1234" },
    };
    bus.register(atspi);

    const result = await tryCascade(
      bus,
      {
        kind: "compute_snapshot",
        params: { app: "Terminal", format: "compact" },
      },
      "linux",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({
        format: "text",
        encoding: "compact",
        data: '@e1 window "Terminal"',
        refs: { count: 1, scope: "pid-1234" },
      });
    }
    expect(atspi.calls).toEqual([]);
    expect(atspi.snapshots).toEqual([
      {
        format: "compact",
        params: { app: "Terminal", format: "compact" },
      },
    ]);
  });

  it("executes native sidecar snapshots once and never converts failure to success", async () => {
    const bus = createTransportBus();
    const atspi = new StubTransport(
      "desktop-atspi",
      ["atspi_snapshot"],
      ok({ raw: true }),
    );
    atspi.snapshotFailure = new Error("AT-SPI snapshot failed");
    bus.register(atspi);

    const result = await tryCascade(
      bus,
      {
        kind: "compute_snapshot",
        params: { app: "Terminal", format: "compact" },
      },
      "linux",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toContain("AT-SPI snapshot failed");
    }
    expect(atspi.calls).toEqual([]);
    expect(atspi.snapshots).toEqual([
      {
        format: "compact",
        params: { app: "Terminal", format: "compact" },
      },
    ]);
  });

  it("preserves a native sidecar target-not-found taxonomy", async () => {
    const bus = createTransportBus();
    const atspi = new StubTransport(
      "desktop-atspi",
      ["atspi_snapshot"],
      ok({ raw: true }),
    );
    atspi.snapshotFailure = {
      transport: "desktop-atspi",
      action: "atspi_snapshot",
      reason: "no AT-SPI window matched app=Missing",
      suggestion: "verify the app is running",
      minimum_capability: "desktop-atspi.target_not_found",
      exit_code: 66,
    };
    bus.register(atspi);

    const result = await tryCascade(
      bus,
      {
        kind: "compute_snapshot",
        params: { app: "Missing", format: "json" },
      },
      "linux",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        reason: "no AT-SPI window matched app=Missing",
        minimum_capability: "desktop-atspi.target_not_found",
        exit_code: 66,
      });
    }
  });

  it("prefers CDP for snapshots when a persisted CDP session is present", async () => {
    const bus = createTransportBus();
    const ax = new StubTransport(
      "desktop-ax",
      ["ax_snapshot"],
      ok({ transport: "desktop-ax" }),
    );
    const cdp = new StubTransport(
      "cdp-browser",
      ["snapshot"],
      ok({ transport: "cdp-browser" }),
    );
    cdp.snapshotResult = {
      format: "text",
      encoding: "compact",
      data: '@e1 button "Run"',
      refs: { count: 1, scope: "renderer" },
    };
    bus.register(ax);
    bus.register(cdp);

    const result = await tryCascade(
      bus,
      {
        kind: "compute_snapshot",
        params: {
          format: "compact",
          port: 9238,
          webSocketDebuggerUrl: "ws://127.0.0.1:9238/page-1",
        },
      },
      "darwin",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({
        format: "text",
        encoding: "compact",
        data: '@e1 button "Run"',
        refs: { count: 1, scope: "renderer" },
      });
    }
    expect(cdp.calls).toEqual([]);
    expect(cdp.snapshots).toEqual([
      {
        format: "compact",
        params: {
          format: "compact",
          port: 9238,
          webSocketDebuggerUrl: "ws://127.0.0.1:9238/page-1",
        },
      },
    ]);
    expect(ax.calls).toHaveLength(0);
  });

  it("times out an unmet text condition instead of accepting a delay", async () => {
    const bus = createTransportBus();
    const ax = new StubTransport(
      "desktop-ax",
      ["ax_snapshot"],
      ok({ transport: "desktop-ax" }),
    );
    ax.snapshotResult = {
      format: "text",
      encoding: "compact",
      data: '@e1 window "Calculator"',
    };
    const visual = new StubTransport("visual", ["visual_wait"], ok({ ms: 0 }));
    const subprocess = new StubTransport("subprocess", ["wait"], ok(undefined));
    bus.register(ax);
    bus.register(visual);
    bus.register(subprocess);

    const result = await tryCascade(
      bus,
      {
        kind: "compute_wait",
        params: {
          app: "Calculator",
          text: "never-present",
          timeoutMs: 25,
        },
      },
      "darwin",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.minimum_capability).toBe(
        "compute.compute_wait.timeout",
      );
      expect(result.error.exit_code).toBe(66);
    }
    expect(ax.snapshots.length).toBeGreaterThan(0);
    expect(visual.openCount).toBe(0);
    expect(subprocess.openCount).toBe(0);
    expect(ax.snapshots.every((snapshot) => snapshot.fresh === true)).toBe(
      true,
    );
  });

  it("keeps an explicit CDP renderer id on every fresh wait snapshot", async () => {
    const bus = createTransportBus();
    const cdp = new StubTransport(
      "cdp-browser",
      ["snapshot"],
      ok({ transport: "cdp-browser" }),
    );
    cdp.snapshotResult = {
      format: "text",
      encoding: "compact",
      data: '@e1 text "Ready"',
      refs: { count: 1, scope: "renderer-b" },
    };
    bus.register(cdp);

    const result = await tryCascade(
      bus,
      {
        kind: "compute_wait",
        params: {
          port: 9222,
          targetId: "renderer-b",
          text: "Ready",
          timeoutMs: 500,
        },
      },
      "darwin",
    );

    expect(result.ok).toBe(true);
    expect(cdp.snapshots).toHaveLength(1);
    expect(cdp.snapshots[0]).toMatchObject({
      params: { port: 9222, targetId: "renderer-b" },
    });
  });

  it("matches visible AX content but never JSON metadata", async () => {
    const bus = createTransportBus();
    const ax = new StubTransport(
      "desktop-ax",
      ["ax_snapshot"],
      ok({ transport: "desktop-ax" }),
    );
    ax.snapshotResult = {
      format: "json",
      encoding: "json",
      data: JSON.stringify({
        role: "AXWindow",
        name: "Terminal",
        scope: "focusedWindow",
        path: "AXWindow[0]",
        children: [],
      }),
      refs: { count: 1, scope: "focusedWindow" },
    };
    bus.register(ax);

    const result = await tryCascade(
      bus,
      {
        kind: "compute_wait",
        params: {
          app: "Terminal",
          text: "focusedWindow",
          timeoutMs: 25,
        },
      },
      "darwin",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.minimum_capability).toBe(
        "compute.compute_wait.timeout",
      );
    }
  });

  it("keeps target absence retryable for an appear wait until its deadline", async () => {
    const bus = createTransportBus();
    const ax = new StubTransport(
      "desktop-ax",
      ["ax_snapshot"],
      err({
        transport: "desktop-ax",
        step: 0,
        action: "ax_snapshot",
        reason: "target app is not running: Missing",
        suggestion: "launch the app first",
        minimum_capability: "desktop-ax.ax_snapshot.target_not_found",
        retryable: false,
        exit_code: 69,
      }),
    );
    bus.register(ax);

    const result = await tryCascade(
      bus,
      {
        kind: "compute_wait",
        params: { app: "Missing", text: "Ready", timeoutMs: 75 },
      },
      "darwin",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toContain("within 75ms");
      expect(result.error.minimum_capability).toBe(
        "compute.compute_wait.timeout",
      );
    }
    expect(ax.openCount).toBeGreaterThan(1);
  });

  it("returns only after a later target snapshot satisfies the condition", async () => {
    const bus = createTransportBus();
    const ax = new StubTransport(
      "desktop-ax",
      ["ax_snapshot"],
      ok({ transport: "desktop-ax" }),
    );
    let snapshotCount = 0;
    ax.snapshotFactory = () => ({
      format: "text",
      encoding: "compact",
      data:
        ++snapshotCount === 1
          ? '@e1 window "Calculator"'
          : '@e1 window "Calculator"\n@e2 text "Ready"',
    });
    bus.register(ax);

    const result = await tryCascade(
      bus,
      {
        kind: "compute_wait",
        params: {
          app: "Calculator",
          text: "Ready",
          timeoutMs: 500,
        },
      },
      "darwin",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({
        matched: true,
        state: "appear",
        attempts: 2,
        target: { app: "Calculator", transport: "desktop-ax" },
      });
    }
  });

  it("requires a fresh ref generation to report the focused state", async () => {
    const bus = createTransportBus();
    const initial = new RefAllocator();
    initial.alloc({
      ...EXACT_AX_REF_TARGET,
      stable: "desktop-ax:window-4242:AXWindow[0]/AXButton[0]",
      role: "AXButton",
      name: "Equals",
      app: "Calculator",
    });
    bus.refs.put(initial.freeze("desktop-ax", "window-4242"));
    const ax = new StubTransport(
      "desktop-ax",
      ["ax_snapshot"],
      ok({ transport: "desktop-ax" }),
    );
    let snapshotCount = 0;
    ax.snapshotFactory = () => {
      const current = new RefAllocator();
      current.alloc({
        ...EXACT_AX_REF_TARGET,
        stable: "desktop-ax:window-4242:AXWindow[0]/AXButton[0]",
        role: "AXButton",
        name: "Equals",
        app: "Calculator",
        states: ++snapshotCount === 1 ? ["enabled"] : ["enabled", "focused"],
      });
      bus.refs.put(current.freeze("desktop-ax", "window-4242"));
      return {
        format: "json",
        encoding: "json",
        data: '{"role":"AXButton","name":"Equals"}',
        refs: { count: 1, scope: "window-4242" },
      };
    };
    bus.register(ax);

    const result = await tryCascade(
      bus,
      {
        kind: "compute_wait",
        params: { ref: "@e1", state: "focused", timeoutMs: 500 },
      },
      "darwin",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({
        state: "focused",
        attempts: 2,
        target: {
          app: "Calculator",
          ref: "desktop-ax:window-4242:AXWindow[0]/AXButton[0]",
          transport: "desktop-ax",
        },
      });
    }
  });

  it("observes ref disappearance only after the target bucket is replaced", async () => {
    const bus = createTransportBus();
    const initial = new RefAllocator();
    initial.alloc({
      ...EXACT_AX_REF_TARGET,
      stable: "desktop-ax:window-4242:AXWindow[0]/AXButton[0]",
      role: "AXButton",
      name: "Equals",
      app: "Calculator",
    });
    bus.refs.put(initial.freeze("desktop-ax", "window-4242"));
    const ax = new StubTransport(
      "desktop-ax",
      ["ax_snapshot"],
      ok({ transport: "desktop-ax" }),
    );
    let snapshotCount = 0;
    ax.snapshotFactory = () => {
      const current = new RefAllocator();
      if (++snapshotCount === 1) {
        current.alloc({
          ...EXACT_AX_REF_TARGET,
          stable: "desktop-ax:window-4242:AXWindow[0]/AXButton[0]",
          role: "AXButton",
          name: "Equals",
          app: "Calculator",
        });
      }
      bus.refs.put(current.freeze("desktop-ax", "window-4242"));
      return {
        format: "json",
        encoding: "json",
        data: JSON.stringify({ role: "AXWindow", name: "Calculator" }),
        refs: { count: current.size, scope: "window-4242" },
      };
    };
    bus.register(ax);

    const result = await tryCascade(
      bus,
      {
        kind: "compute_wait",
        params: { ref: "@e1", state: "disappear", timeoutMs: 500 },
      },
      "darwin",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({ state: "disappear", attempts: 2 });
    }
  });

  it("allows disabled refs to be observed for disappearance", async () => {
    const bus = createTransportBus();
    const initial = new RefAllocator();
    initial.alloc({
      ...EXACT_AX_REF_TARGET,
      stable: "desktop-ax:window-4242:AXWindow[0]/AXButton[0]",
      role: "AXButton",
      name: "Equals",
      app: "Calculator",
      states: ["disabled"],
    });
    bus.refs.put(initial.freeze("desktop-ax", "window-4242"));
    const ax = new StubTransport(
      "desktop-ax",
      ["ax_snapshot"],
      ok({ transport: "desktop-ax" }),
    );
    ax.snapshotFactory = () => {
      bus.refs.put(new RefAllocator().freeze("desktop-ax", "window-4242"));
      return {
        format: "json",
        encoding: "json",
        data: '{"role":"AXWindow","name":"Calculator"}',
        refs: { count: 0, scope: "window-4242" },
      };
    };
    bus.register(ax);

    const result = await tryCascade(
      bus,
      {
        kind: "compute_wait",
        params: { ref: "@e1", state: "disappear", timeoutMs: 500 },
      },
      "darwin",
    );

    expect(result.ok).toBe(true);
  });

  it("waits for a disabled ref to become enabled from a fresh snapshot", async () => {
    const bus = createTransportBus();
    const initial = new RefAllocator();
    initial.alloc({
      ...EXACT_AX_REF_TARGET,
      stable: "desktop-ax:window-4242:AXWindow[0]/AXButton[0]",
      role: "AXButton",
      name: "Submit",
      states: ["disabled"],
    });
    bus.refs.put(initial.freeze("desktop-ax", "window-4242"));
    const ax = new StubTransport(
      "desktop-ax",
      ["ax_snapshot"],
      ok({ transport: "desktop-ax" }),
    );
    ax.snapshotFactory = () => {
      const current = new RefAllocator();
      current.alloc({
        ...EXACT_AX_REF_TARGET,
        stable: "desktop-ax:window-4242:AXWindow[0]/AXButton[0]",
        role: "AXButton",
        name: "Submit",
        states: ["enabled"],
      });
      bus.refs.put(current.freeze("desktop-ax", "window-4242"));
      return {
        format: "json",
        encoding: "json",
        data: '{"role":"AXButton","name":"Submit","states":["enabled"]}',
        refs: { count: 1, scope: "window-4242" },
      };
    };
    bus.register(ax);

    const result = await tryCascade(
      bus,
      {
        kind: "compute_wait",
        params: { ref: "@e1", state: "enabled", timeoutMs: 500 },
      },
      "darwin",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({ state: "enabled", attempts: 1 });
    }
  });

  it("rejects a text wait that has no immutable observation target", async () => {
    const bus = createTransportBus();
    const cdp = new StubTransport("cdp-browser", ["wait"], ok(undefined));
    bus.register(cdp);

    const result = await tryCascade(
      bus,
      {
        kind: "compute_wait",
        params: { text: "Ready", timeoutMs: 100 },
      },
      "darwin",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.minimum_capability).toBe(
        "compute.compute_wait.invalid_input",
      );
      expect(result.error.exit_code).toBe(2);
    }
    expect(cdp.openCount).toBe(0);
  });

  it("finds refs from the latest ref store by role and name", async () => {
    const bus = createTransportBus();
    const alloc = new RefAllocator();
    alloc.alloc({
      stable: "desktop-ax:calc:AXWindow[0]",
      role: "AXWindow",
      name: "Calculator",
    });
    alloc.alloc({
      stable: "desktop-ax:calc:AXWindow[0]/AXButton[0]",
      role: "AXButton",
      name: "5",
    });
    bus.refs.put(alloc.freeze("desktop-ax", "calc"));

    const result = await tryCascade(
      bus,
      {
        kind: "compute_find",
        params: { role: "button", name: "5", first: true },
      },
      "darwin",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({
        provider: "unicli.compute",
        alias: "@e2",
        stable: "desktop-ax:calc:AXWindow[0]/AXButton[0]",
        transport: "desktop-ax",
        scope: "calc",
        ttlMs: 3_600_000,
        role: "AXButton",
        name: "5",
      });
    }
  });

  it("filters compute find by exact app and window identity", async () => {
    const bus = createTransportBus();
    const first = new RefAllocator();
    first.alloc({
      stable: "desktop-ax:window-4101:AXWindow[0]/AXButton[0]",
      role: "AXButton",
      name: "Send",
      app: "Slack",
      pid: 101,
      windowId: 4101,
    });
    const second = new RefAllocator();
    second.alloc({
      stable: "desktop-ax:window-4202:AXWindow[0]/AXButton[0]",
      role: "AXButton",
      name: "Send",
      app: "Teams",
      pid: 202,
      windowId: 4202,
    });
    bus.refs.put(first.freeze("desktop-ax", "window-4101"));
    bus.refs.put(second.freeze("desktop-ax", "window-4202"));

    const result = await tryCascade(
      bus,
      {
        kind: "compute_find",
        params: {
          role: "button",
          name: "Send",
          app: "teams",
          windowId: 4202,
          first: true,
        },
      },
      "darwin",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({
        stable: "desktop-ax:window-4202:AXWindow[0]/AXButton[0]",
        app: "Teams",
        pid: 202,
        windowId: 4202,
      });
    }
  });

  it("finds refs by stored text value", async () => {
    const bus = createTransportBus();
    const alloc = new RefAllocator();
    alloc.alloc({
      stable: "desktop-atspi:calc:frame[0]/text[0]",
      role: "text",
      name: "Memory",
      value: "0",
    });
    alloc.alloc({
      stable: "desktop-atspi:calc:frame[0]/text[1]",
      role: "text",
      name: "Display",
      value: "8",
    });
    alloc.alloc({
      stable: "desktop-atspi:calc:frame[0]/push_button[0]",
      role: "push_button",
      name: "8",
    });
    bus.refs.put(alloc.freeze("desktop-atspi", "calc"));

    const result = await tryCascade(
      bus,
      {
        kind: "compute_find",
        params: { role: "input", text: "8", first: true },
      },
      "linux",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({
        provider: "unicli.compute",
        alias: "@e2",
        stable: "desktop-atspi:calc:frame[0]/text[1]",
        transport: "desktop-atspi",
        scope: "calc",
        role: "text",
        name: "Display",
        value: "8",
      });
    }
  });

  it("adds ref provenance to snapshots when the transport allocated refs", async () => {
    const bus = createTransportBus();
    const cdp = new StubTransport(
      "cdp-browser",
      ["snapshot"],
      ok({ transport: "cdp-browser" }),
    );
    const alloc = new RefAllocator();
    alloc.alloc({
      stable: "cdp-browser:renderer:button[data-testid='run']",
      role: "button",
      name: "Run",
      app: "VS Code",
      pid: 42,
    });
    bus.refs.put(alloc.freeze("cdp-browser", "renderer"));
    cdp.snapshotResult = {
      format: "text",
      encoding: "compact",
      data: '@e1 button "Run"',
      refs: { count: 1, scope: "renderer" },
    };
    bus.register(cdp);

    const result = await tryCascade(
      bus,
      {
        kind: "compute_snapshot",
        params: {
          format: "compact",
          port: 9238,
          webSocketDebuggerUrl: "ws://127.0.0.1:9238/page-1",
        },
      },
      "darwin",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({
        refs: {
          count: 1,
          scope: "renderer",
          provenance: {
            provider: "unicli.compute",
            accepted_namespaces: expect.arrayContaining([
              "desktop-ax:* stable refs from the Uni-CLI macOS AX transport",
            ]),
            records: [
              expect.objectContaining({
                provider: "unicli.compute",
                alias: "@e1",
                stable: "cdp-browser:renderer:button[data-testid='run']",
                transport: "cdp-browser",
                scope: "renderer",
                app: "VS Code",
                pid: 42,
              }),
            ],
          },
        },
      });
    }
  });

  it("returns app_ambiguous instead of choosing first across matching apps", async () => {
    const bus = createTransportBus();
    const left = new RefAllocator();
    left.alloc({
      stable: "desktop-ax:slack-a:AXWindow[0]/AXButton[0]",
      role: "AXButton",
      name: "Send",
      app: "Slack",
      pid: 101,
    });
    bus.refs.put(left.freeze("desktop-ax", "slack-a"));
    const right = new RefAllocator();
    right.alloc({
      stable: "desktop-ax:slack-b:AXWindow[0]/AXButton[0]",
      role: "AXButton",
      name: "Send",
      app: "Slack",
      pid: 202,
    });
    bus.refs.put(right.freeze("desktop-ax", "slack-b"));

    const result = await tryCascade(
      bus,
      {
        kind: "compute_find",
        params: { role: "button", name: "Send", first: true },
      },
      "darwin",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.minimum_capability).toBe(
        "compute.compute_find.app_ambiguous",
      );
      expect(result.error.remedy).toMatchObject({
        command: "unicli compute windows --app <name>",
      });
      expect(result.error.exit_code).toBe(66);
    }
  });

  it("does not replay a failed UIA ref through the unrelated screen", async () => {
    const bus = createTransportBus();
    const alloc = new RefAllocator();
    alloc.alloc({
      stable: "desktop-uia:window-0x2:Window[0]/Button[0]",
      role: "Button",
      name: "Submit",
      app: "Browser",
      pid: 42,
      windowId: "0x2",
      bounds: { x: 10, y: 10, w: 100, h: 30 },
    });
    bus.refs.put(alloc.freeze("desktop-uia", "window-0x2"));
    const uia = new StubTransport(
      "desktop-uia",
      ["uia_invoke"],
      failure("desktop-uia", "uia_invoke"),
    );
    const visual = new StubTransport(
      "visual",
      ["visual_click"],
      ok({ transport: "visual" }),
    );
    bus.register(uia);
    bus.register(visual);

    const result = await tryCascade(
      bus,
      { kind: "compute_click", params: { ref: "@e1" } },
      "win32",
    );

    expect(result.ok).toBe(false);
    expect(uia.calls.map((call) => call.kind)).toEqual(["uia_invoke"]);
    expect(visual.openCount).toBe(0);
  });

  it("returns a merged failure envelope when every transport fails", async () => {
    const bus = createTransportBus();
    bus.register(
      new StubTransport(
        "cdp-browser",
        ["screenshot"],
        failure("cdp-browser", "screenshot"),
      ),
    );
    bus.register(
      new StubTransport(
        "desktop-uia",
        ["uia_screenshot"],
        failure("desktop-uia", "uia_screenshot"),
      ),
    );
    bus.register(
      new StubTransport(
        "visual",
        ["visual_snapshot"],
        failure("visual", "visual_snapshot"),
      ),
    );

    const result = await tryCascade(
      bus,
      { kind: "compute_screenshot", params: {} },
      "win32",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toContain(
        "all target-compatible transports failed",
      );
      expect(result.error.reason).toContain("cdp-browser");
      expect(result.error.reason).toContain("desktop-uia");
      expect(result.error.reason).toContain("visual");
      expect(result.error.minimum_capability).toBe(
        "compute.compute_screenshot.no-transport-available",
      );
      expect(result.error.remedy).toMatchObject({
        message: "Run the compute doctor to identify the blocked transport.",
        command: "unicli doctor compute",
      });
      expect(result.error.exit_code).toBe(69);
    }
  });
});
