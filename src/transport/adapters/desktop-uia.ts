/**
 * @owner       src::transport::adapters::desktop-uia
 * @does        Route Windows UI Automation snapshots and actions through one process-contained native sidecar.
 * @needs       sidecar lifecycle, UIA binary resolution, desktop snapshot normalization
 * @feeds       selected compute dispatch and direct desktop-uia transport callers
 * @breaks      Omitting mutation delivery metadata can turn post-frame sidecar cancellation into a replayable ordinary failure; encoding snapshot failures as data or broadening malformed targets makes a failed observation look successful.
 * @invariants  Compute contract mutability and typed app/pid/window target params reach the same sidecar call as their encoding; explicit targets resolve exactly or fail closed; post-frame mutation cancellation remains outcome-ambiguous; snapshot failures preserve the selected provider; action failures become structured envelopes; close is idempotent.
 * @side-effects Starts and terminates the UIA sidecar and can mutate the Windows desktop.
 * @perf        One serialized sidecar round trip per action or snapshot.
 * @concurrency The sidecar owns FIFO serialization and process containment for each active request.
 * @test        tests/unit/transport/adapters/desktop-uia.test.ts and tests/unit/transport/sidecar.test.ts
 * @stability   stable
 * @since       2026-07-15
 */

import { err, exitCodeFor } from "../../core/envelope.js";
import { ok } from "../../core/envelope.js";
import {
  attachDefaultEffectVerdict,
  readEffectVerdict,
} from "../../core/effect-verdict.js";
import { resolveSidecarBinary } from "../sidecar-binary.js";
import {
  isSidecarError,
  SIDECAR_CANCELLATION_PROTOCOL,
  StdioSidecarClient,
} from "../sidecar.js";
import type { SidecarClient } from "../sidecar.js";
import { normalizeDesktopSidecarError } from "./desktop-sidecar-errors.js";
import {
  normalizeSidecarScreenshot,
  prepareSidecarScreenshotRequest,
} from "./desktop-sidecar-screenshot.js";
import { isOperationOutcomeAmbiguousError } from "../contained-process.js";
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
  SnapshotRequest,
  TransportAdapter,
  TransportContext,
  TransportKind,
} from "../types.js";

const UIA_STEPS = [
  "uia_apps",
  "uia_windows",
  "uia_snapshot",
  "uia_find",
  "uia_invoke",
  "uia_set_value",
  "uia_focus",
  "uia_press",
  "uia_scroll",
  "uia_screenshot",
  "uia_wait",
  "uia_observe",
  "uia_assert",
  "launch_app",
] as const;

const UIA_CAPABILITY: Capability = {
  steps: UIA_STEPS,
  snapshotFormats: ["os-ax"] as readonly SnapshotFormat[],
  platforms: ["win32"] as const,
  mutatesHost: true,
};

export interface DesktopUiaTransportOptions {
  platform?: NodeJS.Platform;
  sidecar?: SidecarClient;
  sidecarCommand?: string;
}

const WINDOWS_ONLY_SUGGESTION =
  "run on Windows with the native UIA backend available, or explicitly replan the operation";

export class DesktopUiaTransport implements TransportAdapter {
  readonly kind: TransportKind = "desktop-uia";
  readonly capability: Capability = UIA_CAPABILITY;

  private readonly platform: NodeJS.Platform;
  private readonly sidecarCommand: string;
  private readonly injectedSidecar: boolean;
  private sidecar: SidecarClient | undefined;
  private refs: TransportContext["refs"] | undefined;
  private closed = false;

  constructor(opts: DesktopUiaTransportOptions = {}) {
    this.platform = opts.platform ?? process.platform;
    this.sidecar = opts.sidecar;
    this.injectedSidecar = opts.sidecar !== undefined;
    this.sidecarCommand =
      opts.sidecarCommand ??
      resolveSidecarBinary("unicli-uia", {
        platform: this.platform,
        env: process.env,
      }).command;
  }

  async open(ctx: TransportContext): Promise<void> {
    this.refs = ctx.refs ?? ctx.bus.refs;
    if (this.platform !== "win32" || this.sidecar) return;
    this.sidecar = new StdioSidecarClient(this.sidecarCommand, [], {
      env: process.env,
    });
  }

  async snapshot(opts?: SnapshotRequest): Promise<Snapshot> {
    opts?.signal?.throwIfAborted();
    if (this.platform !== "win32") return this.unavailableSnapshot();
    const format = opts?.format as SidecarSnapshotFormat | undefined;
    const params = {
      ...opts?.params,
      ...(format ? { format } : {}),
    };
    const data = await this.requireSidecar().call("uia_snapshot", params, {
      signal: opts?.signal,
    });
    opts?.signal?.throwIfAborted();
    return snapshotFromSidecarRaw(data, {
      format,
      transport: this.kind,
      refs: this.refs,
    });
  }

