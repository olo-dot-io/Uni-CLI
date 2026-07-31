/**
 * @owner       src::compute::visual-observation
 * @does        Issue and atomically consume opaque, provider-bound evidence refs for desktop pixel coordinates.
 * @needs       Node crypto/fs/os/path
 * @feeds       compute screenshot and coordinate-action dispatch
 * @breaks      Trusting caller-supplied provider/scope metadata or reusing an observation can actuate the wrong desktop pixels.
 * @invariants  Refs contain only 256 bits of randomness; authoritative metadata stays in a mode-0600 record; claims are single-use, TTL-bound, provider/scope/session-bound, and image-bounds checked.
 * @side-effects Creates and atomically renames short-lived records below the host temp directory.
 * @perf        O(image bytes) once while issuing for SHA-256; claim and coordinate validation are O(number of points).
 * @concurrency An atomic rename admits at most one claimant across processes.
 * @test        tests/unit/compute-visual-observation.test.ts, tests/unit/compute-visual-observation-dispatch.test.ts
 * @stability   experimental
 * @since       2026-07-31
 */

import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OperatorTargetScope } from "../types.js";
import type { TransportKind } from "../transport/types.js";

export const VISUAL_OBSERVATION_SCHEMA = "visual-observation.v1" as const;
export const VISUAL_OBSERVATION_TTL_MS = 30_000;

const REF_PREFIX = "visual-observation:";
const REF_ID = /^[a-f0-9]{64}$/;
const RECORD_SCHEMA = 1;

export type VisualObservationProvider = Extract<
  TransportKind,
  "visual" | "cua-driver"
>;

interface VisualObservationRecord {
  schema_version: typeof RECORD_SCHEMA;
  id: string;
  provider: VisualObservationProvider;
  target_scope: OperatorTargetScope;
  captured_at_ms: number;
  expires_at_ms: number;
  pixel_sha256: string;
  pixel_width: number;
  pixel_height: number;
  action_width: number;
  action_height: number;
  session?: string;
  display?: string;
  scale_factor?: number;
}

export interface VisualObservationEvidence {
  schema_version: typeof VISUAL_OBSERVATION_SCHEMA;
  ref: string;
  provider: VisualObservationProvider;
  target_scope: OperatorTargetScope;
  captured_at: string;
  expires_at: string;
  single_use: true;
  pixel_sha256: string;
  coordinate_space: {
    input: "image-pixels";
    action: "screen-pixels";
    origin: "top-left";
    pixel_width: number;
    pixel_height: number;
    action_width: number;
    action_height: number;
    scale_x: number;
    scale_y: number;
  };
  session?: string;
  display?: string;
  scale_factor?: number;
}

export interface VisualObservationPoint {
  x: number;
  y: number;
  label: string;
}

export interface ClaimedVisualObservation {
  evidence: VisualObservationEvidence;
  transform(point: VisualObservationPoint): VisualObservationPoint;
  release(): Promise<void>;
}

export class VisualObservationError extends Error {
  constructor(
    readonly code:
      | "invalid_ref"
      | "not_found"
      | "expired"
      | "provider_mismatch"
      | "scope_mismatch"
      | "session_mismatch"
      | "out_of_bounds"
      | "pixels_unavailable"
      | "store_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "VisualObservationError";
  }
}

export async function issueVisualObservation(input: {
  provider: VisualObservationProvider;
  targetScope: OperatorTargetScope;
  data: unknown;
  session?: unknown;
  now?: number;
  ttlMs?: number;
  root?: string;
}): Promise<VisualObservationEvidence> {
  const image = await readObservationImage(input.data);
  const now = input.now ?? Date.now();
  const ttlMs = input.ttlMs ?? VISUAL_OBSERVATION_TTL_MS;
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1
  ) {
    throw new VisualObservationError(
      "store_unavailable",
      "visual observation clock or TTL is invalid",
    );
  }
  const id = randomBytes(32).toString("hex");
  const session = optionalNonEmptyString(input.session);
  const record: VisualObservationRecord = {
    schema_version: RECORD_SCHEMA,
    id,
    provider: input.provider,
    target_scope: input.targetScope,
    captured_at_ms: now,
    expires_at_ms: now + ttlMs,
    pixel_sha256: createHash("sha256").update(image.bytes).digest("hex"),
    pixel_width: image.pixelWidth,
    pixel_height: image.pixelHeight,
    action_width: image.actionWidth,
    action_height: image.actionHeight,
    ...(session ? { session } : {}),
    ...(image.display ? { display: image.display } : {}),
    ...(image.scaleFactor ? { scale_factor: image.scaleFactor } : {}),
  };
  const root = await prepareRoot(input.root);
  const path = recordPath(root, id);
  try {
    const handle = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw new VisualObservationError(
      "store_unavailable",
      `could not persist visual observation: ${errorMessage(error)}`,
    );
  }
  return publicEvidence(record);
}

