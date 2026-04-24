import { err, exitCodeFor, ok } from "../../core/envelope.js";
import type { Envelope } from "../../core/envelope.js";
import {
  buildAxBackgroundClickScript,
  readPositiveInt,
  resolveAxTarget,
} from "./desktop-ax-swift.js";
import type { AxShell } from "./desktop-ax.js";

interface BackgroundClickResult {
  found: boolean;
  posted?: boolean;
  reason?: string;
}

export async function runAxBackgroundClick<T>(
  shell: AxShell,
  params: Record<string, unknown>,
): Promise<Envelope<T>> {
  const target = resolveAxTarget(params);
  if (!target) {
    return err({
      transport: "desktop-ax",
      step: 0,
      action: "ax_background_click",
      reason: "missing target app (`app`, `bundleId`, or `processName`)",
      suggestion:
        "pass params.app, or supply params.bundleId / params.processName for localized Electron apps",
      exit_code: exitCodeFor("usage_error"),
    });
  }

  const x = typeof params.x === "number" ? params.x : undefined;
  const y = typeof params.y === "number" ? params.y : undefined;
  if (x === undefined || y === undefined) {
    return err({
      transport: "desktop-ax",
      step: 0,
      action: "ax_background_click",
      reason: `missing required param \`${x === undefined ? "x" : "y"}\``,
      suggestion: "pass window-local x/y coordinates to ax_background_click",
      exit_code: exitCodeFor("usage_error"),
    });
  }

  try {
    const { stdout } = await shell.run(
      "swift",
      [
        "-e",
        buildAxBackgroundClickScript(target, {
          x,
          y,
          coordinateSpace:
            params.coordinateSpace === "screen" ? "screen" : "window",
          button: readPositiveInt(params.button, 0),
          clickCount: readPositiveInt(params.clickCount, 1) || 1,
          windowNumber:
            typeof params.windowNumber === "number"
              ? readPositiveInt(params.windowNumber, 0)
              : undefined,
        }),
      ],
      { timeoutMs: 10_000 },
    );
    const result = JSON.parse(stdout.trim()) as BackgroundClickResult;
    if (!result.found || result.posted === false) {
      return err({
        transport: "desktop-ax",
        step: 0,
        action: "ax_background_click",
        reason: `background click failed in ${target.appName}: ${result.reason ?? "target app/window not found"}`,
        suggestion:
          "verify the target window is on screen and grant Input Monitoring / Accessibility to the host terminal",
        exit_code: exitCodeFor("service_unavailable"),
      });
    }
    return ok(result as unknown as T);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const timeout = /timeout|timed out|ETIMEDOUT/i.test(msg);
    return err({
      transport: "desktop-ax",
      step: 0,
      action: "ax_background_click",
      reason: msg,
      suggestion:
        "check app name, Input Monitoring / Accessibility permissions, and that the app is installed",
      retryable: timeout,
      exit_code: timeout
        ? exitCodeFor("temp_failure")
        : exitCodeFor("service_unavailable"),
    });
  }
}
