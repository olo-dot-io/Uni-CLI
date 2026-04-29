import { summarizeRunEvents, type RunSummary } from "./query.js";
import type { RunEvent, RunId, RunTraceMetadata } from "./types.js";

export type RunComparisonStatus = "match" | "diverged" | "unknown";
export type RunComparisonImpact = "behavior" | "context";

export interface RunComparisonCheck {
  name: string;
  impact: RunComparisonImpact;
  status: RunComparisonStatus;
  left?: unknown;
  right?: unknown;
}

export interface RunComparableResult {
  exit_code?: number;
  result_count?: number;
  error_code?: string;
  envelope_command?: string;
  has_error?: boolean;
  runtime_permission_denied?: RunComparableRuntimePermissionDenied;
}

export interface RunComparableRuntimePermissionDenied {
  action?: string;
  step?: number;
  rule_id?: string;
  resource_buckets?: string[];
}

export interface RunComparableEvidence {
  total: number;
  by_type: Record<string, number>;
}

export interface RunComparableSummary {
  run_id: RunId;
  command?: string;
  status: RunSummary["status"];
  args_hash?: string;
  permission_profile?: string;
  transport_surface?: string;
  target_surface?: string;
  browser_target_kind?: string;
  browser_tab_id?: number;
  browser_window_id?: number;
  browser_auth_state?: string;
  result: RunComparableResult;
  evidence: RunComparableEvidence;
}

export interface RunComparisonCounts {
  match: number;
  diverged: number;
  unknown: number;
}

export interface RunComparison {
  left_run_id: RunId;
  right_run_id: RunId;
  status: RunComparisonStatus;
  behavior: RunComparisonCounts;
  context: RunComparisonCounts;
  checks: RunComparisonCheck[];
  left: RunComparableSummary;
  right: RunComparableSummary;
}

function metadataFromEvents(events: RunEvent[]): RunTraceMetadata | undefined {
  return (
    events.find((event) => event.name === "tool.call.started")?.metadata ??
    events.find((event) => event.name === "run.started")?.metadata ??
    events[0]?.metadata
  );
}

interface ComparableEventScan {
  terminal?: RunEvent;
  toolTerminal?: RunEvent;
  resultEnvelope?: RunEvent;
  runtimePermissionDenied?: RunEvent;
}

function scanComparableEvents(events: RunEvent[]): ComparableEventScan {
  const scan: ComparableEventScan = {};
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      !scan.terminal &&
      (event.name === "run.completed" || event.name === "run.failed")
    ) {
      scan.terminal = event;
    }
    if (
      !scan.toolTerminal &&
      (event.name === "tool.call.completed" ||
        event.name === "tool.call.failed")
    ) {
      scan.toolTerminal = event;
    }
    if (
      !scan.resultEnvelope &&
      event.name === "evidence.captured" &&
      event.data?.evidence_type === "result-envelope"
    ) {
      scan.resultEnvelope = event;
    }
    if (
      !scan.runtimePermissionDenied &&
      event.name === "permission.runtime_denied"
    ) {
      scan.runtimePermissionDenied = event;
    }
    if (
      scan.terminal &&
      scan.toolTerminal &&
      scan.resultEnvelope &&
      scan.runtimePermissionDenied
    ) {
      break;
    }
  }
  return scan;
}

