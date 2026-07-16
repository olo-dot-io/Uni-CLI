/**
 * @owner   src/compute/linux-overlay.ts
 * @does    Render compute visual_action evidence through a Linux GTK full-screen HUD.
 * @needs   Python 3, PyGObject GTK 3, Cairo, src/compute/overlay-daemon.ts
 * @feeds   platform compute overlay selection, doctor compute, computer-use HUD rendering
 * @breaks  A non-click-through HUD can block AT-SPI or display-server action dispatch.
 * @invariants The HUD is visual-only, keep-above, input-shaped empty, and driven by visual_action samples.
 * @side-effects launches a Python/GTK helper process on Linux.
 * @perf    one persistent Python process per provider instance.
 * @concurrency daemon session serializes render requests.
 * @test    tests/unit/compute-linux-overlay.test.ts
 * @stability experimental
 * @since   0.224.0
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computeOverlayRequestFromAction,
  type ComputeOverlayProvider,
  type ComputeOverlayRequest,
} from "./overlay.js";
import {
  StdioComputeOverlayDaemonSession,
  type ComputeOverlayDaemonSession,
} from "./overlay-daemon.js";
import type {
  ComputeVisualAction,
  ComputeVisualCursorPoint,
  ComputeVisualOverlayStatus,
} from "./visual-timeline.js";

export interface LinuxGtkOverlayDaemonProviderOptions {
  platform?: NodeJS.Platform;
  scriptPath?: string;
  sessionFactory?: () => Promise<ComputeOverlayDaemonSession>;
}

export class LinuxGtkOverlayDaemonProvider implements ComputeOverlayProvider {
  readonly provider = "linux-gtk";

  private readonly platform: NodeJS.Platform;
  private readonly scriptPath: string | undefined;
  private readonly sessionFactory:
    | (() => Promise<ComputeOverlayDaemonSession>)
    | undefined;
  private session: ComputeOverlayDaemonSession | undefined;
  private tmpRoot: string | undefined;
  private lastPoint: ComputeVisualCursorPoint | undefined;

  constructor(opts: LinuxGtkOverlayDaemonProviderOptions = {}) {
    this.platform = opts.platform ?? process.platform;
    this.scriptPath = opts.scriptPath;
    this.sessionFactory = opts.sessionFactory;
  }

  currentPoint(): ComputeVisualCursorPoint | undefined {
    return this.lastPoint;
  }

  async render(
    action: ComputeVisualAction,
  ): Promise<ComputeVisualOverlayStatus> {
    const request = computeOverlayRequestFromAction(action);
    if (!request) return { provider: this.provider, status: "not_requested" };
    if (this.platform !== "linux") {
      return { provider: this.provider, status: "unavailable" };
    }
    try {
      const session = await this.ensureSession();
      const status = await session.render(
        request,
        Math.max(1_000, request.duration_ms + 1_500),
      );
      if (status.status === "arrived") {
        this.lastPoint = pointFromOverlayTarget(request);
      }
      return status;
    } catch (error) {
      return {
        provider: this.provider,
        status: "failed",
        error: errorMessage(error),
      };
    }
  }

  async close(): Promise<void> {
    await this.session?.close();
    this.session = undefined;
    if (this.tmpRoot) {
      await rm(this.tmpRoot, { recursive: true, force: true });
      this.tmpRoot = undefined;
    }
  }

  private async ensureSession(): Promise<ComputeOverlayDaemonSession> {
    if (this.session) return this.session;
    if (this.sessionFactory) {
      this.session = await this.sessionFactory();
      return this.session;
    }

    const scriptPath =
      this.scriptPath ??
      join(
        (this.tmpRoot = await mkdtemp(join(tmpdir(), "unicli-overlay-linux-"))),
        "overlay.py",
      );
    if (!this.scriptPath) {
      await writeFile(scriptPath, buildLinuxOverlayPythonScript(), "utf8");
    }
    this.session = new StdioComputeOverlayDaemonSession("python3", [
      scriptPath,
    ]);
    return this.session;
  }
}

export function buildLinuxOverlayPythonScript(): string {
  return String.raw`#!/usr/bin/env python3
import json
import math
import sys
import threading
import time

import cairo
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gdk, GLib, Gtk

request = None
response_id = None
response_kind = None
response_action_id = None
started_at = 0.0
trail = []
windows = []
cursor_visual_style = "mac-glass-pointer-v1"
cursor_skin = "mac-pointer"

def write_protocol(response_id, response_kind, data):
    payload = {"id": response_id, "kind": response_kind, "ok": True, "data": data}
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()

def sample_at(elapsed_ms):
    global request
    samples = request.get("samples") or []
    if not samples:
        return request["target"]
    previous = samples[0]
    for sample in samples[1:]:
        if float(sample.get("at_ms", 0)) >= elapsed_ms:
            span = max(1.0, float(sample.get("at_ms", 0)) - float(previous.get("at_ms", 0)))
            t = min(1.0, max(0.0, (elapsed_ms - float(previous.get("at_ms", 0))) / span))
            return {
                "at_ms": elapsed_ms,
                "x": float(previous.get("x", 0)) + ((float(sample.get("x", 0)) - float(previous.get("x", 0))) * t),
                "y": float(previous.get("y", 0)) + ((float(sample.get("y", 0)) - float(previous.get("y", 0))) * t),
            }
        previous = sample
    return request["target"]

class OverlayWindow(Gtk.Window):
    def __init__(self, monitor):
        super().__init__(type=Gtk.WindowType.POPUP)
        self.monitor = monitor
        geometry = monitor.get_geometry()
        scale = monitor.get_scale_factor()
        self.origin_x = geometry.x
        self.origin_y = geometry.y
        self.set_app_paintable(True)
        self.set_decorated(False)
        self.set_keep_above(True)
        self.set_skip_taskbar_hint(True)
        self.set_skip_pager_hint(True)
        self.set_accept_focus(False)
        self.set_focus_on_map(False)
        self.move(geometry.x, geometry.y)
        self.resize(geometry.width * scale, geometry.height * scale)
        self.connect("draw", self.on_draw)
        self.connect("realize", self.on_realize)

    def on_realize(self, _widget):
        gdkwindow = self.get_window()
        if gdkwindow is not None:
            gdkwindow.set_override_redirect(True)
            gdkwindow.input_shape_combine_region(cairo.Region(), 0, 0)

    def on_draw(self, _widget, cr):
        if request is None:
            return False
        elapsed = (time.monotonic() - started_at) * 1000.0
        duration_ms = max(120.0, float(request.get("duration_ms", 120)))
        press_progress = elapsed / duration_ms
        point = sample_at(elapsed)
        x = float(point.get("x", 0)) - self.origin_x
        y = float(point.get("y", 0)) - self.origin_y
        cr.set_antialias(cairo.ANTIALIAS_BEST)
        cr.set_source_rgba(0.76, 0.60, 0.32, 0.52)
        cr.set_line_width(2.0)
        cr.set_line_cap(cairo.LINE_CAP_ROUND)
        if len(trail) > 1:
            cr.move_to(float(trail[0]["x"]) - self.origin_x, float(trail[0]["y"]) - self.origin_y)
            for item in trail[1:]:
                cr.line_to(float(item["x"]) - self.origin_x, float(item["y"]) - self.origin_y)
            cr.stroke()
        hotspot = (x, y)
        pointerPath = [
            (x, y),
            (x, y + 45),
            (x + 13, y + 32),
            (x + 21, y + 55),
            (x + 31, y + 51),
            (x + 23, y + 29),
            (x + 43, y + 29),
        ]
        cr.move_to(pointerPath[0][0], pointerPath[0][1])
        for px, py in pointerPath[1:]:
            cr.line_to(px, py)
        cr.close_path()
        cr.set_source_rgba(0.98, 0.96, 0.90, 0.98)
        cr.fill_preserve()
        cr.set_source_rgba(0.09, 0.07, 0.05, 0.96)
        cr.set_line_width(2.25)
        cr.stroke()
        cr.set_source_rgba(1.0, 1.0, 1.0, 0.72)
        cr.set_line_width(1.0)
        cr.move_to(x + 6, y + 8)
        cr.line_to(x + 6, y + 34)
        cr.stroke()
        state = str(request.get("state") or "")
        affordance = request.get("affordance") or {}
        halo = str(affordance.get("halo") or "")
        click_ripple = bool(affordance.get("click_ripple"))
        is_pressure = (state == "press" or halo == "pressure-bloom" or click_ripple) and press_progress >= 0.78
        is_busy_orbit = state == "wait" or halo == "busy-orbit"
        if is_pressure or is_busy_orbit:
            cr.set_source_rgba(0.76, 0.60, 0.32, 0.78)
            cr.set_line_width(1.5)
            cr.set_dash([4.0, 5.0] if is_busy_orbit else [])
            cr.arc(hotspot[0], hotspot[1], 15, 0, math.pi * 2)
            cr.stroke()
            cr.set_dash([])
        return False

def tick():
    global request, response_id, response_kind, response_action_id, trail
    if request is None:
        return True
    elapsed = (time.monotonic() - started_at) * 1000.0
    duration = max(120.0, float(request.get("duration_ms", 120)))
    point = sample_at(elapsed)
    trail.append(point)
    del trail[:-10]
    for window in windows:
        window.queue_draw()
    if elapsed >= duration:
        write_protocol(response_id, response_kind, {
            "provider": "linux-gtk",
            "status": "arrived",
            "action_id": response_action_id,
            "acknowledged_at_ms": int(duration),
        })
        request = None
        response_id = None
        response_kind = None
        response_action_id = None
    return True

def dispatch(wire):
    global request, response_id, response_kind, response_action_id, started_at, trail
    wire_id = wire.get("id")
    wire_kind = wire.get("kind")
    if wire_kind == "ready":
        write_protocol(wire_id, wire_kind, {"provider": "linux-gtk", "status": "ready"})
        return False
    params = wire.get("params") or {}
    next_request = params.get("request")
    if wire_kind != "render" or not isinstance(next_request, dict):
        write_protocol(wire_id, wire_kind, {"provider": "linux-gtk", "status": "failed", "error": "invalid request"})
        return False
    request = next_request
    response_id = wire_id
    response_kind = wire_kind
    response_action_id = next_request.get("action_id")
    started_at = time.monotonic()
    trail = []
    return False

def read_stdin():
    for line in sys.stdin:
        try:
            parsed = json.loads(line)
            GLib.idle_add(dispatch, parsed)
        except Exception:
            write_protocol(0, "<parse>", {"provider": "linux-gtk", "status": "failed", "error": "invalid request"})
    GLib.idle_add(Gtk.main_quit)

display = Gdk.Display.get_default()
if display is None:
    sys.stderr.write("linux overlay has no display\n")
    sys.stderr.flush()
    sys.exit(1)
for index in range(display.get_n_monitors()):
    window = OverlayWindow(display.get_monitor(index))
    windows.append(window)
    window.show_all()

GLib.timeout_add(16, tick)
threading.Thread(target=read_stdin, daemon=True).start()
Gtk.main()
`;
}

function pointFromOverlayTarget(
  request: ComputeOverlayRequest,
): ComputeVisualCursorPoint {
  return {
    x: request.target.x,
    y: request.target.y,
    coordinate_space: {
      kind: "screen-pixels",
      origin: "top-left",
      ...(request.target.screenIndex !== undefined
        ? { screenIndex: request.target.screenIndex }
        : {}),
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
