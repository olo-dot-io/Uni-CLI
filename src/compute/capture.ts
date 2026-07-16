/**
 * @owner   src/compute/capture.ts
 * @does    Build a reusable desktop context packet from existing compute snapshot and screenshot actions.
 * @needs   core/envelope, transport/cascade, transport/types
 * @feeds   src/commands/compute.ts, src/mcp/profiles/computer-use.ts
 * @breaks  Returns a structured transport envelope when every requested capture part fails.
 * @invariants Capture reuses compute_* actions; it does not bypass transport policy or ref allocation.
 * @side-effects May capture screenshots; may populate the transport ref store through compute_snapshot.
 * @perf    Screenshot payload size dominates packet size when no path is supplied.
 * @concurrency Uses the caller-provided transport bus; callers own bus lifecycle.
 * @test    tests/unit/commands/compute.test.ts, tests/unit/mcp/tools.test.ts
 * @stability beta
 * @since   0.223.0
 */

import { err, exitCodeFor, ok } from "../core/envelope.js";
import { tryCascade } from "../transport/cascade.js";
import type { ActionResult, TransportBus } from "../transport/types.js";
import { buildCaptureVisualTimeline } from "./visual-timeline.js";
import type { ComputeVisualTimeline } from "./visual-timeline.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export type CaptureInclude = "snapshot" | "screenshot";
export type CaptureSnapshotFormat = "compact" | "tree" | "json";

export interface ComputeCaptureOptions {
  app?: string;
  include?: string | readonly CaptureInclude[];
  format?: CaptureSnapshotFormat;
  maxDepth?: number;
  screenshotPath?: string;
}

export interface ComputeCaptureHooks {
  onSnapshotSuccess?: () => void;
  signal?: AbortSignal;
}

export interface ComputeCapturePart {
  ok: boolean;
  data?: unknown;
  error?: {
    reason: string;
    suggestion: string;
    minimum_capability?: string;
  };
}

export interface ComputeCaptureImageMetadata {
  mime?: string;
  bytes: number;
  sha256: string;
  width?: number;
  height?: number;
  coordinate_space: {
    kind: "image-pixels";
    origin: "top-left";
  };
}

export interface ComputeCaptureTrajectoryStep {
  index: number;
  action: "compute_snapshot" | "compute_screenshot";
  params: Record<string, unknown>;
  ok: boolean;
}

export interface ComputeCapturePacket {
  schema_version: 1;
  captured_at: string;
  app?: string;
  includes: CaptureInclude[];
  snapshot?: ComputeCapturePart;
  screenshot?: ComputeCapturePart;
  trajectory: {
    replayable: true;
    steps: ComputeCaptureTrajectoryStep[];
  };
  visual_timeline: ComputeVisualTimeline;
}

export async function captureComputeContext(
  bus: TransportBus,
  options: ComputeCaptureOptions,
  hooks: ComputeCaptureHooks = {},
): Promise<ActionResult<ComputeCapturePacket>> {
  hooks.signal?.throwIfAborted();
  const parsedIncludes = readCaptureIncludes(options.include);
  if (parsedIncludes.invalid.length > 0) {
    const plural = parsedIncludes.invalid.length === 1 ? "" : "s";
    return err({
      transport: "subprocess",
      step: 0,
      action: "compute_capture",
      reason: `invalid capture include part${plural}: ${parsedIncludes.invalid.join(", ")}`,
      suggestion: "use --include snapshot,screenshot, snapshot, or screenshot",
      minimum_capability: "compute.capture",
      exit_code: exitCodeFor("usage_error"),
    });
  }
  const includes = parsedIncludes.includes;
  const parts: Partial<Pick<ComputeCapturePacket, "snapshot" | "screenshot">> =
    {};
  const trajectory: ComputeCaptureTrajectoryStep[] = [];

  if (includes.includes("snapshot")) {
    hooks.signal?.throwIfAborted();
    const params = {
      ...(options.app ? { app: options.app } : {}),
      format: options.format ?? "compact",
      maxDepth: options.maxDepth ?? 64,
    };
    const snapshotResult = await tryCascade(bus, {
      kind: "compute_snapshot",
      params,
      ...(hooks.signal ? { signal: hooks.signal } : {}),
    });
    hooks.signal?.throwIfAborted();
    parts.snapshot = capturePart(snapshotResult);
    trajectory.push({
      index: trajectory.length,
      action: "compute_snapshot",
      params,
      ok: snapshotResult.ok,
    });
    if (snapshotResult.ok) hooks.onSnapshotSuccess?.();
  }

  if (includes.includes("screenshot")) {
    hooks.signal?.throwIfAborted();
    const params = {
      ...(options.app ? { app: options.app } : {}),
      ...(options.screenshotPath ? { path: options.screenshotPath } : {}),
    };
    const screenshotResult = await tryCascade(bus, {
      kind: "compute_screenshot",
      params,
      ...(hooks.signal ? { signal: hooks.signal } : {}),
    });
    hooks.signal?.throwIfAborted();
    parts.screenshot = await captureScreenshotPart(
      screenshotResult,
      hooks.signal,
    );
    hooks.signal?.throwIfAborted();
    trajectory.push({
      index: trajectory.length,
      action: "compute_screenshot",
      params,
      ok: screenshotResult.ok,
    });
  }

  hooks.signal?.throwIfAborted();
  const successes = Object.values(parts).filter((part) => part?.ok).length;
  if (successes === 0) {
    return err({
      transport: "visual",
      step: 0,
      action: "compute_capture",
      reason: "all requested capture parts failed",
      suggestion: "run `unicli doctor compute`, then retry capture",
      minimum_capability: "compute.capture",
      exit_code: exitCodeFor("service_unavailable"),
    });
  }

  const packet: Omit<ComputeCapturePacket, "visual_timeline"> = {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    ...(options.app ? { app: options.app } : {}),
    includes,
    ...parts,
    trajectory: {
      replayable: true,
      steps: trajectory,
    },
  };

  return ok({
    ...packet,
    visual_timeline: buildCaptureVisualTimeline(packet),
  });
}

