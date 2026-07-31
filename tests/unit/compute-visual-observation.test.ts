import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  claimVisualObservation,
  issueVisualObservation,
  VisualObservationError,
} from "../../src/compute/visual-observation.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "unicli-observation-test-"));
  roots.push(value);
  return value;
}

const pixels = {
  screenshot_png_b64: Buffer.from("provider-owned-pixels").toString("base64"),
  screenshot_width: 200,
  screenshot_height: 100,
  screen_width: 100,
  screen_height: 50,
  scale_factor: 2,
  display: "main",
};

describe("opaque visual observations", () => {
  it("keeps authority server-side and admits exactly one atomic claim", async () => {
    const store = await root();
    const observation = await issueVisualObservation({
      provider: "cua-driver",
      targetScope: "desktop",
      data: pixels,
      session: "agent-1",
      now: 1_000,
      root: store,
    });

    expect(observation.ref).toMatch(/^visual-observation:[a-f0-9]{64}$/);
    expect(observation.ref).not.toContain("cua-driver");
    expect(observation.coordinate_space).toMatchObject({
      pixel_width: 200,
      pixel_height: 100,
      action_width: 100,
      action_height: 50,
      scale_x: 0.5,
      scale_y: 0.5,
    });

    const claim = await claimVisualObservation({
      ref: observation.ref,
      provider: "cua-driver",
      targetScope: "desktop",
      session: "agent-1",
      points: [{ x: 120, y: 40, label: "point" }],
      now: 1_001,
      root: store,
    });
    expect(claim.transform({ x: 120, y: 40, label: "point" })).toEqual({
      x: 60,
      y: 20,
      label: "point",
    });

    await expect(
      claimVisualObservation({
        ref: observation.ref,
        provider: "cua-driver",
        targetScope: "desktop",
        session: "agent-1",
        points: [{ x: 120, y: 40, label: "point" }],
        now: 1_002,
        root: store,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await claim.release();
  });

  it("rejects provider, scope, session, bounds, expiry, and forged refs", async () => {
    const store = await root();
    const observation = await issueVisualObservation({
      provider: "cua-driver",
      targetScope: "desktop",
      data: pixels,
      session: "agent-1",
      now: 2_000,
      ttlMs: 50,
      root: store,
    });
    const base = {
      ref: observation.ref,
      targetScope: "desktop" as const,
      session: "agent-1",
      points: [{ x: 20, y: 10, label: "point" }],
      now: 2_001,
      root: store,
    };

    await expect(
      claimVisualObservation({ ...base, provider: "visual" }),
    ).rejects.toMatchObject({ code: "provider_mismatch" });
    await expect(
      claimVisualObservation({
        ...base,
        provider: "cua-driver",
        targetScope: "native-window",
      }),
    ).rejects.toMatchObject({ code: "scope_mismatch" });
    await expect(
      claimVisualObservation({
        ...base,
        provider: "cua-driver",
        session: "agent-2",
      }),
    ).rejects.toMatchObject({ code: "session_mismatch" });
    await expect(
      claimVisualObservation({
        ...base,
        provider: "cua-driver",
        points: [{ x: 200, y: 10, label: "point" }],
      }),
    ).rejects.toMatchObject({ code: "out_of_bounds" });
    await expect(
      claimVisualObservation({
        ...base,
        provider: "cua-driver",
        now: 2_051,
      }),
    ).rejects.toMatchObject({ code: "expired" });
    await expect(
      claimVisualObservation({
        ...base,
        ref: `visual-observation:${"0".repeat(64)}`,
        provider: "cua-driver",
      }),
    ).rejects.toBeInstanceOf(VisualObservationError);
  });

  it("admits only one of two concurrent claimants", async () => {
    const store = await root();
    const observation = await issueVisualObservation({
      provider: "visual",
      targetScope: "desktop",
      data: {
        base64: Buffer.from("concurrent-pixels").toString("base64"),
        width: 100,
        height: 100,
      },
      root: store,
    });
    const claim = () =>
      claimVisualObservation({
        ref: observation.ref,
        provider: "visual",
        targetScope: "desktop",
        points: [{ x: 10, y: 10, label: "point" }],
        root: store,
      });
    const settled = await Promise.allSettled([claim(), claim()]);
    expect(
      settled.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      settled.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const winner = settled.find(
      (
        result,
      ): result is PromiseFulfilledResult<Awaited<ReturnType<typeof claim>>> =>
        result.status === "fulfilled",
    );
    await winner?.value.release();
  });
});
