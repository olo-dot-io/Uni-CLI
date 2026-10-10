import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTransportBus } from "../../src/transport/bus.js";
import { dispatchComputeRoute } from "../../src/transport/compute-dispatch.js";
import {
  CuaDriverTransport,
  type CuaDriverRunner,
} from "../../src/transport/adapters/cua-driver.js";

// REASON: The external driver is modeled from trycua/cua's PNG-to-logical coordinate and session contracts; no host input is dispatched.
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAMgAAABkCAIAAABM5OhcAAABFklEQVR4nO3SQQkAMAzAwPo3vaoIg3KnII/Mg8D8DuAmY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFgljkTAWCWORMBYJY5EwFokFJhyDSNve8swAAAAASUVORK5CYII=";
const captures = new Map<string, { session: string; factor: number }>();
const sessionScales = new Map<string, number>();
let capped = false;
const delivered: Array<Record<string, unknown>> = [];
let captureSequence = 0;
const runner: CuaDriverRunner = async (invocation) => {
  const tool = invocation.args.at(-2);
  const args = JSON.parse(invocation.args.at(-1)!) as Record<string, unknown>;
  let value: Record<string, unknown>;
  if (tool === "get_desktop_state") {
    const captureId = `capture-${++captureSequence}`;
    if (typeof args.session === "string" && args.session !== "default") {
      captures.set(captureId, {
        session: args.session,
        factor: capped ? 1 : 0.5,
      });
      sessionScales.set(args.session, capped ? 2 : 1);
    }
    value = {
      platform: "macos",
      display: "primary",
      screenshot_width: 200,
      screenshot_height: 100,
      screen_width: capped ? 200 : 100,
      screen_height: capped ? 100 : 50,
      ...(capped
        ? { screenshot_original_width: 400, screenshot_original_height: 200 }
        : {}),
      scale_factor: 2,
      screenshot_mime_type: "image/png",
      screenshot_png_b64: png,
      capture_id: captureId,
    };
  } else {
    let factor = (sessionScales.get(String(args.session)) ?? 1) / 2;
    if (tool === "click" && args.capture_id !== undefined) {
      const capture = captures.get(String(args.capture_id));
      if (capture === undefined || capture.session !== args.session) {
        return {
          stdout: JSON.stringify({
            effect: "refused",
            route: "global_input",
            error: { code: "capture_expired" },
          }),
          stderr: "",
          exitCode: 0,
          signal: null,
        };
      }
      factor = capture.factor;
      captures.delete(String(args.capture_id));
    }
    const x = Number(args.x ?? args.to_x);
    const y = Number(args.y ?? args.to_y);
    delivered.push({
      tool,
      x: x * factor,
      y: y * factor,
      session: args.session,
      capture_id: args.capture_id,
    });
    value = {
      effect: "unverifiable",
      route: "global_input",
      delivery: { mode: "foreground" },
    };
  }
  return {
    stdout: JSON.stringify(value),
    stderr: "",
    exitCode: 0,
    signal: null,
  };
};

function bus() {
  const result = createTransportBus();
  result.register(new CuaDriverTransport({ runner }));
  return result;
}

