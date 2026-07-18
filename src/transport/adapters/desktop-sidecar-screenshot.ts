/**
 * @owner       src::transport::adapters::desktop-sidecar-screenshot
 * @does        Normalize native sidecar screenshots into one top-level image contract and transactionally publish requested paths.
 * @needs       transactional file publisher, Node buffers
 * @feeds       Windows UIA and Linux AT-SPI transport actions
 * @breaks      Forwarding the final destination to a native helper can expose partial files; preserving nested image bytes prevents capture metadata enrichment.
 * @invariants  Sidecars always return a complete PNG in memory; requested destinations change only at atomic commit; public image bytes live at the top level.
 * @side-effects May atomically replace one requested screenshot path.
 * @perf        One base64 decode and, for path requests, one transactional file write.
 * @concurrency Unique transactional staging files isolate simultaneous writers.
 * @test        tests/unit/transport/adapters/desktop-uia.test.ts and desktop-atspi.test.ts
 * @stability   internal
 * @since       0.400.2
 */

import { writeFileTransactionally } from "../../engine/transactional-file.js";

export interface SidecarScreenshotRequest {
  params: Record<string, unknown>;
  path?: string;
}

export function prepareSidecarScreenshotRequest(
  params: Record<string, unknown>,
): SidecarScreenshotRequest {
  const path =
    typeof params.path === "string" && params.path.trim()
      ? params.path
      : undefined;
  if (params.path !== undefined && !path) {
    throw new Error("screenshot path must be a non-empty string");
  }
  const sidecarParams = { ...params };
  delete sidecarParams.path;
  return { params: sidecarParams, ...(path ? { path } : {}) };
}

export async function normalizeSidecarScreenshot(
  data: unknown,
  path?: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  const outer = record(data, "sidecar screenshot response");
  const payload =
    outer.screenshot === undefined
      ? outer
      : record(outer.screenshot, "sidecar screenshot payload");
  const base64 = payload.base64;
  if (typeof base64 !== "string" || !isCanonicalBase64(base64)) {
    throw new Error(
      "sidecar screenshot response did not contain valid base64 image bytes",
    );
  }
  const bytes = Buffer.from(base64, "base64");
  if (!isPng(bytes)) {
    throw new Error("sidecar screenshot response was not a PNG image");
  }
  if (payload.mime !== undefined && payload.mime !== "image/png") {
    throw new Error(
      `sidecar screenshot returned unsupported mime ${String(payload.mime)}`,
    );
  }

  const normalized: Record<string, unknown> = { ...outer, ...payload };
  delete normalized.screenshot;
  normalized.mime = "image/png";
  normalized.bytes = bytes.length;
  if (path) {
    await writeFileTransactionally(path, bytes, { mode: 0o600, signal });
    delete normalized.base64;
    normalized.path = path;
  }
  return normalized;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`${label} must be an object`);
}

function isCanonicalBase64(value: string): boolean {
  return (
    value.length > 0 &&
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  );
}

function isPng(value: Buffer): boolean {
  return (
    value.length >= 8 &&
    value.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  );
}
