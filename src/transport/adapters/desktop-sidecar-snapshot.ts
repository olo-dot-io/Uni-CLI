/**
 * @owner       src::transport::adapters::desktop-sidecar-snapshot
 * @does        Normalize UIA/AT-SPI snapshot payloads into public encodings, inherit exact window identity, and replace their action-ref bucket.
 * @needs       snapshot encoder, ref store, transport snapshot types
 * @feeds       Windows UIA and Linux AT-SPI transports
 * @breaks      Returning fresh JSON with an old persisted bucket or dropping a native window id makes the next action stale or target-ambiguous.
 * @invariants  Every explicit compact, tree, or JSON snapshot replaces the matching transport/scope bucket with refs from that exact tree; descendants inherit app/pid/window identity from their exact native window.
 * @side-effects Replaces one caller-owned ref bucket.
 * @perf        One normalization and encoding traversal per snapshot.
 * @concurrency Caller-owned transport serialization protects the ref replacement.
 * @test        tests/unit/transport/adapters/desktop-uia.test.ts and desktop-atspi.test.ts
 * @stability   stable
 * @since       2026-05-04
 */

import { RefAllocator, type RefStore } from "../refs.js";
import {
  encodeSnapshot,
  type RawAxNode,
  type SnapshotEncoding,
} from "../snapshot-encoder.js";
import type { Snapshot, SnapshotFormat, TransportKind } from "../types.js";

export type SidecarSnapshotFormat = SnapshotFormat | SnapshotEncoding;

export function snapshotFromSidecarRaw(
  data: unknown,
  opts: {
    format?: SidecarSnapshotFormat;
    transport: TransportKind;
    refs?: RefStore;
  },
): Snapshot {
  if (
    opts.format === "compact" ||
    opts.format === "tree" ||
    opts.format === "json"
  ) {
    const raw = normalizeRawAxNode(data);
    const alloc = new RefAllocator();
    const { encoded, refCount } = encodeSnapshot(raw, {
      format: opts.format,
      transport: opts.transport,
      alloc,
    });
    opts.refs?.put(alloc.freeze(opts.transport, raw.scope));
    if (opts.format === "json") {
      return {
        format: "json",
        encoding: "json",
        data: encoded,
        refs: { count: refCount, scope: raw.scope },
      };
    }
    return {
      format: "text",
      encoding: opts.format,
      data: encoded,
      refs: { count: refCount, scope: raw.scope },
    };
  }

  return {
    format: "json",
    data: JSON.stringify(data),
  };
}

function normalizeRawAxNode(
  input: unknown,
  inherited: {
    app?: string;
    pid?: number;
    windowId?: number | string;
  } = {},
): RawAxNode {
  const record = asRecord(input);
  const role = readString(record.role, "Unknown");
  const path = readString(record.path, `${role}[0]`);
  const scope = readString(record.scope, "desktop");
  const app = readOptionalString(record.app) ?? inherited.app;
  const pid = readOptionalNumber(record.pid) ?? inherited.pid;
  const windowId =
    readOptionalNativeWindowId(record.windowId) ?? inherited.windowId;
  const children = Array.isArray(record.children)
    ? record.children.map((child) =>
        normalizeRawAxNode(child, { app, pid, windowId }),
      )
    : undefined;

  return {
    role,
    name: readOptionalString(record.name),
    value: readOptionalString(record.value),
    bounds: readBounds(record.bounds),
    screenIndex: readOptionalNumber(record.screenIndex),
    states: readStringArray(record.states),
    children,
    path,
    scope,
    app,
    pid,
    windowId,
  };
}

function readBounds(input: unknown): RawAxNode["bounds"] | undefined {
  const record = asOptionalRecord(input);
  if (!record) return undefined;
  const x = readOptionalNumber(record.x);
  const y = readOptionalNumber(record.y);
  const w = readOptionalNumber(record.w ?? record.width);
  const h = readOptionalNumber(record.h ?? record.height);
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof w !== "number" ||
    typeof h !== "number"
  ) {
    return undefined;
  }
  return { x, y, w, h };
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readOptionalNativeWindowId(
  value: unknown,
): number | string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter(
    (item): item is string => typeof item === "string",
  );
  return items.length > 0 ? items : undefined;
}

function asRecord(input: unknown): Record<string, unknown> {
  return asOptionalRecord(input) ?? {};
}

function asOptionalRecord(input: unknown): Record<string, unknown> | undefined {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
}
