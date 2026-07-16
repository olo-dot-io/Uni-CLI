/**
 * @owner   src/compute/action-execution.ts
 * @does    Bind and execute compute actions while producing one unified visual evidence record.
 * @needs   compute contracts, transport cascade, compute overlay provider, visual action evidence builders
 * @feeds   computer-use MCP profile, future CLI compute orchestration
 * @breaks  Divergent enrichment between overlay, dispatch, and evidence makes pointer replay untrustworthy; overwriting an authoritative mutation result with late cancellation can cause replay.
 * @invariants A single immutable ref generation feeds overlay planning, transport dispatch, post-capture, and returned evidence; dispatch settlement is authoritative and late cancellation only suppresses optional post-capture.
 * @side-effects Runs the selected transport and optional overlay provider.
 * @perf    One cascade execution plus optional overlay render per action.
 * @concurrency Ref binding happens before overlay awaits and is revalidated by the cascade before dispatch.
 * @test    tests/unit/compute-action-execution.test.ts
 * @stability experimental
 * @since   0.224.0
 */

import {
  buildComputeActionVisualEvidence,
  type ComputeActionVisualEvidence,
  type ComputeVisualAction,
  type ComputeVisualActionPostCapture,
  type ComputeVisualCursorPoint,
  type ComputeVisualOverlayStatus,
} from "./visual-timeline.js";
import {
  attachComputeOverlayStatus,
  NOOP_COMPUTE_OVERLAY_PROVIDER,
  type ComputeOverlayProvider,
} from "./overlay.js";
import {
  prepareComputeRequest,
  tryCascade,
  type PreparedComputeRequest,
} from "../transport/cascade.js";
import { computeCommandCanMutate } from "./contracts.js";
import type {
  ActionRequest,
  ActionResult,
  TransportBus,
  TransportContext,
} from "../transport/types.js";

export interface ComputeActionExecutionOptions {
  tool: string;
  platform?: NodeJS.Platform;
  transportContext?: TransportContext;
  overlayProvider?: ComputeOverlayProvider;
  postActionCapture?: boolean;
}

export interface ComputeActionExecution {
  result: ActionResult<unknown>;
  evidence: ComputeActionVisualEvidence;
}

export async function executeComputeAction(
  bus: TransportBus,
  req: ActionRequest,
  opts: ComputeActionExecutionOptions,
): Promise<ComputeActionExecution> {
  const signal = req.signal ?? opts.transportContext?.signal;
  signal?.throwIfAborted();
  const dispatchRequest = {
    ...req,
    ...(signal ? { signal } : {}),
  };
  const preparation = prepareComputeRequest(bus, dispatchRequest);
  const prepared =
    preparation.status === "ready" ? preparation.prepared : undefined;
  const evidenceRequest = prepared?.request ?? dispatchRequest;
  const evidenceParams = withProviderPointerStart(
    evidenceRequest.params,
    opts.overlayProvider?.currentPoint?.(),
  );
  const preDispatchEvidence = buildComputeActionVisualEvidence({
    tool: opts.tool,
    action: req.kind,
    params: evidenceParams,
    ok: true,
  });
  const overlay = prepared
    ? await renderOverlay(
        preDispatchEvidence.visual_action,
        opts.overlayProvider ?? NOOP_COMPUTE_OVERLAY_PROVIDER,
      )
    : {
        provider: opts.overlayProvider?.provider ?? ("none" as const),
        status: "not_requested" as const,
      };
  signal?.throwIfAborted();
  const result =
    preparation.status === "ready"
      ? await tryCascade(
          bus,
          preparation.prepared.request,
          opts.platform ?? process.platform,
          opts.transportContext,
          preparation.prepared,
        )
      : preparation.result;
  const postCapture =
    prepared && opts.postActionCapture === true && signal?.aborted !== true
      ? await capturePostAction(bus, prepared, opts)
      : undefined;
  const transport = readActionResultTransport(result);
  const evidence = buildComputeActionVisualEvidence({
    tool: opts.tool,
    action: req.kind,
    params: evidenceParams,
    ok: result.ok,
    ...(transport ? { transport } : {}),
  });

  return {
    result,
    evidence: {
      visual_timeline: evidence.visual_timeline,
      visual_action: {
        ...evidence.visual_action,
        overlay,
        ...(postCapture ? { post_capture: postCapture } : {}),
      },
    },
  };
}

async function capturePostAction(
  bus: TransportBus,
  prepared: PreparedComputeRequest,
  opts: ComputeActionExecutionOptions,
): Promise<ComputeVisualActionPostCapture> {
  const screenshotRequest: ActionRequest = {
    ...prepared.request,
    kind: "compute_screenshot",
    canMutate: computeCommandCanMutate("compute_screenshot"),
  };
  const screenshotPrepared: PreparedComputeRequest = {
    request: screenshotRequest,
    ...(prepared.refMatch ? { refMatch: prepared.refMatch } : {}),
  };
  const result = await tryCascade(
    bus,
    screenshotRequest,
    opts.platform ?? process.platform,
    opts.transportContext,
    screenshotPrepared,
  );
  const transport = readActionResultTransport(result);
  if (result.ok) {
    return {
      ok: true,
      ...(transport ? { transport } : {}),
      data: result.data,
    };
  }
  return {
    ok: false,
    transport: result.error.transport,
    error: {
      reason: result.error.reason,
      ...(result.error.minimum_capability
        ? { minimum_capability: result.error.minimum_capability }
        : {}),
      exit_code: result.error.exit_code,
    },
  };
}

function withProviderPointerStart(
  params: Record<string, unknown>,
  point: ComputeVisualCursorPoint | undefined,
): Record<string, unknown> {
  if (!point || isRecord(params.pointerStart)) return params;
  return {
    ...params,
    pointerStart: {
      x: point.x,
      y: point.y,
    },
  };
}

async function renderOverlay(
  action: ComputeVisualAction,
  provider: ComputeOverlayProvider,
): Promise<ComputeVisualOverlayStatus> {
  try {
    return (await attachComputeOverlayStatus(action, provider)).overlay;
  } catch (error) {
    return {
      provider: provider.provider,
      status: "failed",
      error: errorMessage(error),
    };
  }
}

function readActionResultTransport(
  result: ActionResult<unknown>,
): string | undefined {
  const data = result.ok ? result.data : result.error;
  if (!isRecord(data) || typeof data.transport !== "string") return undefined;
  return data.transport;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
