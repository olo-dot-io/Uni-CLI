/**
 * DesktopAtspiTransport — Linux AT-SPI transport.
 */

import { err, exitCodeFor } from "../../core/envelope.js";
import { ok } from "../../core/envelope.js";
import { resolveSidecarBinary } from "../sidecar-binary.js";
import { isSidecarError, StdioSidecarClient } from "../sidecar.js";
import type { SidecarClient } from "../sidecar.js";
import { normalizeDesktopSidecarError } from "./desktop-sidecar-errors.js";
import {
  snapshotFromSidecarRaw,
  type SidecarSnapshotFormat,
} from "./desktop-sidecar-snapshot.js";
import type {
  ActionRequest,
  ActionResult,
  Capability,
  Snapshot,
  SnapshotFormat,
  TransportAdapter,
  TransportContext,
  TransportKind,
} from "../types.js";

const ATSPI_STEPS = [
  "atspi_apps",
  "atspi_windows",
  "atspi_snapshot",
  "atspi_find",
  "atspi_invoke",
  "atspi_set_value",
  "atspi_focus",
  "atspi_press",
  "atspi_scroll",
  "atspi_screenshot",
  "atspi_wait",
  "atspi_observe",
  "atspi_assert",
  "launch_app",
] as const;

const ATSPI_CAPABILITY: Capability = {
  steps: ATSPI_STEPS,
  snapshotFormats: ["os-ax"] as readonly SnapshotFormat[],
  platforms: ["linux"] as const,
  mutatesHost: true,
};

export interface DesktopAtspiTransportOptions {
  platform?: NodeJS.Platform;
  sidecar?: SidecarClient;
  sidecarCommand?: string;
}

const LINUX_ONLY_SUGGESTION =
  "run on Linux with the native AT-SPI backend available, or fall back to CUA";

export class DesktopAtspiTransport implements TransportAdapter {
  readonly kind: TransportKind = "desktop-atspi";
  readonly capability: Capability = ATSPI_CAPABILITY;

  private readonly platform: NodeJS.Platform;
  private readonly sidecarCommand: string;
  private sidecar: SidecarClient | undefined;
  private refs: TransportContext["refs"] | undefined;
  private closed = false;

  constructor(opts: DesktopAtspiTransportOptions = {}) {
    this.platform = opts.platform ?? process.platform;
    this.sidecar = opts.sidecar;
    this.sidecarCommand =
      opts.sidecarCommand ??
      resolveSidecarBinary("unicli-atspi", {
        platform: this.platform,
        env: process.env,
      }).command;
  }

  async open(ctx: TransportContext): Promise<void> {
    this.refs = ctx.refs ?? ctx.bus.refs;
    if (this.platform !== "linux" || this.sidecar) return;
    this.sidecar = new StdioSidecarClient(this.sidecarCommand, [], {
      env: process.env,
    });
  }

  async snapshot(opts?: { format?: SidecarSnapshotFormat }): Promise<Snapshot> {
    if (this.platform !== "linux") return this.unavailableSnapshot();
    try {
      const params = opts?.format ? { format: opts.format } : {};
      const data = await this.requireSidecar().call("atspi_snapshot", params);
      return snapshotFromSidecarRaw(data, {
        format: opts?.format,
        transport: this.kind,
        refs: this.refs,
      });
    } catch (error) {
      return {
        format: "json",
        data: JSON.stringify(this.snapshotError(error)),
      };
    }
  }

  async action<T = unknown>(req: ActionRequest): Promise<ActionResult<T>> {
    if (this.platform !== "linux") return this.unavailable(req.kind);
    try {
      const data = await this.requireSidecar().call<T>(req.kind, req.params);
      return ok(data);
    } catch (error) {
      return this.errorFromSidecar<T>(req.kind, error);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.sidecar?.close();
  }

  private requireSidecar(): SidecarClient {
    if (!this.sidecar) {
      this.sidecar = new StdioSidecarClient(this.sidecarCommand, [], {
        env: process.env,
      });
    }
    return this.sidecar;
  }

  private unavailableSnapshot(): Snapshot {
    return {
      format: "json",
      data: JSON.stringify({
        transport: "desktop-atspi",
        ok: false,
        reason: `desktop-atspi is only available on Linux; current platform is ${this.platform}`,
      }),
    };
  }

  private unavailable<T>(action: string): ActionResult<T> {
    return err({
      transport: "desktop-atspi",
      step: 0,
      action,
      reason: `desktop-atspi is only available on Linux; current platform is ${this.platform}`,
      suggestion: LINUX_ONLY_SUGGESTION,
      minimum_capability: `desktop-atspi.${action}`,
      exit_code: exitCodeFor("service_unavailable"),
    });
  }

  private errorFromSidecar<T>(action: string, error: unknown): ActionResult<T> {
    if (isSidecarError(error)) {
      const normalized = normalizeDesktopSidecarError("desktop-atspi", error);
      return err({
        transport: "desktop-atspi",
        step: 0,
        action: normalized.action || action,
        reason: normalized.reason,
        suggestion: normalized.suggestion,
        minimum_capability: normalized.minimum_capability,
        exit_code: normalized.exit_code,
      });
    }

    const message = error instanceof Error ? error.message : String(error);
    if (isSidecarProcessCrash(message)) {
      return err({
        transport: "desktop-atspi",
        step: 0,
        action,
        reason: message,
        suggestion:
          "retry the action; if the sidecar keeps crashing, run UNICLI_TRACE=1 unicli doctor compute",
        minimum_capability: "desktop-atspi.sidecar_crashed",
        retryable: true,
        exit_code: exitCodeFor("temp_failure"),
      });
    }

    return err({
      transport: "desktop-atspi",
      step: 0,
      action,
      reason: message,
      suggestion: "inspect the unicli-atspi sidecar process and retry",
      minimum_capability: `desktop-atspi.${action}`,
      exit_code: exitCodeFor("service_unavailable"),
    });
  }

  private snapshotError(error: unknown): Record<string, unknown> {
    if (isSidecarError(error)) {
      return { ok: false, error };
    }
    return {
      ok: false,
      error: {
        transport: "desktop-atspi",
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function isSidecarProcessCrash(message: string): boolean {
  return /sidecar (?:exited|closed)|EPIPE|ECONNRESET/i.test(message);
}
