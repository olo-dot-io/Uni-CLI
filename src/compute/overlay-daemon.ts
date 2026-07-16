/**
 * @owner       src::compute::overlay-daemon
 * @does        Adapt native overlay requests to the shared bounded sidecar protocol with a readiness handshake for every process generation.
 * @needs       src/transport/sidecar and visual overlay contracts
 * @feeds       macOS AppKit, Windows Win32, and Linux GTK overlay providers
 * @breaks      Caching readiness across process generations starts render deadlines during cold startup; accepting an uncorrelated status can attribute an old animation to a new action.
 * @invariants  Each generation proves ready before its first render; response id/kind and action_id match exactly; timeout/failure/close inherit whole-tree containment from StdioSidecarClient.
 * @side-effects Starts and terminates native overlay helpers through the shared sidecar owner.
 * @perf        Healthy renders reuse one ready process; cold-start readiness is excluded from render deadlines.
 * @concurrency The sidecar serializes renders and gates replacement generations on containment.
 * @test        tests/unit/compute-macos-overlay-swift.test.ts, tests/unit/compute-linux-overlay.test.ts, tests/unit/compute-windows-overlay.test.ts
 * @stability   experimental
 * @since       0.224.0
 */

import {
  StdioSidecarClient,
  type SidecarInitialization,
} from "../transport/sidecar.js";
import type { ComputeOverlayRequest } from "./overlay.js";
import type { ComputeVisualOverlayStatus } from "./visual-timeline.js";

export interface ComputeOverlayDaemonSession {
  render(
    request: ComputeOverlayRequest,
    timeoutMs: number,
  ): Promise<ComputeVisualOverlayStatus>;
  close(): Promise<void>;
}

export class StdioComputeOverlayDaemonSession implements ComputeOverlayDaemonSession {
  private readonly sidecar: StdioSidecarClient;

  constructor(
    command: string,
    args: readonly string[],
    opts: { readyTimeoutMs?: number } = {},
  ) {
    const initialization: SidecarInitialization = {
      kind: "ready",
      timeoutMs: opts.readyTimeoutMs ?? 8_000,
      validate: validateOverlayReadiness,
    };
    this.sidecar = new StdioSidecarClient(command, args, {
      initialize: initialization,
    });
  }

  async render(
    request: ComputeOverlayRequest,
    timeoutMs: number,
  ): Promise<ComputeVisualOverlayStatus> {
    const value = await this.sidecar.call(
      "render",
      { request },
      {
        timeoutMs,
        validate: (data) => parseOverlayStatus(data, request.action_id),
      },
    );
    return parseOverlayStatus(value, request.action_id);
  }

  async close(): Promise<void> {
    await this.sidecar.close();
  }
}

function validateOverlayReadiness(value: unknown): void {
  if (
    !isRecord(value) ||
    !isOverlayProvider(value.provider) ||
    value.status !== "ready"
  ) {
    throw new Error("overlay sidecar returned invalid readiness data");
  }
}

function parseOverlayStatus(
  value: unknown,
  actionId: string,
): ComputeVisualOverlayStatus {
  if (
    !isRecord(value) ||
    !isOverlayProvider(value.provider) ||
    value.action_id !== actionId ||
    !isOverlayStatus(value.status) ||
    (value.acknowledged_at_ms !== undefined &&
      typeof value.acknowledged_at_ms !== "number") ||
    (value.error !== undefined && typeof value.error !== "string")
  ) {
    throw new Error("overlay sidecar returned invalid render data");
  }
  return {
    provider: value.provider,
    status: value.status,
    ...(typeof value.acknowledged_at_ms === "number"
      ? { acknowledged_at_ms: value.acknowledged_at_ms }
      : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  };
}

function isOverlayProvider(
  value: unknown,
): value is "macos-appkit" | "windows-win32" | "linux-gtk" {
  return (
    value === "macos-appkit" ||
    value === "windows-win32" ||
    value === "linux-gtk"
  );
}

function isOverlayStatus(
  value: unknown,
): value is ComputeVisualOverlayStatus["status"] {
  return (
    value === "not_requested" ||
    value === "unavailable" ||
    value === "scheduled" ||
    value === "arrived" ||
    value === "timeout" ||
    value === "failed"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