const root = await mkdtemp(join(tmpdir(), "unicli-cua-lifecycle-"));
const previousRoot = process.env.UNICLI_VISUAL_OBSERVATION_ROOT;
process.env.UNICLI_VISUAL_OBSERVATION_ROOT = root;
const results: Array<{ scenario: string; ok: boolean; detail?: unknown }> = [];
try {
  for (const frame of ["native", "capped"]) {
    capped = frame === "capped";
    for (const session of [undefined, "default", "scenario-session"]) {
      for (const kind of [
        "compute_point_click",
        "compute_move_cursor",
        "compute_point_scroll",
        "compute_drag",
      ]) {
        const params = { via: "driver", ...(session ? { session } : {}) };
        const firstBus = bus();
        const screenshot = await dispatchComputeRoute(
          firstBus,
          { kind: "compute_screenshot", params },
          "darwin",
        );
        await firstBus.get("cua-driver").close();
        if (!screenshot.ok) throw new Error(screenshot.error.reason);
        const data = screenshot.data as { observation: { ref: string } };
        // A new transport consumes the persisted ref, as a later CLI invocation does.
        const secondBus = bus();
        const action = {
          kind,
          params: {
            ...params,
            observation: data.observation.ref,
            ...(kind === "compute_drag"
              ? { fromX: 20, fromY: 10, toX: 120, toY: 40 }
              : { x: 120, y: 40 }),
          },
        };
        const result = await dispatchComputeRoute(secondBus, action, "darwin");
        const actual = delivered.at(-1);
        results.push({
          scenario: `${frame} ${session ?? "implicit"} ${kind} Retina pixel`,
          ok:
            result.ok &&
            actual?.x === (capped ? 120 : 60) &&
            actual?.y === (capped ? 40 : 20),
          detail: actual,
        });
        if (kind === "compute_point_click") {
          results.push({
            scenario: `${frame} ${session ?? "implicit"} capture binding`,
            ok:
              typeof actual?.capture_id === "string" &&
              typeof actual.session === "string",
          });
        }
        const count = delivered.length;
        const replay = await dispatchComputeRoute(secondBus, action, "darwin");
        results.push({
          scenario: `${frame} ${session ?? "implicit"} ${kind} single use`,
          ok: !replay.ok && delivered.length === count,
        });
        await secondBus.get("cua-driver").close();
      }
    }
  }
  const restartBus = bus();
  const screenshot = await dispatchComputeRoute(
    restartBus,
    {
      kind: "compute_screenshot",
      params: { via: "driver", session: "restart-session" },
    },
    "darwin",
  );
  if (!screenshot.ok) throw new Error(screenshot.error.reason);
  const observation = (screenshot.data as { observation: { ref: string } })
    .observation.ref;
  captures.clear();
  const beforeRestartClick = delivered.length;
  const stale = await dispatchComputeRoute(
    restartBus,
    {
      kind: "compute_point_click",
      params: {
        via: "driver",
        session: "restart-session",
        observation,
        x: 120,
        y: 40,
      },
    },
    "darwin",
  );
  results.push({
    scenario: "driver restart invalidates provider capture",
    ok: !stale.ok && delivered.length === beforeRestartClick,
  });
  const upgraded = await dispatchComputeRoute(
    restartBus,
    { kind: "compute_screenshot", params: { via: "driver" } },
    "darwin",
  );
  if (!upgraded.ok) throw new Error(upgraded.error.reason);
  const oldRef = (upgraded.data as { observation: { ref: string } }).observation
    .ref;
  const oldPath = join(root, `${oldRef.split(":")[1]}.json`);
  const oldRecord = JSON.parse(await readFile(oldPath, "utf8"));
  oldRecord.schema_version = 1;
  oldRecord.action_width = 100;
  oldRecord.action_height = 50;
  delete oldRecord.provider_session;
  delete oldRecord.provider_capture_id;
  await writeFile(oldPath, JSON.stringify(oldRecord));
  const beforeOldClick = delivered.length;
  const legacyAction = {
    kind: "compute_point_click",
    params: { via: "driver", observation: oldRef, x: 120, y: 40 },
  };
  const legacy = await dispatchComputeRoute(restartBus, legacyAction, "darwin");
  results.push({
    scenario: "upgrade reload rejects old logical-coordinate record",
    ok: !legacy.ok && delivered.length === beforeOldClick,
  });
  const fresh = await dispatchComputeRoute(
    restartBus,
    { kind: "compute_screenshot", params: { via: "driver" } },
    "darwin",
  );
  if (!fresh.ok) throw new Error(fresh.error.reason);
  const recovered = await dispatchComputeRoute(
    restartBus,
    {
      ...legacyAction,
      params: {
        ...legacyAction.params,
        observation: (fresh.data as { observation: { ref: string } })
          .observation.ref,
      },
    },
    "darwin",
  );
  results.push({
    scenario: "upgrade recovery consumes a fresh PNG-coordinate record",
    ok: recovered.ok && delivered.at(-1)?.x === 120,
  });
  await restartBus.get("cua-driver").close();
} finally {
  if (previousRoot === undefined)
    delete process.env.UNICLI_VISUAL_OBSERVATION_ROOT;
  else process.env.UNICLI_VISUAL_OBSERVATION_ROOT = previousRoot;
  await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify(results, null, 2));
process.exitCode = results.every((result) => result.ok) ? 0 : 1;
