import type {
  EvidenceVisibility,
  PublicRunEvent,
  RunEvent,
  RunEventSequence,
  RunTraceMetadata,
} from "./types.js";

export type {
  EvidenceVisibility,
  PublicRunEvent,
  RunEvent,
  RunEventName,
  RunEventSequence,
  RunId,
  RunTraceMetadata,
  TraceId,
} from "./types.js";

interface EventOptions {
  timestamp?: string;
  visibility?: EvidenceVisibility;
  data?: Record<string, unknown>;
  internal?: unknown;
  secret?: unknown;
}

export function createRunEventSequence(start = 0): RunEventSequence {
  let current = start;
  return {
    next: () => {
      current += 1;
      return current;
    },
  };
}

function createEvent(
  name: RunEvent["name"],
  metadata: RunTraceMetadata,
  sequence: RunEventSequence,
  options: EventOptions = {},
): RunEvent {
  return {
    schema_version: "1",
    name,
    run_id: metadata.run_id,
    trace_id: metadata.trace_id,
    sequence: sequence.next(),
    timestamp: options.timestamp ?? new Date().toISOString(),
    visibility: options.visibility ?? "internal",
    metadata,
    ...(options.data !== undefined ? { data: options.data } : {}),
    ...(options.internal !== undefined ? { internal: options.internal } : {}),
    ...(options.secret !== undefined ? { secret: options.secret } : {}),
  };
}

export function createRunStartedEvent(
  metadata: RunTraceMetadata,
  sequence: RunEventSequence,
  options: EventOptions = {},
): RunEvent {
  return createEvent("run.started", metadata, sequence, options);
}

export function createToolCallStartedEvent(
  metadata: RunTraceMetadata,
  sequence: RunEventSequence,
  data: Record<string, unknown> = {},
): RunEvent {
  return createEvent("tool.call.started", metadata, sequence, {
    data: {
      command: metadata.command,
      adapter_path: metadata.adapter_path,
      args_hash: metadata.args_hash,
      ...data,
    },
  });
}

export function createPermissionEvaluatedEvent(
  metadata: RunTraceMetadata,
  sequence: RunEventSequence,
  data: Record<string, unknown>,
): RunEvent {
  return createEvent("permission.evaluated", metadata, sequence, { data });
}

export function createEvidenceCapturedEvent(
  metadata: RunTraceMetadata,
  sequence: RunEventSequence,
  options: EventOptions & {
    evidence_type: string;
  },
): RunEvent {
  return createEvent("evidence.captured", metadata, sequence, {
    ...options,
    data: {
      evidence_type: options.evidence_type,
      ...options.data,
    },
  });
}

export function createToolCallCompletedEvent(
  metadata: RunTraceMetadata,
  sequence: RunEventSequence,
  data: Record<string, unknown>,
): RunEvent {
  return createEvent("tool.call.completed", metadata, sequence, { data });
}

export function createToolCallFailedEvent(
  metadata: RunTraceMetadata,
  sequence: RunEventSequence,
  data: Record<string, unknown>,
): RunEvent {
  return createEvent("tool.call.failed", metadata, sequence, { data });
}

export function createRunCompletedEvent(
  metadata: RunTraceMetadata,
  sequence: RunEventSequence,
  data: Record<string, unknown>,
): RunEvent {
  return createEvent("run.completed", metadata, sequence, { data });
}

export function createRunFailedEvent(
  metadata: RunTraceMetadata,
  sequence: RunEventSequence,
  data: Record<string, unknown>,
): RunEvent {
  return createEvent("run.failed", metadata, sequence, { data });
}

export function projectRunEventForPublicSurface(
  event: RunEvent,
): PublicRunEvent {
  const { internal: _internal, secret: _secret, ...publicEvent } = event;
  return publicEvent;
}