function capturePart(result: ActionResult<unknown>): ComputeCapturePart {
  if (result.ok) return { ok: true, data: result.data };
  return {
    ok: false,
    error: {
      reason: result.error.reason,
      suggestion: result.error.suggestion,
      minimum_capability: result.error.minimum_capability,
    },
  };
}

async function captureScreenshotPart(
  result: ActionResult<unknown>,
  signal?: AbortSignal,
): Promise<ComputeCapturePart> {
  if (!result.ok) return capturePart(result);
  signal?.throwIfAborted();
  return {
    ok: true,
    data: await enrichScreenshotData(result.data, signal),
  };
}

async function enrichScreenshotData(
  data: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const buffer = await screenshotBuffer(data, signal);
  signal?.throwIfAborted();
  if (!buffer) return data;
  const image = readImageMetadata(buffer, readMime(data, buffer));
  if (Buffer.isBuffer(data)) {
    return {
      base64: buffer.toString("base64"),
      mime: image.mime,
      image,
    };
  }
  if (isRecord(data)) return { ...data, image };
  return { data, image };
}

async function screenshotBuffer(
  data: unknown,
  signal?: AbortSignal,
): Promise<Buffer | undefined> {
  if (Buffer.isBuffer(data)) return data;
  if (!isRecord(data)) return undefined;
  if (typeof data.base64 === "string") {
    return Buffer.from(data.base64, "base64");
  }
  if (typeof data.path === "string") {
    try {
      return await readFile(data.path, signal ? { signal } : undefined);
    } catch {
      signal?.throwIfAborted();
      return undefined;
    }
  }
  return undefined;
}

function readImageMetadata(
  buffer: Buffer,
  mime?: string,
): ComputeCaptureImageMetadata {
  const size = readImageSize(buffer);
  return {
    ...(mime ? { mime } : {}),
    bytes: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    ...(size ? { width: size.width, height: size.height } : {}),
    coordinate_space: {
      kind: "image-pixels",
      origin: "top-left",
    },
  };
}

function readMime(data: unknown, buffer: Buffer): string | undefined {
  if (isRecord(data) && typeof data.mime === "string") return data.mime;
  if (isPng(buffer)) return "image/png";
  if (isJpeg(buffer)) return "image/jpeg";
  return undefined;
}

function readImageSize(
  buffer: Buffer,
): { width: number; height: number } | undefined {
  if (isPng(buffer) && buffer.length >= 24) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }
  return readJpegSize(buffer);
}

function isPng(buffer: Buffer): boolean {
  return (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  );
}

function readJpegSize(
  buffer: Buffer,
): { width: number; height: number } | undefined {
  if (!isJpeg(buffer)) return undefined;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buffer.length) return undefined;
    if (isJpegStartOfFrame(marker)) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  return undefined;
}

function isJpeg(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8;
}

function isJpegStartOfFrame(marker: number | undefined): boolean {
  return (
    marker !== undefined &&
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCaptureIncludes(value: ComputeCaptureOptions["include"]): {
  includes: CaptureInclude[];
  invalid: string[];
} {
  const parts = Array.isArray(value)
    ? value
    : String(value ?? "snapshot,screenshot")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
  const includes = parts.filter(isCaptureInclude);
  const invalid = parts.filter((part) => !isCaptureInclude(part));
  return {
    includes: includes.length > 0 ? includes : ["snapshot", "screenshot"],
    invalid,
  };
}

function isCaptureInclude(value: string): value is CaptureInclude {
  return value === "snapshot" || value === "screenshot";
}
