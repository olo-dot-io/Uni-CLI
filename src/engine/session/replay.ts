import type { BrowserSessionLease } from "../browser/session-lease.js";
import type { ArgSource } from "../args.js";
import { hashRunArgs } from "./args.js";
import { summarizeRunEvents, type RunSummary } from "./query.js";
import type { RunEvent, RunId, RunTraceMetadata } from "./types.js";

export interface RunReplayPlan {
  run_id: RunId;
  replayable: boolean;
  reason?: string;
  command?: string;
  site?: string;
  cmd?: string;
  args_hash?: string;
  recorded_args_hash?: string;
  args_hash_matches?: boolean;
  argument_keys?: string[];
  permission_profile?: string;
  approved?: boolean;
  source?: string;
  transport_surface?: string;
  target_surface?: string;
  browser_lease?: BrowserSessionLease;
  source_event_sequence?: number;
  original_summary: RunSummary;
}

export interface RunReplayInvocation {
  site: string;
  cmd: string;
  args: Record<string, unknown>;
  source: ArgSource;
  permissionProfile?: string;
  approved?: boolean;
}

interface ReplaySecret {
  schema_version?: string;
  site?: unknown;
  cmd?: unknown;
  args?: unknown;
  source?: unknown;
  permission_profile?: unknown;
  approved?: unknown;
  args_hash?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function replaySecretFromEvent(event: RunEvent): ReplaySecret | undefined {
  if (!isRecord(event.secret)) return undefined;
  const replay = event.secret.replay;
  if (!isRecord(replay)) return undefined;
  return replay;
}

function replaySource(value: unknown): ArgSource {
  return value === "shell" ||
    value === "file" ||
    value === "stdin" ||
    value === "mixed" ||
    value === "mcp" ||
    value === "acp" ||
    value === "internal"
    ? value
    : "internal";
}

function metadataFromEvents(events: RunEvent[]): RunTraceMetadata | undefined {
  return (
    events.find((event) => event.name === "tool.call.started")?.metadata ??
    events.find((event) => event.name === "run.started")?.metadata ??
    events[0]?.metadata
  );
}

function commandFromMetadata(
  metadata?: RunTraceMetadata,
): Pick<RunReplayPlan, "command" | "site" | "cmd"> {
  if (!metadata) return {};
  return {
    command: metadata.command,
    site: metadata.site,
    cmd: metadata.cmd,
  };
}

export function extractRunReplayPlan(
  events: RunEvent[],
  runId: RunId,
): RunReplayPlan {
  const originalSummary = summarizeRunEvents(events, { runId });
  const metadata = metadataFromEvents(events);
  const base: RunReplayPlan = {
    run_id: runId,
    replayable: false,
    original_summary: originalSummary,
    ...commandFromMetadata(metadata),
    ...(metadata?.args_hash ? { args_hash: metadata.args_hash } : {}),
    ...(metadata?.permission_profile
      ? { permission_profile: metadata.permission_profile }
      : {}),
    ...(metadata?.transport_surface
      ? { transport_surface: metadata.transport_surface }
      : {}),
    ...(metadata?.target_surface
      ? { target_surface: String(metadata.target_surface) }
      : {}),
    ...(metadata?.browser_lease
      ? { browser_lease: metadata.browser_lease }
      : {}),
  };

  if (events.length === 0) {
    return { ...base, reason: "run trace has no events" };
  }
  if (!metadata) {
    return { ...base, reason: "run trace has no command metadata" };
  }

  const replayEvent = events.find((event) => replaySecretFromEvent(event));
  if (!replayEvent) {
    return {
      ...base,
      reason:
        "run trace was recorded before replay payloads were available; rerun with --record to capture exact args",
    };
  }

  const replay = replaySecretFromEvent(replayEvent);
  if (!replay) {
    return { ...base, reason: "run trace replay payload is malformed" };
  }
  if (typeof replay.site !== "string" || typeof replay.cmd !== "string") {
    return {
      ...base,
      reason: "run trace replay payload is missing site or command",
      source_event_sequence: replayEvent.sequence,
    };
  }
  if (!isRecord(replay.args)) {
    return {
      ...base,
      reason: "run trace replay payload is missing resolved args",
      source_event_sequence: replayEvent.sequence,
    };
  }
  const recordedArgsHash =
    typeof replay.args_hash === "string" ? replay.args_hash : undefined;
  const computedArgsHash = hashRunArgs(replay.args);
  const argsHashMatches = recordedArgsHash
    ? recordedArgsHash === computedArgsHash &&
      (!metadata.args_hash || metadata.args_hash === computedArgsHash)
    : !metadata.args_hash || metadata.args_hash === computedArgsHash;

  return {
    ...base,
    replayable: argsHashMatches,
    ...(argsHashMatches
      ? {}
      : {
          reason: "run trace replay args do not match the recorded args hash",
        }),
    command: `${replay.site}.${replay.cmd}`,
    site: replay.site,
    cmd: replay.cmd,
    args_hash: computedArgsHash,
    ...(recordedArgsHash ? { recorded_args_hash: recordedArgsHash } : {}),
    args_hash_matches: argsHashMatches,
    argument_keys: Object.keys(replay.args).sort(),
    source: typeof replay.source === "string" ? replay.source : undefined,
    permission_profile:
      typeof replay.permission_profile === "string"
        ? replay.permission_profile
        : metadata.permission_profile,
    approved: replay.approved === true,
    source_event_sequence: replayEvent.sequence,
  };
}

export function extractRunReplayInvocation(
  events: RunEvent[],
  runId: RunId,
): RunReplayInvocation | null {
  const plan = extractRunReplayPlan(events, runId);
  if (!plan.replayable) return null;
  const replayEvent = events.find((event) => replaySecretFromEvent(event));
  const replay = replayEvent ? replaySecretFromEvent(replayEvent) : undefined;
  if (
    !replay ||
    typeof replay.site !== "string" ||
    typeof replay.cmd !== "string" ||
    !isRecord(replay.args)
  ) {
    return null;
  }
  return {
    site: replay.site,
    cmd: replay.cmd,
    args: replay.args,
    source: replaySource(replay.source),
    permissionProfile:
      typeof replay.permission_profile === "string"
        ? replay.permission_profile
        : undefined,
    approved: replay.approved === true,
  };
}
