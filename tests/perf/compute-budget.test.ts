import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ok } from "../../src/core/envelope.js";
import { executeComputeAction } from "../../src/compute/action-execution.js";
import { issueVisualObservation } from "../../src/compute/visual-observation.js";
import { DesktopAtspiTransport } from "../../src/transport/adapters/desktop-atspi.js";
import { DesktopAxTransport } from "../../src/transport/adapters/desktop-ax.js";
import { DesktopUiaTransport } from "../../src/transport/adapters/desktop-uia.js";
import { createTransportBus } from "../../src/transport/bus.js";
import { dispatchComputeRoute } from "../../src/transport/compute-dispatch.js";
import { RefAllocator } from "../../src/transport/refs.js";
import {
  encodeSnapshot,
  type RawAxNode,
} from "../../src/transport/snapshot-encoder.js";
import type {
  ActionRequest,
  ActionResult,
  Capability,
  Snapshot,
  TransportAdapter,
  TransportBus,
  TransportContext,
  TransportKind,
} from "../../src/transport/types.js";

const FIXTURE_DIR = join(process.cwd(), "tests/fixtures/compute/snapshot");

const BUDGET_MS = {
  structuredWireP95: 15,
  snapshotEncode400P95: 15,
  cdpWarmP95: 40,
  visualP95: 3000,
  coordinatePostCaptureP95: 50,
  liveSnapshotP95: 80,
  clickBurst1000: 30_000,
} as const;

class BudgetTransport implements TransportAdapter {
  readonly kind: TransportKind = "desktop-ax";
  readonly capability: Capability = {
    steps: ["ax_snapshot", "ax_press"],
    snapshotFormats: ["text"],
    mutatesHost: true,
  };
  readonly calls: ActionRequest[] = [];

  async open(_ctx: TransportContext): Promise<void> {}

  async snapshot(): Promise<Snapshot> {
    return { format: "text", data: '@e1 button "OK"' };
  }

  async action<T = unknown>(req: ActionRequest): Promise<ActionResult<T>> {
    this.calls.push(req);
    return ok({ transport: this.kind, kind: req.kind } as T);
  }

  async close(): Promise<void> {}
}

class CoordinateBudgetTransport implements TransportAdapter {
  readonly kind: TransportKind = "cua-driver";
  readonly capability: Capability = {
    steps: ["cua_click", "cua_get_desktop_state"],
    snapshotFormats: ["screenshot"],
    mutatesHost: true,
  };

  async open(_ctx: TransportContext): Promise<void> {}

  async snapshot(): Promise<Snapshot> {
    return { format: "screenshot", data: Buffer.alloc(0) };
  }

  async action<T = unknown>(req: ActionRequest): Promise<ActionResult<T>> {
    if (req.kind === "cua_get_desktop_state") {
      return ok({
        transport: this.kind,
        screenshot_png_b64: POST_ACTION_FRAME_BASE64,
        screenshot_mime_type: "image/png",
        screenshot_width: 1280,
        screenshot_height: 720,
        screen_width: 1280,
        screen_height: 720,
      } as T);
    }
    return ok({ transport: this.kind, kind: req.kind } as T);
  }

  async close(): Promise<void> {}
}

const POST_ACTION_FRAME_BASE64 = Buffer.alloc(256 * 1024, 0x5a).toString(
  "base64",
);