export async function claimVisualObservation(input: {
  ref: unknown;
  provider: VisualObservationProvider;
  targetScope: OperatorTargetScope;
  points: readonly VisualObservationPoint[];
  session?: unknown;
  now?: number;
  root?: string;
}): Promise<ClaimedVisualObservation> {
  const id = parseRef(input.ref);
  const root = await prepareRoot(input.root);
  const path = recordPath(root, id);
  const record = await readRecord(path, id);
  const now = input.now ?? Date.now();
  if (now >= record.expires_at_ms) {
    await unlink(path).catch(() => undefined);
    throw new VisualObservationError(
      "expired",
      `visual observation expired at ${new Date(record.expires_at_ms).toISOString()}`,
    );
  }
  if (record.provider !== input.provider) {
    throw new VisualObservationError(
      "provider_mismatch",
      `visual observation belongs to ${record.provider}, not ${input.provider}`,
    );
  }
  if (record.target_scope !== input.targetScope) {
    throw new VisualObservationError(
      "scope_mismatch",
      `visual observation scope ${record.target_scope} does not match action scope ${input.targetScope}`,
    );
  }
  const expectedSession = optionalNonEmptyString(input.session);
  if (record.session !== expectedSession) {
    throw new VisualObservationError(
      "session_mismatch",
      "visual observation and coordinate action do not share the same session",
    );
  }
  for (const point of input.points) validatePoint(record, point);

  const claimedPath = `${path}.${randomBytes(12).toString("hex")}.claimed`;
  try {
    await rename(path, claimedPath);
  } catch (error) {
    if (isNotFound(error)) {
      throw new VisualObservationError(
        "not_found",
        "visual observation is unknown, expired, or already consumed",
      );
    }
    throw new VisualObservationError(
      "store_unavailable",
      `could not claim visual observation: ${errorMessage(error)}`,
    );
  }

  let released = false;
  return {
    evidence: publicEvidence(record),
    transform: (point) => ({
      ...point,
      x: point.x * (record.action_width / record.pixel_width),
      y: point.y * (record.action_height / record.pixel_height),
    }),
    release: async () => {
      if (released) return;
      released = true;
      await unlink(claimedPath).catch(() => undefined);
    },
  };
}

async function prepareRoot(explicitRoot?: string): Promise<string> {
  const root =
    explicitRoot ??
    process.env.UNICLI_VISUAL_OBSERVATION_ROOT ??
    join(
      tmpdir(),
      `unicli-visual-observations-${String(process.getuid?.() ?? "user")}`,
    );
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    return root;
  } catch (error) {
    throw new VisualObservationError(
      "store_unavailable",
      `could not prepare visual observation store: ${errorMessage(error)}`,
    );
  }
}

function recordPath(root: string, id: string): string {
  return join(root, `${id}.json`);
}

function parseRef(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith(REF_PREFIX)) {
    throw new VisualObservationError(
      "invalid_ref",
      "coordinate action requires an opaque visual-observation ref",
    );
  }
  const id = value.slice(REF_PREFIX.length);
  if (!REF_ID.test(id)) {
    throw new VisualObservationError(
      "invalid_ref",
      "visual observation ref has an invalid opaque identifier",
    );
  }
  return id;
}

