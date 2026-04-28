import type { Surface } from "../../output/envelope.js";
import type { TargetSurface } from "../../types.js";
import type { BrowserSessionLease } from "../browser/session-lease.js";

export type RunId = string;
export type TraceId = string;

export type RunEventName =
  | "run.started"
  | "tool.call.started"
  | "permission.evaluated"
  | "evidence.captured"
  | "tool.call.completed"
  | "tool.call.failed"
  | "run.completed"
  | "run.failed";

export type EvidenceVisibility = "public" | "internal" | "secret";

export interface RunTraceMetadata {
  run_id: RunId;
  trace_id: TraceId;
  command: string;
  site: string;
  cmd: string;
  adapter_path: string;
  permission_profile: string;
  transport_surface: "cli" | "mcp" | "acp" | "bench" | "hub";
  target_surface: TargetSurface | Surface;
  args_hash: string;
  pipeline_steps: number;
  browser_lease?: BrowserSessionLease;
}

export interface RunEvent {
  schema_version: "1";
  name: RunEventName;
  run_id: RunId;
  trace_id: TraceId;
  sequence: number;
  timestamp: string;
  visibility: EvidenceVisibility;
  metadata: RunTraceMetadata;
  data?: Record<string, unknown>;
  internal?: unknown;
  secret?: unknown;
}

export interface RunEventSequence {
  next(): number;
}

export type PublicRunEvent = Omit<RunEvent, "internal" | "secret">;
