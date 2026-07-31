/**
 * @owner   src/compute/action-execution.ts
 * @does    Bind and execute compute actions while producing one unified visual evidence record and an optional same-provider post-action frame.
 * @needs   compute contracts, route planning/dispatch, compute overlay provider, visual action evidence builders
 * @feeds   computer-use MCP profile, future CLI compute orchestration
 * @breaks  Divergent enrichment between overlay, dispatch, and evidence makes pointer replay untrustworthy; overwriting an authoritative mutation result with late cancellation can cause replay.
 * @invariants A single immutable ref generation feeds overlay planning, transport dispatch, post-capture, and returned evidence; post-capture never changes provider; image bytes are returned out-of-band from structured evidence; dispatch settlement is authoritative and late cancellation only suppresses optional post-capture.
 * @side-effects Runs the selected transport and optional overlay provider.
 * @perf    One selected-provider execution plus optional overlay render and at most one same-provider post-action capture.
 * @concurrency Ref binding happens before overlay awaits and is revalidated before selected-provider dispatch.
 * @test    tests/unit/compute-action-execution.test.ts
 * @stability experimental
 * @since   0.224.0
 */

import { createHash } from "node:crypto";

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
  dispatchComputeRouteDetailed,
  type PreparedComputeRequest,
} from "../transport/compute-dispatch.js";
import type { ComputeRouteSelection } from "../transport/routing.js";
import { computeCommandCanMutate } from "./contracts.js";
import type { VisualObservationEvidence } from "./visual-observation.js";
import { exitCodeFor } from "../core/envelope.js";
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
  /** `coordinate` captures only after a successful visual-coordinate route. */
  postActionCapture?: boolean | "coordinate";
}

export interface ComputeActionImageContent {
  data: string;
  mimeType: string;
}

export interface ComputeActionExecution {
  result: ActionResult<unknown>;
  evidence: ComputeActionVisualEvidence;
  route?: ComputeRouteSelection;
  postActionImage?: ComputeActionImageContent;
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
  const dispatch =
    preparation.status === "ready"
      ? await dispatchComputeRouteDetailed(
          bus,
          preparation.prepared.request,
          opts.platform ?? process.platform,
          opts.transportContext,
          preparation.prepared,
        )
      : { result: preparation.result };
  const result = dispatch.result;
  const postCapture =
    prepared &&
    shouldCapturePostAction(result, dispatch.route, opts) &&
    signal?.aborted !== true
      ? await capturePostAction(
          bus,
          prepared,
          dispatch.route,
          dispatch.observation,
          opts,
        )
      : undefined;
  const transport =
    dispatch.route?.transport ?? readActionResultTransport(result);
  const evidence = buildComputeActionVisualEvidence({
    tool: opts.tool,
    action: req.kind,
    params: evidenceParams,
    ok: result.ok,
    ...(result.effect_verdict ? { effect_verdict: result.effect_verdict } : {}),
    ...(result.recovery_trace ? { recovery_trace: result.recovery_trace } : {}),
    ...(transport ? { transport } : {}),
    ...(dispatch.route
      ? {
          route: {
            name: dispatch.route.route,
            operator: dispatch.route.operator,
            physical_action: dispatch.route.physical_action,
            reason: dispatch.route.reason,
            explicit: dispatch.route.explicit,
            ...(dispatch.route.evidence_transport
              ? {
                  evidence_transport: dispatch.route.evidence_transport,
                }
              : {}),
            recovery: dispatch.route.recovery,
          },
        }
      : {}),
  });

  return {
    result,
    ...(dispatch.route ? { route: dispatch.route } : {}),
    ...(postCapture?.image ? { postActionImage: postCapture.image } : {}),
    evidence: {
      visual_timeline: evidence.visual_timeline,
      visual_action: {
        ...evidence.visual_action,
        overlay,
        ...(postCapture ? { post_capture: postCapture.evidence } : {}),
      },
    },
  };
}

function shouldCapturePostAction(
  result: ActionResult<unknown>,
  route: ComputeRouteSelection | undefined,
  opts: ComputeActionExecutionOptions,
): boolean {
  if (opts.postActionCapture === true) return true;
  return (
    opts.postActionCapture === "coordinate" &&
    result.ok &&
    route?.operator === "visual-coordinate"
  );
}

interface CapturedPostAction {
  evidence: ComputeVisualActionPostCapture;
  image?: ComputeActionImageContent;
}