async function readRecord(
  path: string,
  expectedId: string,
): Promise<VisualObservationRecord> {
  let text: string;
  try {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    const handle = await open(path, constants.O_RDONLY | noFollow);
    try {
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isNotFound(error)) {
      throw new VisualObservationError(
        "not_found",
        "visual observation is unknown, expired, or already consumed",
      );
    }
    throw new VisualObservationError(
      "store_unavailable",
      `could not read visual observation: ${errorMessage(error)}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new VisualObservationError(
      "invalid_ref",
      "visual observation record is malformed",
    );
  }
  if (!isObservationRecord(value) || value.id !== expectedId) {
    throw new VisualObservationError(
      "invalid_ref",
      "visual observation record failed integrity validation",
    );
  }
  return value;
}

function isObservationRecord(value: unknown): value is VisualObservationRecord {
  if (!isRecord(value)) return false;
  return (
    value.schema_version === RECORD_SCHEMA &&
    typeof value.id === "string" &&
    REF_ID.test(value.id) &&
    (value.provider === "visual" || value.provider === "cua-driver") &&
    isOperatorTargetScope(value.target_scope) &&
    nonNegativeInteger(value.captured_at_ms) &&
    nonNegativeInteger(value.expires_at_ms) &&
    value.expires_at_ms > value.captured_at_ms &&
    typeof value.pixel_sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.pixel_sha256) &&
    positiveInteger(value.pixel_width) &&
    positiveInteger(value.pixel_height) &&
    positiveInteger(value.action_width) &&
    positiveInteger(value.action_height) &&
    (value.session === undefined ||
      optionalNonEmptyString(value.session) !== undefined) &&
    (value.display === undefined ||
      optionalNonEmptyString(value.display) !== undefined) &&
    (value.scale_factor === undefined || positiveFinite(value.scale_factor))
  );
}

function validatePoint(
  record: VisualObservationRecord,
  point: VisualObservationPoint,
): void {
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    point.x < 0 ||
    point.y < 0 ||
    point.x >= record.pixel_width ||
    point.y >= record.pixel_height
  ) {
    throw new VisualObservationError(
      "out_of_bounds",
      `${point.label} (${String(point.x)}, ${String(point.y)}) is outside ${record.pixel_width}x${record.pixel_height} observation pixels`,
    );
  }
}

async function readObservationImage(data: unknown): Promise<{
  bytes: Buffer;
  pixelWidth: number;
  pixelHeight: number;
  actionWidth: number;
  actionHeight: number;
  display?: string;
  scaleFactor?: number;
}> {
  if (!isRecord(data)) {
    throw new VisualObservationError(
      "pixels_unavailable",
      "selected provider did not return a structured pixel observation",
    );
  }
  const base64 = firstString(data.base64, data.screenshot_png_b64);
  const path = firstString(data.screenshot_file_path, data.path);
  let bytes: Buffer;
  try {
    bytes = base64
      ? Buffer.from(base64, "base64")
      : path
        ? await readFile(path)
        : Buffer.alloc(0);
  } catch (error) {
    throw new VisualObservationError(
      "pixels_unavailable",
      `could not read provider-owned pixels: ${errorMessage(error)}`,
    );
  }
  const pixelWidth = firstPositiveInteger(data.width, data.screenshot_width);
  const pixelHeight = firstPositiveInteger(data.height, data.screenshot_height);
  if (
    bytes.length === 0 ||
    pixelWidth === undefined ||
    pixelHeight === undefined
  ) {
    throw new VisualObservationError(
      "pixels_unavailable",
      "selected provider did not return image bytes and exact pixel dimensions",
    );
  }
  const actionWidth = firstPositiveInteger(data.screen_width) ?? pixelWidth;
  const actionHeight = firstPositiveInteger(data.screen_height) ?? pixelHeight;
  const scaleFactor = positiveFinite(data.scale_factor)
    ? data.scale_factor
    : undefined;
  const display = optionalNonEmptyString(data.display);
  return {
    bytes,
    pixelWidth,
    pixelHeight,
    actionWidth,
    actionHeight,
    ...(display ? { display } : {}),
    ...(scaleFactor ? { scaleFactor } : {}),
  };
}

function publicEvidence(
  record: VisualObservationRecord,
): VisualObservationEvidence {
  return {
    schema_version: VISUAL_OBSERVATION_SCHEMA,
    ref: `${REF_PREFIX}${record.id}`,
    provider: record.provider,
    target_scope: record.target_scope,
    captured_at: new Date(record.captured_at_ms).toISOString(),
    expires_at: new Date(record.expires_at_ms).toISOString(),
    single_use: true,
    pixel_sha256: record.pixel_sha256,
    coordinate_space: {
      input: "image-pixels",
      action: "screen-pixels",
      origin: "top-left",
      pixel_width: record.pixel_width,
      pixel_height: record.pixel_height,
      action_width: record.action_width,
      action_height: record.action_height,
      scale_x: record.action_width / record.pixel_width,
      scale_y: record.action_height / record.pixel_height,
    },
    ...(record.session ? { session: record.session } : {}),
    ...(record.display ? { display: record.display } : {}),
    ...(record.scale_factor ? { scale_factor: record.scale_factor } : {}),
  };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const normalized = optionalNonEmptyString(value);
    if (normalized) return normalized;
  }
  return undefined;
}

function firstPositiveInteger(...values: unknown[]): number | undefined {
  for (const value of values) if (positiveInteger(value)) return value;
  return undefined;
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isOperatorTargetScope(value: unknown): value is OperatorTargetScope {
  return (
    value === "service" ||
    value === "host-process" ||
    value === "browser-renderer" ||
    value === "native-window" ||
    value === "desktop" ||
    value === "local-runtime"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
