import { randomUUID } from "node:crypto";

import {
  readRunEvents,
  runTracePath,
  type RunStore,
} from "../session/store.js";
import { summarizeRunEvents } from "../session/query.js";
import type { RunEvent } from "../session/types.js";
import type {
  EvidenceError,
  EvidenceFailureClass,
  EvidencePacket,
  EvidenceRunObservation,
  EvolutionComponent,
  EvolutionScope,
} from "./types.js";
import { EvolutionError } from "./error.js";

export async function distillRunEvidence(input: {
  store: RunStore;
  runIds: string[];
  component: Pick<
    EvolutionComponent,
    "kind" | "id" | "site" | "command" | "source_path" | "source_tier"
  >;
  scope: EvolutionScope;
  createdAt?: string;
}): Promise<EvidencePacket> {
  const observations: EvidenceRunObservation[] = [];
  const expectedCommand = `${input.component.site}.${input.component.command}`;
  const runIds = unique(input.runIds);
  if (runIds.length === 0) {
    throw new EvolutionError(
      "run_not_found",
      "at least one recorded run is required to create an evidence packet",
    );
  }

  for (const runId of runIds) {
    const events = await readRunEvents(input.store, runId);
    if (events.length === 0) {
      throw new EvolutionError(
        "run_not_found",
        `run trace not found or empty: ${runId}`,
      );
    }
    const metadata = events[0]?.metadata;
    if (!metadata) {
      throw new EvolutionError(
        "run_metadata_missing",
        `run trace has no metadata: ${runId}`,
      );
    }
    if (metadata.command !== expectedCommand) {
      throw new EvolutionError(
        "run_target_mismatch",
        `run ${runId} targets ${metadata.command}; expected ${expectedCommand}`,
      );
    }
    observations.push(observationFromEvents(input.store, runId, events));
  }

  const failureClasses = emptyFailureClasses();
  const errorCodes: Record<string, number> = {};
  for (const observation of observations) {
    if (observation.status === "failed") {
      failureClasses[observation.failure_class] += 1;
    }
    if (observation.error?.code) {
      errorCodes[observation.error.code] =
        (errorCodes[observation.error.code] ?? 0) + 1;
    }
  }

  return {
    schema_version: "unicli.evidence-packet.v1",
    packet_id: `evidence-${randomUUID()}`,
    created_at: input.createdAt ?? new Date().toISOString(),
    component: { ...input.component },
    scope: {
      ...input.scope,
      model_affinity: [...input.scope.model_affinity],
    },
    sources: observations,
    summary: {
      runs: observations.length,
      completed: observations.filter((entry) => entry.status === "completed")
        .length,
      failed: observations.filter((entry) => entry.status === "failed").length,
      failure_classes: failureClasses,
      error_codes: Object.fromEntries(
        Object.entries(errorCodes).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    },
  };
}

function observationFromEvents(
  store: RunStore,
  runId: string,
  events: RunEvent[],
): EvidenceRunObservation {
  const summary = summarizeRunEvents(events, { runId });
  const metadata = events[0]?.metadata;
  const error = extractError(events);
  const environmentEvent = events.find(
    (event) => event.name === "environment.snapshot",
  );
  const environment = environmentEvent?.data
    ? safeEnvironment(environmentEvent.data)
    : undefined;
  return {
    run_id: runId,
    raw_trace_ref: runTracePath(store, runId),
    command: metadata?.command ?? summary.command ?? "unknown",
    status: summary.status,
    ...(metadata?.args_hash ? { args_hash: metadata.args_hash } : {}),
    ...(summary.started_at ? { started_at: summary.started_at } : {}),
    ...(summary.finished_at ? { finished_at: summary.finished_at } : {}),
    ...(summary.duration_ms !== undefined
      ? { duration_ms: summary.duration_ms }
      : {}),
    evidence_count: summary.evidence_count,
    evidence_by_type: { ...summary.evidence_by_type },
    ...(environment && Object.keys(environment).length > 0
      ? { environment }
      : {}),
    ...(error ? { error } : {}),
    failure_class: classifyFailure(error),
  };
}

function extractError(events: RunEvent[]): EvidenceError | undefined {
  for (const event of [...events].reverse()) {
    if (event.name !== "run.failed" && event.name !== "tool.call.failed") {
      continue;
    }
    const value = event.data?.error;
    if (!isRecord(value) || typeof value.code !== "string") continue;
    return {
      code: value.code,
      ...(typeof value.message === "string"
        ? { message: redact(value.message).slice(0, 2_000) }
        : {}),
      ...(typeof value.step === "number" && Number.isFinite(value.step)
        ? { step: value.step }
        : {}),
      ...(typeof value.stage === "string"
        ? { stage: value.stage.slice(0, 200) }
        : {}),
      ...(typeof value.suggestion === "string"
        ? { suggestion: redact(value.suggestion).slice(0, 2_000) }
        : {}),
      ...(typeof value.retryable === "boolean"
        ? { retryable: value.retryable }
        : {}),
    };
  }
  return undefined;
}

function classifyFailure(error?: EvidenceError): EvidenceFailureClass {
  switch (error?.code) {
    case "selector_miss":
    case "quarantined":
    case "invalid_input":
      return "adapter_behavior";
    case "auth_required":
    case "not_authenticated":
    case "challenge_required":
      return "authentication_context";
    case "permission_denied":
      return "permission_policy";
    case "network_error":
    case "rate_limited":
    case "upstream_error":
    case "api_error":
      return "upstream_environment";
    case "internal_error":
      return "verification_contract";
    default:
      return "unknown";
  }
}

function safeEnvironment(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = [
    "schema_version",
    "unicli_version",
    "node_version",
    "platform",
    "arch",
    "ci",
    "permission_profile",
    "transport_surface",
    "target_surface",
    "pipeline_steps",
  ];
  return Object.fromEntries(
    allowed
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, value[key]]),
  );
}

function redact(value: string): string {
  return value
    .replace(
      /([?&](?:token|key|secret|password|auth)=)[^&#\s]+/gi,
      "$1<redacted>",
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, "$1 <redacted>")
    .replace(
      /\b(token|api[_-]?key|secret|password|cookie|authorization)\s*[:=]\s*[^\s,;&]+/gi,
      "$1=<redacted>",
    );
}

function emptyFailureClasses(): Record<EvidenceFailureClass, number> {
  return {
    adapter_behavior: 0,
    authentication_context: 0,
    permission_policy: 0,
    upstream_environment: 0,
    verification_contract: 0,
    unknown: 0,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