async function capturePostAction(
  bus: TransportBus,
  prepared: PreparedComputeRequest,
  expectedRoute: ComputeRouteSelection | undefined,
  before: VisualObservationEvidence | undefined,
  opts: ComputeActionExecutionOptions,
): Promise<CapturedPostAction> {
  const screenshotRequest: ActionRequest = {
    ...prepared.request,
    kind: "compute_screenshot",
    canMutate: computeCommandCanMutate("compute_screenshot"),
  };
  const screenshotPrepared: PreparedComputeRequest = {
    request: screenshotRequest,
    ...(prepared.refMatch ? { refMatch: prepared.refMatch } : {}),
  };
  let capture: Awaited<ReturnType<typeof dispatchComputeRouteDetailed>>;
  try {
    capture = await dispatchComputeRouteDetailed(
      bus,
      screenshotRequest,
      opts.platform ?? process.platform,
      opts.transportContext,
      screenshotPrepared,
    );
  } catch (error) {
    return {
      evidence: {
        ok: false,
        ...(expectedRoute ? { transport: expectedRoute.transport } : {}),
        error: {
          reason: `post-action capture did not settle after the action result became authoritative: ${errorMessage(error)}`,
          minimum_capability: "compute.post_action_capture",
          exit_code: exitCodeFor("service_unavailable"),
        },
      },
    };
  }
  const result = capture.result;
  const transport = readActionResultTransport(result);
  if (
    expectedRoute &&
    capture.route &&
    capture.route.transport !== expectedRoute.transport
  ) {
    return {
      evidence: {
        ok: false,
        transport: capture.route.transport,
        error: {
          reason: `post-action capture selected ${capture.route.transport} after ${expectedRoute.transport} performed the action`,
          minimum_capability:
            "compute.post_action_capture.provider_consistency",
          exit_code: exitCodeFor("service_unavailable"),
        },
      },
    };
  }
  if (result.ok) {
    const summarized = summarizePostActionImage(result.data, before);
    return {
      evidence: {
        ok: true,
        ...(transport ? { transport } : {}),
        data: summarized.data,
        ...(summarized.imageSummary ? { image: summarized.imageSummary } : {}),
        ...(summarized.change
          ? { encoded_frame_change: summarized.change }
          : {}),
      },
      ...(summarized.image ? { image: summarized.image } : {}),
    };
  }
  return {
    evidence: {
      ok: false,
      transport: result.error.transport,
      error: {
        reason: result.error.reason,
        ...(result.error.minimum_capability
          ? { minimum_capability: result.error.minimum_capability }
          : {}),
        exit_code: result.error.exit_code,
      },
    },
  };
}

function summarizePostActionImage(
  data: unknown,
  before: VisualObservationEvidence | undefined,
): {
  data: unknown;
  image?: ComputeActionImageContent;
  imageSummary?: NonNullable<ComputeVisualActionPostCapture["image"]>;
  change?: NonNullable<ComputeVisualActionPostCapture["encoded_frame_change"]>;
} {
  const payload = readImageBytes(data);
  const sanitized = withoutImageBytes(data);
  if (!payload) return { data: sanitized };
  const sha256 = createHash("sha256").update(payload.bytes).digest("hex");
  const dimensions = readImageDimensions(data);
  const imageSummary = {
    mime_type: payload.mimeType,
    bytes: payload.bytes.length,
    sha256,
    ...(dimensions.width ? { width: dimensions.width } : {}),
    ...(dimensions.height ? { height: dimensions.height } : {}),
  };
  const afterSha = readObservationSha(data) ?? sha256;
  return {
    data: sanitized,
    image: {
      data: payload.bytes.toString("base64"),
      mimeType: payload.mimeType,
    },
    imageSummary,
    ...(before
      ? {
          change: {
            status: before.pixel_sha256 === afterSha ? "unchanged" : "changed",
            method: "sha256-encoded-image" as const,
            before_sha256: before.pixel_sha256,
            after_sha256: afterSha,
          },
        }
      : {}),
  };
}

function readImageBytes(
  data: unknown,
): { bytes: Buffer; mimeType: string } | undefined {
  if (Buffer.isBuffer(data)) {
    const mimeType = inferImageMime(data);
    return mimeType ? { bytes: data, mimeType } : undefined;
  }
  if (!isRecord(data)) return undefined;
  if (Buffer.isBuffer(data.value)) {
    const mimeType = readDeclaredImageMime(data) ?? inferImageMime(data.value);
    return mimeType ? { bytes: data.value, mimeType } : undefined;
  }
  const encoded =
    typeof data.base64 === "string"
      ? data.base64
      : typeof data.screenshot_png_b64 === "string"
        ? data.screenshot_png_b64
        : undefined;
  if (!encoded) return undefined;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0) return undefined;
  const mimeType = readDeclaredImageMime(data) ?? inferImageMime(bytes);
  return mimeType ? { bytes, mimeType } : undefined;
}

function readDeclaredImageMime(
  data: Record<string, unknown>,
): string | undefined {
  for (const value of [
    data.mime,
    data.screenshot_mime_type,
    isRecord(data.image) ? data.image.mime : undefined,
  ]) {
    if (typeof value === "string" && value.startsWith("image/")) return value;
  }
  return undefined;
}

function inferImageMime(bytes: Buffer): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes.subarray(1, 4).toString("ascii") === "PNG"
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

function readImageDimensions(data: unknown): {
  width?: number;
  height?: number;
} {
  if (!isRecord(data)) return {};
  const observation = isRecord(data.observation) ? data.observation : undefined;
  const coordinateSpace =
    observation && isRecord(observation.coordinate_space)
      ? observation.coordinate_space
      : undefined;
  const width = firstPositiveInteger(
    data.width,
    data.screenshot_width,
    isRecord(data.image) ? data.image.width : undefined,
    coordinateSpace?.pixel_width,
  );
  const height = firstPositiveInteger(
    data.height,
    data.screenshot_height,
    isRecord(data.image) ? data.image.height : undefined,
    coordinateSpace?.pixel_height,
  );
  return {
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
  };
}

function readObservationSha(data: unknown): string | undefined {
  if (!isRecord(data) || !isRecord(data.observation)) return undefined;
  const value = data.observation.pixel_sha256;
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
    ? value
    : undefined;
}

function withoutImageBytes(data: unknown): unknown {
  if (Buffer.isBuffer(data)) {
    return { bytes: data.length };
  }
  if (Array.isArray(data)) return data.map(withoutImageBytes);
  if (!isRecord(data)) return data;
  return Object.fromEntries(
    Object.entries(data)
      .filter(([key]) => key !== "base64" && key !== "screenshot_png_b64")
      .map(([key, value]) => [key, withoutImageBytes(value)]),
  );
}

function firstPositiveInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
      return value;
    }
  }
  return undefined;
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