  async action<T = unknown>(req: ActionRequest): Promise<ActionResult<T>> {
    req.signal?.throwIfAborted();
    const canMutate = desktopUiaActionCanMutate(req);
    if (this.platform !== "win32") {
      return attachDefaultEffectVerdict(this.unavailable(req.kind), {
        canMutate,
        phase: "pre_dispatch",
        verification: "accessibility-state",
      });
    }
    try {
      const screenshot =
        req.kind === "uia_screenshot"
          ? prepareSidecarScreenshotRequest(req.params)
          : undefined;
      const data = await this.requireSidecar().call<unknown>(
        req.kind,
        screenshot?.params ?? req.params,
        {
          signal: req.signal,
          cancellationDelivery: canMutate ? "outcome-ambiguous" : "contained",
        },
      );
      const normalized = screenshot
        ? await normalizeSidecarScreenshot(data, screenshot.path, req.signal)
        : data;
      const providerVerdict =
        normalized &&
        typeof normalized === "object" &&
        !Array.isArray(normalized) &&
        "effect_verdict" in normalized
          ? readEffectVerdict(
              (normalized as { effect_verdict?: unknown }).effect_verdict,
            )
          : undefined;
      return attachDefaultEffectVerdict(
        ok(
          normalized as T,
          providerVerdict ? { effect_verdict: providerVerdict } : undefined,
        ),
        { canMutate, verification: "accessibility-state" },
      );
    } catch (error) {
      if (isOperationOutcomeAmbiguousError(error)) throw error;
      req.signal?.throwIfAborted();
      return attachDefaultEffectVerdict(
        this.errorFromSidecar<T>(req.kind, error),
        {
          canMutate,
          phase: "dispatched_failure",
          verification: "accessibility-state",
        },
      );
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.sidecar?.close();
  }

  async recover(): Promise<void> {
    if (this.injectedSidecar) return;
    const failedGeneration = this.sidecar;
    this.sidecar = undefined;
    await failedGeneration?.close();
  }

  private requireSidecar(): SidecarClient {
    if (!this.sidecar) {
      this.sidecar = new StdioSidecarClient(this.sidecarCommand, [], {
        env: process.env,
      });
    }
    if (this.sidecar.cancellation !== SIDECAR_CANCELLATION_PROTOCOL) {
      throw new Error(
        `desktop-uia sidecar must implement ${SIDECAR_CANCELLATION_PROTOCOL} cancellation`,
      );
    }
    return this.sidecar;
  }

  private unavailableSnapshot(): Snapshot {
    return {
      format: "json",
      data: JSON.stringify({
        transport: "desktop-uia",
        ok: false,
        reason: `desktop-uia is only available on Windows; current platform is ${this.platform}`,
      }),
    };
  }

  private unavailable<T>(action: string): ActionResult<T> {
    return err({
      transport: "desktop-uia",
      step: 0,
      action,
      reason: `desktop-uia is only available on Windows; current platform is ${this.platform}`,
      suggestion: WINDOWS_ONLY_SUGGESTION,
      minimum_capability: `desktop-uia.${action}`,
      exit_code: exitCodeFor("service_unavailable"),
    });
  }

  private errorFromSidecar<T>(action: string, error: unknown): ActionResult<T> {
    if (isSidecarError(error)) {
      const normalized = normalizeDesktopSidecarError("desktop-uia", error);
      return err({
        transport: "desktop-uia",
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
        transport: "desktop-uia",
        step: 0,
        action,
        reason: message,
        suggestion:
          "retry the action; if the sidecar keeps crashing, run UNICLI_TRACE=1 unicli doctor compute",
        minimum_capability: "desktop-uia.sidecar_crashed",
        retryable: true,
        exit_code: exitCodeFor("temp_failure"),
      });
    }

    return err({
      transport: "desktop-uia",
      step: 0,
      action,
      reason: message,
      suggestion: "inspect the unicli-uia sidecar process and retry",
      minimum_capability: `desktop-uia.${action}`,
      exit_code: exitCodeFor("service_unavailable"),
    });
  }
}

function isSidecarProcessCrash(message: string): boolean {
  return /sidecar (?:exited|closed)|EPIPE|ECONNRESET/i.test(message);
}

const UIA_READ_ONLY_ACTIONS = new Set<string>([
  "uia_apps",
  "uia_windows",
  "uia_snapshot",
  "uia_find",
  "uia_screenshot",
  "uia_wait",
  "uia_observe",
  "uia_assert",
]);

function desktopUiaActionCanMutate(req: ActionRequest): boolean {
  return !UIA_READ_ONLY_ACTIONS.has(req.kind) || req.canMutate === true;
}