function numberField(
  field: string,
  ...events: Array<RunEvent | undefined>
): number | undefined {
  for (const event of events) {
    const value = event?.data?.[field];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function booleanField(
  field: string,
  ...events: Array<RunEvent | undefined>
): boolean | undefined {
  for (const event of events) {
    const value = event?.data?.[field];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function stringField(
  field: string,
  ...events: Array<RunEvent | undefined>
): string | undefined {
  for (const event of events) {
    const value = event?.data?.[field];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function errorCodeFromEvent(event?: RunEvent): string | undefined {
  const error = event?.data?.error;
  if (
    error !== null &&
    typeof error === "object" &&
    !Array.isArray(error) &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return undefined;
}

function stringArrayField(
  field: string,
  event?: RunEvent,
): string[] | undefined {
  const value = event?.data?.[field];
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((entry): entry is string => {
    return typeof entry === "string";
  });
  return values.length > 0 ? values : undefined;
}

function runtimePermissionDeniedFromEvent(
  event?: RunEvent,
): RunComparableRuntimePermissionDenied | undefined {
  if (!event) return undefined;
  const action = stringField("action", event);
  const step = numberField("step", event);
  const ruleId = stringField("rule_id", event);
  const resourceBuckets = stringArrayField("resource_buckets", event);

  return {
    ...(action ? { action } : {}),
    ...(step !== undefined ? { step } : {}),
    ...(ruleId ? { rule_id: ruleId } : {}),
    ...(resourceBuckets ? { resource_buckets: resourceBuckets } : {}),
  };
}

function evidenceSummary(events: RunEvent[]): RunComparableEvidence {
  const byType: Record<string, number> = {};
  for (const event of events) {
    if (event.name !== "evidence.captured") continue;
    const evidenceType =
      typeof event.data?.evidence_type === "string"
        ? event.data.evidence_type
        : "unknown";
    byType[evidenceType] = (byType[evidenceType] ?? 0) + 1;
  }
  return {
    total: Object.values(byType).reduce((sum, count) => sum + count, 0),
    by_type: byType,
  };
}

export function summarizeComparableRun(
  events: RunEvent[],
  runId: RunId,
): RunComparableSummary {
  const summary = summarizeRunEvents(events, { runId });
  const metadata = metadataFromEvents(events);
  const scan = scanComparableEvents(events);
  const { terminal, toolTerminal, resultEnvelope, runtimePermissionDenied } =
    scan;
  const exitCode = numberField(
    "exit_code",
    terminal,
    toolTerminal,
    resultEnvelope,
  );
  const resultCount = numberField(
    "result_count",
    terminal,
    toolTerminal,
    resultEnvelope,
  );
  const envelopeCommand = stringField("envelope_command", resultEnvelope);
  const hasError = booleanField("has_error", resultEnvelope);
  const errorCode =
    errorCodeFromEvent(terminal) ?? errorCodeFromEvent(toolTerminal);
  const runtimePermissionDeniedResult = runtimePermissionDeniedFromEvent(
    runtimePermissionDenied,
  );

  return {
    run_id: runId,
    command: summary.command,
    status: summary.status,
    ...(metadata?.args_hash ? { args_hash: metadata.args_hash } : {}),
    ...(metadata?.permission_profile
      ? { permission_profile: metadata.permission_profile }
      : {}),
    ...(summary.transport_surface
      ? { transport_surface: summary.transport_surface }
      : {}),
    ...(summary.target_surface
      ? { target_surface: summary.target_surface }
      : {}),
    ...(summary.browser_target_kind
      ? { browser_target_kind: summary.browser_target_kind }
      : {}),
    ...(typeof summary.browser_tab_id === "number"
      ? { browser_tab_id: summary.browser_tab_id }
      : {}),
    ...(typeof summary.browser_window_id === "number"
      ? { browser_window_id: summary.browser_window_id }
      : {}),
    ...(summary.browser_auth_state
      ? { browser_auth_state: summary.browser_auth_state }
      : {}),
    result: {
      ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
      ...(resultCount !== undefined ? { result_count: resultCount } : {}),
      ...(errorCode ? { error_code: errorCode } : {}),
      ...(envelopeCommand ? { envelope_command: envelopeCommand } : {}),
      ...(hasError !== undefined ? { has_error: hasError } : {}),
      ...(runtimePermissionDeniedResult
        ? { runtime_permission_denied: runtimePermissionDeniedResult }
        : {}),
    },
    evidence: evidenceSummary(events),
  };
}

function joinedBuckets(
  runtimePermissionDenied?: RunComparableRuntimePermissionDenied,
): string | undefined {
  return runtimePermissionDenied?.resource_buckets?.slice().sort().join(",");
}

function compareScalar(
  name: string,
  left: unknown,
  right: unknown,
  impact: RunComparisonImpact,
  options: { missingMeansMatch?: boolean } = {},
): RunComparisonCheck {
  if (left === undefined && right === undefined) {
    return {
      name,
      impact,
      status: options.missingMeansMatch === true ? "match" : "unknown",
    };
  }
  if (left === undefined || right === undefined) {
    return { name, impact, status: "unknown", left, right };
  }
  return {
    name,
    impact,
    status: Object.is(left, right) ? "match" : "diverged",
    left,
    right,
  };
}

function countChecks(
  checks: RunComparisonCheck[],
  impact: RunComparisonImpact,
): RunComparisonCounts {
  const scoped = checks.filter((check) => check.impact === impact);
  return {
    match: scoped.filter((check) => check.status === "match").length,
    diverged: scoped.filter((check) => check.status === "diverged").length,
    unknown: scoped.filter((check) => check.status === "unknown").length,
  };
}

function overallStatus(checks: RunComparisonCheck[]): RunComparisonStatus {
  const behavior = checks.filter((check) => check.impact === "behavior");
  if (behavior.some((check) => check.status === "diverged")) {
    return "diverged";
  }
  if (behavior.some((check) => check.status === "unknown")) {
    return "unknown";
  }
  return "match";
}

export function compareRunEvents(
  leftEvents: RunEvent[],
  rightEvents: RunEvent[],
  options: { leftRunId: RunId; rightRunId: RunId },
): RunComparison {
  const left = summarizeComparableRun(leftEvents, options.leftRunId);
  const right = summarizeComparableRun(rightEvents, options.rightRunId);
  const checks: RunComparisonCheck[] = [
    compareScalar("command", left.command, right.command, "behavior"),
    compareScalar("status", left.status, right.status, "behavior"),
    compareScalar("args_hash", left.args_hash, right.args_hash, "behavior"),
    compareScalar(
      "exit_code",
      left.result.exit_code,
      right.result.exit_code,
      "behavior",
    ),
    compareScalar(
      "result_count",
      left.result.result_count,
      right.result.result_count,
      "behavior",
    ),
    compareScalar(
      "error_code",
      left.result.error_code,
      right.result.error_code,
      "behavior",
      { missingMeansMatch: true },
    ),
    compareScalar(
      "result_envelope_has_error",
      left.result.has_error,
      right.result.has_error,
      "behavior",
    ),
    compareScalar(
      "runtime_permission_rule",
      left.result.runtime_permission_denied?.rule_id,
      right.result.runtime_permission_denied?.rule_id,
      "behavior",
      { missingMeansMatch: true },
    ),
    compareScalar(
      "runtime_permission_action",
      left.result.runtime_permission_denied?.action,
      right.result.runtime_permission_denied?.action,
      "behavior",
      { missingMeansMatch: true },
    ),
    compareScalar(
      "runtime_permission_step",
      left.result.runtime_permission_denied?.step,
      right.result.runtime_permission_denied?.step,
      "behavior",
      { missingMeansMatch: true },
    ),
    compareScalar(
      "runtime_permission_resource_buckets",
      joinedBuckets(left.result.runtime_permission_denied),
      joinedBuckets(right.result.runtime_permission_denied),
      "behavior",
      { missingMeansMatch: true },
    ),
    compareScalar(
      "permission_profile",
      left.permission_profile,
      right.permission_profile,
      "context",
    ),
    compareScalar(
      "transport_surface",
      left.transport_surface,
      right.transport_surface,
      "context",
    ),
    compareScalar(
      "target_surface",
      left.target_surface,
      right.target_surface,
      "context",
    ),
    compareScalar(
      "browser_target_kind",
      left.browser_target_kind,
      right.browser_target_kind,
      "context",
      { missingMeansMatch: true },
    ),
    compareScalar(
      "browser_tab_id",
      left.browser_tab_id,
      right.browser_tab_id,
      "context",
      { missingMeansMatch: true },
    ),
    compareScalar(
      "browser_window_id",
      left.browser_window_id,
      right.browser_window_id,
      "context",
      { missingMeansMatch: true },
    ),
    compareScalar(
      "browser_auth_state",
      left.browser_auth_state,
      right.browser_auth_state,
      "context",
      { missingMeansMatch: true },
    ),
  ];

  return {
    left_run_id: options.leftRunId,
    right_run_id: options.rightRunId,
    status: overallStatus(checks),
    behavior: countChecks(checks, "behavior"),
    context: countChecks(checks, "context"),
    checks,
    left,
    right,
  };
}