describe("compute performance budget", () => {
  it("keeps selected-provider dispatch overhead under the p95 budget", async () => {
    const snapshot = await measureDispatch("compute_snapshot", {
      app: "Calculator",
      format: "compact",
    });
    const click = await measureDispatch("compute_click", { ref: "@e1" });

    expect(snapshot.p95).toBeLessThan(BUDGET_MS.structuredWireP95);
    expect(click.p95).toBeLessThan(BUDGET_MS.structuredWireP95);
  });

  it("keeps explicit coordinate-provider planning and dispatch under the p95 budget", async () => {
    const bus = createTransportBus();
    bus.register(new CoordinateBudgetTransport());
    const observations = await Promise.all(
      Array.from({ length: 30 }, async () =>
        issueVisualObservation({
          provider: "cua-driver",
          targetScope: "desktop",
          data: {
            screenshot_png_b64: Buffer.from("budget-pixels").toString("base64"),
            screenshot_width: 200,
            screenshot_height: 200,
            screen_width: 200,
            screen_height: 200,
          },
        }),
      ),
    );
    let observationIndex = 0;
    const samples = await measureAsync(30, async () => {
      const observation = observations[observationIndex++];
      if (!observation) throw new Error("missing visual observation fixture");
      const result = await dispatchComputeRoute(
        bus,
        {
          kind: "compute_point_click",
          params: {
            x: 120,
            y: 80,
            via: "driver",
            observation: observation.ref,
          },
        },
        "darwin",
      );
      expect(result.ok).toBe(true);
    });

    expect(samples.p95).toBeLessThan(BUDGET_MS.structuredWireP95);
  });

  it("keeps a 256 KiB same-provider post-action frame out of structured evidence within budget", async () => {
    const bus = createTransportBus();
    bus.register(new CoordinateBudgetTransport());
    const observations = await Promise.all(
      Array.from({ length: 20 }, async () =>
        issueVisualObservation({
          provider: "cua-driver",
          targetScope: "desktop",
          data: {
            screenshot_png_b64: POST_ACTION_FRAME_BASE64,
            screenshot_width: 1280,
            screenshot_height: 720,
            screen_width: 1280,
            screen_height: 720,
          },
        }),
      ),
    );
    let observationIndex = 0;
    const samples = await measureAsync(20, async () => {
      const observation = observations[observationIndex++];
      if (!observation) throw new Error("missing visual observation fixture");
      const execution = await executeComputeAction(
        bus,
        {
          kind: "compute_point_click",
          params: {
            x: 120,
            y: 80,
            via: "driver",
            observation: observation.ref,
          },
        },
        {
          tool: "computer-use.point_click",
          platform: "darwin",
          postActionCapture: "coordinate",
        },
      );
      expect(execution.result.ok).toBe(true);
      expect(JSON.stringify(execution.evidence)).not.toContain(
        POST_ACTION_FRAME_BASE64,
      );
      expect(execution.postActionImage?.data).toBe(POST_ACTION_FRAME_BASE64);
    });

    expect(samples.p95).toBeLessThan(BUDGET_MS.coordinatePostCaptureP95);
  });

  it("keeps 400-node snapshot encoding under the p95 budget", async () => {
    const fixture = loadFixture("vscode-editor");
    const samples = await measureAsync(30, async () => {
      const result = encodeSnapshot(fixture, {
        transport: "desktop-uia",
        alloc: new RefAllocator(),
        includeBounds: false,
      });
      expect(result.refCount).toBe(401);
    });

    expect(samples.p95).toBeLessThan(BUDGET_MS.snapshotEncode400P95);
  });

  it("keeps 1000 sequential compute_click calls under the burst budget", async () => {
    const bus = createTransportBus();
    const transport = new BudgetTransport();
    bus.register(transport);
    seedBudgetRefs(bus, 1000);

    const started = performance.now();
    for (let i = 1; i <= 1000; i++) {
      const result = await dispatchComputeRoute(
        bus,
        { kind: "compute_click", params: { ref: `@e${i}` } },
        "darwin",
      );
      expect(result.ok).toBe(true);
    }
    const elapsed = performance.now() - started;

    expect(transport.calls).toHaveLength(1000);
    expect(elapsed).toBeLessThan(BUDGET_MS.clickBurst1000);
  });

  const live = process.env.UNICLI_COMPUTE_PERF_LIVE === "1" ? it : it.skip;

  live("keeps live host snapshot p95 under budget", async () => {
    const bus = createLiveHostBus();
    const app = liveAppName();
    const request: ActionRequest = {
      kind: "compute_snapshot",
      params: {
        app,
        format: "compact",
        maxDepth: 4,
      },
    };
    try {
      const warmup = await dispatchComputeRoute(bus, request, process.platform);
      expect(warmup.ok).toBe(true);

      const samples = await measureAsync(10, async () => {
        const result = await dispatchComputeRoute(
          bus,
          request,
          process.platform,
        );
        expect(result.ok).toBe(true);
      });

      expect(samples.p95).toBeLessThan(BUDGET_MS.liveSnapshotP95);
    } finally {
      await Promise.all(
        bus.list().map((adapter) => adapter.close().catch(() => undefined)),
      );
    }
  });
});

async function measureDispatch(
  kind: string,
  params: Record<string, unknown>,
): Promise<{ p50: number; p95: number; p99: number }> {
  const bus = createTransportBus();
  bus.register(new BudgetTransport());
  seedBudgetRefs(bus, 1);
  return measureAsync(30, async () => {
    const result = await dispatchComputeRoute(bus, { kind, params }, "darwin");
    expect(result.ok).toBe(true);
  });
}

function seedBudgetRefs(bus: TransportBus, count: number): void {
  const alloc = new RefAllocator();
  for (let i = 1; i <= count; i++) {
    alloc.alloc({
      stable: `desktop-ax:window-42:AXWindow[0]/AXButton[${i}]`,
      role: "AXButton",
      name: `Button ${i}`,
      app: "Calculator",
      pid: 42,
      windowId: 42,
    });
  }
  bus.refs.put(alloc.freeze("desktop-ax", "window-42"));
}

async function measureAsync(
  iterations: number,
  fn: () => Promise<void>,
): Promise<{ p50: number; p95: number; p99: number }> {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const started = performance.now();
    await fn();
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  return {
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
  };
}

function percentile(
  samples: readonly number[],
  percentileValue: number,
): number {
  if (samples.length === 0) return 0;
  const index = Math.min(
    samples.length - 1,
    Math.ceil(samples.length * percentileValue) - 1,
  );
  return samples[index] ?? 0;
}

function loadFixture(name: string): RawAxNode {
  return JSON.parse(
    readFileSync(join(FIXTURE_DIR, `${name}.json`), "utf8"),
  ) as RawAxNode;
}

function liveAppName(): string {
  if (process.platform === "darwin") return "Calculator";
  if (process.platform === "win32") return "Calculator";
  return "gnome-calculator";
}

function createLiveHostBus(): TransportBus {
  const bus = createTransportBus();
  if (process.platform === "darwin") {
    bus.register(new DesktopAxTransport());
  } else if (process.platform === "win32") {
    bus.register(new DesktopUiaTransport());
  } else if (process.platform === "linux") {
    bus.register(new DesktopAtspiTransport());
  }
  return bus;
}
