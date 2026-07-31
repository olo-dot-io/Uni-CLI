import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ok } from "../../src/core/envelope.js";
import { createTransportBus } from "../../src/transport/bus.js";
import { dispatchComputeRoute } from "../../src/transport/compute-dispatch.js";
import type {
  ActionRequest,
  ActionResult,
  Capability,
  Snapshot,
  TransportAdapter,
  TransportContext,
  TransportKind,
} from "../../src/transport/types.js";

class ObservationTransport implements TransportAdapter {
  readonly capability: Capability;
  readonly calls: ActionRequest[] = [];

  constructor(readonly kind: TransportKind) {
    this.capability = {
      steps:
        kind === "visual"
          ? ["visual_snapshot", "visual_click"]
          : ["cua_get_desktop_state", "cua_click"],
      snapshotFormats: ["screenshot"],
      mutatesHost: true,
    };
  }

  async open(_ctx: TransportContext): Promise<void> {}

  async snapshot(): Promise<Snapshot> {
    throw new Error("dispatch must use the selected physical action");
  }

  async action<T = unknown>(req: ActionRequest): Promise<ActionResult<T>> {
    this.calls.push(req);
    if (req.kind === "visual_snapshot") {
      return ok({
        base64: Buffer.from("visual-pixels").toString("base64"),
        width: 400,
        height: 200,
      } as T);
    }
    if (req.kind === "cua_get_desktop_state") {
      return ok({
        screenshot_png_b64: Buffer.from("driver-pixels").toString("base64"),
        screenshot_width: 400,
        screenshot_height: 200,
        screen_width: 200,
        screen_height: 100,
        scale_factor: 2,
        display: "main",
      } as T);
    }
    return ok({ transport: this.kind, acted: true } as T);
  }

  async close(): Promise<void> {}
}

let observationRoot = "";

beforeEach(async () => {
  observationRoot = await mkdtemp(
    join(tmpdir(), "unicli-dispatch-observation-"),
  );
  process.env.UNICLI_VISUAL_OBSERVATION_ROOT = observationRoot;
});

afterEach(async () => {
  delete process.env.UNICLI_VISUAL_OBSERVATION_ROOT;
  await rm(observationRoot, { recursive: true, force: true });
});

describe("compute visual-observation dispatch", () => {
  it("issues one opaque ref and consumes it before same-provider actuation", async () => {
    const bus = createTransportBus();
    const visual = new ObservationTransport("visual");
    bus.register(visual);

    const screenshot = await dispatchComputeRoute(
      bus,
      { kind: "compute_screenshot", params: { via: "visual" } },
      "darwin",
    );
    expect(screenshot.ok).toBe(true);
    if (!screenshot.ok) return;
    const observation = (screenshot.data as { observation: { ref: string } })
      .observation.ref;

    const click = await dispatchComputeRoute(
      bus,
      {
        kind: "compute_point_click",
        params: { x: 120, y: 80, via: "visual", observation },
      },
      "darwin",
    );
    expect(click.ok).toBe(true);
    expect(visual.calls.at(-1)).toMatchObject({
      kind: "visual_click",
      params: { x: 120, y: 80 },
    });

    const replay = await dispatchComputeRoute(
      bus,
      {
        kind: "compute_point_click",
        params: { x: 120, y: 80, via: "visual", observation },
      },
      "darwin",
    );
    expect(replay).toMatchObject({
      ok: false,
      error: {
        minimum_capability: "compute.compute_point_click.visual_observation",
        reason: expect.stringContaining("already consumed"),
      },
    });
    expect(
      visual.calls.filter((call) => call.kind === "visual_click"),
    ).toHaveLength(1);
  });

  it("rejects cross-provider evidence without opening the requested provider", async () => {
    const bus = createTransportBus();
    const visual = new ObservationTransport("visual");
    const driver = new ObservationTransport("cua-driver");
    bus.register(visual);
    bus.register(driver);
    const screenshot = await dispatchComputeRoute(
      bus,
      { kind: "compute_screenshot", params: { via: "visual" } },
      "darwin",
    );
    if (!screenshot.ok) throw new Error("fixture screenshot failed");
    const observation = (screenshot.data as { observation: { ref: string } })
      .observation.ref;

    const click = await dispatchComputeRoute(
      bus,
      {
        kind: "compute_point_click",
        params: { x: 20, y: 10, via: "driver", observation },
      },
      "darwin",
    );
    expect(click).toMatchObject({
      ok: false,
      error: { reason: expect.stringContaining("provider_mismatch") },
    });
    expect(driver.calls).toEqual([]);
  });

  it("binds driver session and transforms image pixels into action coordinates", async () => {
    const bus = createTransportBus();
    const driver = new ObservationTransport("cua-driver");
    bus.register(driver);
    const screenshot = await dispatchComputeRoute(
      bus,
      {
        kind: "compute_screenshot",
        params: { via: "driver", session: "agent-1" },
      },
      "darwin",
    );
    if (!screenshot.ok) throw new Error("fixture screenshot failed");
    const observation = (screenshot.data as { observation: { ref: string } })
      .observation.ref;

    const mismatch = await dispatchComputeRoute(
      bus,
      {
        kind: "compute_point_click",
        params: {
          x: 100,
          y: 50,
          via: "driver",
          session: "agent-2",
          observation,
        },
      },
      "darwin",
    );
    expect(mismatch).toMatchObject({
      ok: false,
      error: { reason: expect.stringContaining("session_mismatch") },
    });

    const click = await dispatchComputeRoute(
      bus,
      {
        kind: "compute_point_click",
        params: {
          x: 100,
          y: 50,
          via: "driver",
          session: "agent-1",
          observation,
        },
      },
      "darwin",
    );
    expect(click.ok).toBe(true);
    expect(driver.calls.at(-1)).toMatchObject({
      kind: "cua_click",
      params: { x: 50, y: 25, session: "agent-1" },
    });
  });

  it("returns typed evidence failure before any provider opens when missing", async () => {
    const bus = createTransportBus();
    const visual = new ObservationTransport("visual");
    bus.register(visual);
    const result = await dispatchComputeRoute(
      bus,
      { kind: "compute_point_click", params: { x: 10, y: 10, via: "visual" } },
      "darwin",
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        adapter_path: "src/compute/visual-observation.ts",
        minimum_capability: "compute.compute_point_click.visual_observation",
        exit_code: 2,
      },
    });
    expect(visual.calls).toEqual([]);
  });
});
