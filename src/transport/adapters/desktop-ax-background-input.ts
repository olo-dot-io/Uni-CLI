/**
 * @owner   src/transport/adapters/desktop-ax-background-input.ts
 * @does    Validate and execute macOS desktop-ax background input actions through generated Swift.
 * @needs   desktop-ax shell abstraction, target resolution, background input Swift generator
 * @feeds   DesktopAxTransport background click/type/press actions
 * @breaks  Bad validation can route unscoped input to the wrong app; dropped post-dispatch ambiguity permits duplicate background input.
 * @invariants Every native input process receives the owning request signal and reports cancellation after dispatch as outcome-ambiguous.
 * @side-effects Posts background mouse and keyboard input to a declared macOS target.
 * @perf    One Swift child per action.
 * @concurrency Request signals are passed explicitly and never stored globally.
 * @test    tests/unit/transport/adapters/desktop-ax.test.ts
 * @stability stable
 * @since   2026-07-15
 */

import { err, exitCodeFor, ok } from "../../core/envelope.js";
import type { Envelope } from "../../core/envelope.js";
import { isOperationOutcomeAmbiguousError } from "../contained-process.js";
import type { AxShell } from "./desktop-ax.js";
import { buildAxBackgroundInputScript } from "./desktop-ax-background-input-swift.js";
import type { AxBackgroundInputAction } from "./desktop-ax-background-input-swift.js";
import { readPositiveInt, resolveAxTarget } from "./desktop-ax-swift.js";

interface BackgroundInputResult {
  found: boolean;
  posted?: boolean;
  action?: string;
  reason?: string;
}

interface BackgroundInputRunOptions {
  action: AxBackgroundInputAction;
  sourceAction: string;
  textParam?: "text" | "value";
  keyParam?: "key" | "combo";
  requirePoint?: boolean;
}

export async function runAxBackgroundClick<T>(
  shell: AxShell,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Envelope<T>> {
  return runAxBackgroundInput<T>(
    shell,
    params,
    {
      action: "click",
      sourceAction: "ax_background_click",
      requirePoint: true,
    },
    signal,
  );
}

export async function runAxBackgroundType<T>(
  shell: AxShell,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Envelope<T>> {
  return runAxBackgroundInput<T>(
    shell,
    params,
    {
      action: "type_text",
      sourceAction: "ax_background_type",
      textParam: typeof params.value === "string" ? "value" : "text",
    },
    signal,
  );
}

export async function runAxBackgroundPress<T>(
  shell: AxShell,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Envelope<T>> {
  return runAxBackgroundInput<T>(
    shell,
    params,
    {
      action: "press_key",
      sourceAction: "ax_background_press",
      keyParam: typeof params.key === "string" ? "key" : "combo",
    },
    signal,
  );
}

async function runAxBackgroundInput<T>(
  shell: AxShell,
  params: Record<string, unknown>,
  opts: BackgroundInputRunOptions,
  signal?: AbortSignal,
): Promise<Envelope<T>> {
  signal?.throwIfAborted();
  const target = resolveAxTarget(params);
  if (!target) {
    return err({
      transport: "desktop-ax",
      step: 0,
      action: opts.sourceAction,
      reason: "missing target app (`app`, `bundleId`, or `processName`)",
      suggestion:
        "pass params.app, or supply params.bundleId / params.processName for localized Electron apps",
      exit_code: exitCodeFor("usage_error"),
    });
  }

  const x = typeof params.x === "number" ? params.x : undefined;
  const y = typeof params.y === "number" ? params.y : undefined;
  if (opts.requirePoint && (x === undefined || y === undefined)) {
    return err({
      transport: "desktop-ax",
      step: 0,
      action: opts.sourceAction,
      reason: `missing required param \`${x === undefined ? "x" : "y"}\``,
      suggestion: `pass screen or window-local x/y coordinates to ${opts.sourceAction}`,
      exit_code: exitCodeFor("usage_error"),
    });
  }

  const text = opts.textParam ? readString(params[opts.textParam]) : undefined;
  if (opts.textParam && text === undefined) {
    return missingInputParam(opts.sourceAction, opts.textParam);
  }

  const key = opts.keyParam ? readString(params[opts.keyParam]) : undefined;
  if (opts.keyParam && key === undefined) {
    return missingInputParam(opts.sourceAction, opts.keyParam);
  }

  try {
    const { stdout } = await shell.run(
      "swift",
      [
        "-e",
        buildAxBackgroundInputScript(target, {
          action: opts.action,
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
          text,
          key,
          clickBeforeText: params.clickBeforeText !== false,
        }),
      ],
      {
        timeoutMs: 10_000,
        signal,
        cancellationDelivery: "outcome-ambiguous",
      },
    );
    const result = JSON.parse(stdout.trim()) as BackgroundInputResult;
    if (!result.found || result.posted === false) {
      return err({
        transport: "desktop-ax",
        step: 0,
        action: opts.sourceAction,
        reason: `background input failed in ${target.appName}: ${result.reason ?? "target app/window not found"}`,
        suggestion:
          "verify the target window is on screen and grant Input Monitoring / Accessibility to the host terminal",
        exit_code: exitCodeFor("service_unavailable"),
      });
    }
    return ok(result as unknown as T);
  } catch (e) {
    if (isOperationOutcomeAmbiguousError(e)) throw e;
    signal?.throwIfAborted();
    const msg = e instanceof Error ? e.message : String(e);
    const timeout = /timeout|timed out|ETIMEDOUT/i.test(msg);
    return err({
      transport: "desktop-ax",
      step: 0,
      action: opts.sourceAction,
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

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function missingInputParam<T>(action: string, paramName: string): Envelope<T> {
  return err({
    transport: "desktop-ax",
    step: 0,
    action,
    reason: `missing required param \`${paramName}\``,
    suggestion: `pass params.${paramName} to ${action}`,
    exit_code: exitCodeFor("usage_error"),
  });
}
