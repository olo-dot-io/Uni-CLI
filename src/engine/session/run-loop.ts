import { createHash } from "node:crypto";
import { execute } from "../kernel/execute.js";
import type { Invocation, InvocationResult } from "../kernel/types.js";
import {
  evaluateOperationPolicy,
  InvalidPermissionProfileError,
  resolveOperationAdapterPath,
  resolveOperationTargetSurface,
} from "../operation-policy.js";
import type { OperationPolicy } from "../operation-policy.js";
import {
  appendRunEvent,
  createRunStore,
  type RunStore,
  RunStoreError,
} from "./store.js";
import {
  createPermissionEvaluatedEvent,
  createEvidenceCapturedEvent,
  createRunCompletedEvent,
  createRunEventSequence,
  createRunFailedEvent,
  createRunStartedEvent,
  createToolCallCompletedEvent,
  createToolCallFailedEvent,
  createToolCallStartedEvent,
  type RunEvent,
  type RunId,
  type RunTraceMetadata,
} from "./events.js";

export interface RunRecordingOptions {
  enabled?: boolean;
  store?: RunStore;
  runId?: RunId;
}

export function isRunRecordingEnabled(enabled?: boolean): boolean {
  if (enabled !== undefined) return enabled;
  return process.env.UNICLI_RECORD_RUN === "1";
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashArgs(args: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(stableJson(args)).digest("hex")}`;
}

function rawPermissionProfile(inv: Invocation): string {
  const raw = inv.permissionProfile ?? process.env.UNICLI_PERMISSION_PROFILE;
  return raw && raw.trim().length > 0 ? raw.trim().toLowerCase() : "open";
}

function metadataForInvocation(
  inv: Invocation,
  runId: RunId,
): RunTraceMetadata {
  const adapterPath = resolveOperationAdapterPath(
    inv.adapter.name,
    inv.cmdName,
    inv.command.adapter_path,
  );
  const targetSurface = resolveOperationTargetSurface({
    adapterType: inv.adapter.type,
    targetSurface: inv.command.target_surface,
  });

  return {
    run_id: runId,
    trace_id: inv.trace_id,
    command: `${inv.adapter.name}.${inv.cmdName}`,
    site: inv.adapter.name,
    cmd: inv.cmdName,
    adapter_path: adapterPath,
    permission_profile: rawPermissionProfile(inv),
    transport_surface: inv.surface,
    target_surface: targetSurface,
    args_hash: hashArgs(inv.bag.args),
    pipeline_steps: inv.command.pipeline?.length ?? 0,
  };
}

function evaluatePermissionForEvent(
  inv: Invocation,
  metadata: RunTraceMetadata,
): Record<string, unknown> {
  try {
    const policy: OperationPolicy = evaluateOperationPolicy({
      site: inv.adapter.name,
      command: inv.cmdName,
      description: inv.command.description,
      adapterType: inv.adapter.type,
      targetSurface: metadata.target_surface,
      strategy: inv.command.strategy ?? inv.adapter.strategy,
      browser: inv.adapter.browser === true || inv.command.browser === true,
      args: inv.command.adapterArgs,
      profile: inv.permissionProfile,
      approved: inv.approved,
    });
    return { ...policy };
  } catch (err) {
    if (err instanceof InvalidPermissionProfileError) {
      return {
        profile: metadata.permission_profile,
        effect: "unknown_write",
        risk: "high",
        approval_required: true,
        approved: false,
        enforcement: "needs_approval",
        reason: err.message,
        error: { code: "invalid_input", message: err.message },
      };
    }
    throw err;
  }
}

async function appendAll(
  store: RunStore,
  events: RunEvent[],
  warnings: string[],
): Promise<void> {
  for (const event of events) {
    try {
      await appendRunEvent(store, event);
    } catch (err) {
      const message =
        err instanceof RunStoreError || err instanceof Error
          ? err.message
          : String(err);
      warnings.push(`[run-record] ${message}`);
      return;
    }
  }
}

function successData(result: InvocationResult): Record<string, unknown> {
  return {
    exit_code: result.exitCode,
    result_count: result.results.length,
    duration_ms: result.durationMs,
    outcome: result.results.length === 0 ? "empty" : "success",
    envelope: result.envelope,
  };
}

function failureData(
  result: InvocationResult,
  metadata: RunTraceMetadata,
): Record<string, unknown> {
  const error =
    result.error === undefined
      ? undefined
      : {
          ...result.error,
          adapter_path: result.error.adapter_path ?? metadata.adapter_path,
        };
  return {
    exit_code: result.exitCode,
    result_count: result.results.length,
    duration_ms: result.durationMs,
    error,
    envelope: result.envelope,
  };
}

function evidenceData(
  result: InvocationResult,
  metadata: RunTraceMetadata,
): Record<string, unknown> {
  return {
    outcome:
      result.error === undefined
        ? result.results.length === 0
          ? "empty"
          : "success"
        : "failure",
    exit_code: result.exitCode,
    result_count: result.results.length,
    duration_ms: result.durationMs,
    adapter_path: metadata.adapter_path,
    envelope_command: result.envelope.command,
    has_error: result.error !== undefined,
  };
}

export async function executeWithRunRecording(
  inv: Invocation,
  options: RunRecordingOptions = {},
): Promise<InvocationResult> {
  if (!isRunRecordingEnabled(options.enabled)) {
    return execute(inv);
  }

  const store = options.store ?? createRunStore();
  const runId = options.runId ?? `run-${inv.trace_id}`;
  const metadata = metadataForInvocation(inv, runId);
  const sequence = createRunEventSequence();
  const warnings: string[] = [];

  await appendAll(
    store,
    [
      createRunStartedEvent(metadata, sequence),
      createToolCallStartedEvent(metadata, sequence),
      createPermissionEvaluatedEvent(
        metadata,
        sequence,
        evaluatePermissionForEvent(inv, metadata),
      ),
    ],
    warnings,
  );

  const result = await execute(inv);
  const terminalEvents =
    result.error === undefined
      ? [
          createToolCallCompletedEvent(metadata, sequence, successData(result)),
          createEvidenceCapturedEvent(metadata, sequence, {
            evidence_type: "result-envelope",
            visibility: "internal",
            data: evidenceData(result, metadata),
          }),
          createRunCompletedEvent(metadata, sequence, successData(result)),
        ]
      : [
          createToolCallFailedEvent(
            metadata,
            sequence,
            failureData(result, metadata),
          ),
          createEvidenceCapturedEvent(metadata, sequence, {
            evidence_type: "result-envelope",
            visibility: "internal",
            data: evidenceData(result, metadata),
          }),
          createRunFailedEvent(
            metadata,
            sequence,
            failureData(result, metadata),
          ),
        ];
  await appendAll(store, terminalEvents, warnings);
  result.warnings.push(...warnings);
  return result;
}
