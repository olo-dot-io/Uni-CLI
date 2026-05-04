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
  if (opts.format === "compact" || opts.format === "tree") {
    const raw = normalizeRawAxNode(data);
    const alloc = new RefAllocator();
    const { encoded, refCount } = encodeSnapshot(raw, {
      format: opts.format,
      transport: opts.transport,
      alloc,
    });
    opts.refs?.put(alloc.freeze(opts.transport, raw.scope));
    return {
      format: "text",
      encoding: opts.format,
      data: encoded,
      refs: { count: refCount, scope: raw.scope },
    };
  }

  return {
    format: "json",
    encoding: opts.format === "json" ? "json" : undefined,
    data: JSON.stringify(data),
  };
}

function normalizeRawAxNode(input: unknown): RawAxNode {
  const record = asRecord(input);
  const role = readString(record.role, "Unknown");
  const path = readString(record.path, `${role}[0]`);
  const scope = readString(record.scope, "desktop");
  const children = Array.isArray(record.children)
    ? record.children.map(normalizeRawAxNode)
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
    app: readOptionalString(record.app),
    pid: readOptionalNumber(record.pid),
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
