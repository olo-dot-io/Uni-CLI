import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { isTargetError } from "../../browser/target-errors.js";
import { AdapterType, Strategy, type IPage } from "../../types.js";
import { evaluateOperationPolicy } from "../operation-policy.js";
import {
  appendRunEvent,
  createRunStore,
  RunStoreError,
  type RunStore,
} from "../session/store.js";
import {
  createEvidenceCapturedEvent,
  createPermissionEvaluatedEvent,
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
  type TraceId,
} from "../session/events.js";
import { isRunRecordingEnabled } from "../session/run-loop.js";
import { userHome } from "../user-home.js";
import {
  captureBrowserEvidencePacket,
  installBrowserEvidenceHooks,
  type BrowserEvidencePacket,
} from "./evidence.js";

export interface BrowserActionEvidenceOptions {
  command: string;
  namespace: "browser" | "operate";
  action: string;
  workspace: string;
  args?: Record<string, unknown>;
  enabled?: boolean;
  approved?: boolean;
  permissionProfile?: string;
  runId?: RunId;
  traceId?: TraceId;
  store?: RunStore;
  screenshotDir?: string;
  watchdog?: BrowserActionWatchdogOptions;
}

type BrowserEvidencePhase = "before" | "after";
type BrowserEvidenceOutcome = "pending" | "success" | "failure";
export type BrowserMovementDimension =
  | "url"
  | "title"
  | "dom"
  | "screenshot"
  | "network"
  | "console";
export type BrowserActionWatchdogMode = "off" | "warn" | "error";

export interface BrowserActionWatchdogOptions {
  mode?: BrowserActionWatchdogMode;
  expectMovement?: boolean;
  requiredDimensions?: BrowserMovementDimension[];
}

interface BrowserActionMovement {
  url_changed: boolean;
  title_changed: boolean;
  dom_changed: boolean;
  screenshot_changed: boolean;
  network_count_delta: number;
  console_count_delta: number;
  changed_dimensions: BrowserMovementDimension[];
  no_observed_change: boolean;
}

interface BrowserActionWatchdogResult {
  mode: BrowserActionWatchdogMode;
  expected_movement: boolean;
  required_dimensions: BrowserMovementDimension[];
  observed_dimensions: BrowserMovementDimension[];
  passed: boolean;
  reason?: "no_observed_change" | "missing_required_dimensions";
  missing_dimensions?: BrowserMovementDimension[];
}

class BrowserActionWatchdogError extends Error {
  code = "no_observed_change";
  suggestion = "Inspect the browser state and retry with a fresh target.";

  constructor(readonly watchdog: BrowserActionWatchdogResult) {
    super("Browser action produced no observed page movement.");
    this.name = "BrowserActionWatchdogError";
  }
}

export function isBrowserActionEvidenceEnabled(enabled?: boolean): boolean {
  return isRunRecordingEnabled(enabled);
}

export async function withBrowserActionEvidence<T>(
  page: IPage,
  options: BrowserActionEvidenceOptions,
  action: () => Promise<T>,
): Promise<T> {
  if (!isBrowserActionEvidenceEnabled(options.enabled)) {
    return await action();
  }

  const store = options.store ?? createRunStore();
  const traceId = options.traceId ?? `trace-${randomUUID()}`;
  const metadata = metadataForBrowserAction(options, traceId);
  const sequence = createRunEventSequence();
  const warnings: string[] = [];

  await appendAll(
    store,
    [
      createRunStartedEvent(metadata, sequence),
      createToolCallStartedEvent(metadata, sequence, {
        action: options.action,
        workspace: options.workspace,
      }),
      createPermissionEvaluatedEvent(
        metadata,
        sequence,
        permissionEventData(options, metadata),
      ),
    ],
    warnings,
  );

  await installBrowserEvidenceHooks(page);
  const before = await captureEvidence(page, options, "before");
  await appendAll(
    store,
    [
      createEvidenceCapturedEvent(metadata, sequence, {
        evidence_type: "browser-operator",
        visibility: "internal",
        data: evidenceEventData(before, "before", "pending"),
        internal: before,
      }),
    ],
    warnings,
  );

  try {
    const result = await action();
    const after = await captureEvidence(page, options, "after");
    const movement = evidenceMovement(before, after);
    const watchdog = evaluateWatchdog(options, movement);
    if (watchdog.mode === "error" && !watchdog.passed) {
      const error = new BrowserActionWatchdogError(watchdog);
      await appendAll(
        store,
        [
          createEvidenceCapturedEvent(metadata, sequence, {
            evidence_type: "browser-operator",
            visibility: "internal",
            data: {
              ...evidenceEventData(after, "after", "failure"),
              movement,
              watchdog,
              error: errorData(error),
            },
            internal: after,
          }),
          createToolCallFailedEvent(metadata, sequence, {
            action: options.action,
            workspace: options.workspace,
            outcome: "failure",
            error: errorData(error),
          }),
          createRunFailedEvent(metadata, sequence, {
            action: options.action,
            workspace: options.workspace,
            outcome: "failure",
            error: errorData(error),
          }),
        ],
        warnings,
      );
      emitRunRecordWarnings(warnings);
      throw error;
    }

    await appendAll(
      store,
      [
        createEvidenceCapturedEvent(metadata, sequence, {
          evidence_type: "browser-operator",
          visibility: "internal",
          data: {
            ...evidenceEventData(after, "after", "success"),
            movement,
            ...watchdogEventData(watchdog),
          },
          internal: after,
        }),
        createToolCallCompletedEvent(metadata, sequence, {
          action: options.action,
          workspace: options.workspace,
          outcome: "success",
        }),
        createRunCompletedEvent(metadata, sequence, {
          action: options.action,
          workspace: options.workspace,
          outcome: "success",
        }),
      ],
      warnings,
    );
    emitRunRecordWarnings(warnings);
    return result;
  } catch (err) {
    if (err instanceof BrowserActionWatchdogError) throw err;
    const after = await captureEvidence(page, options, "after");
    const movement = evidenceMovement(before, after);
    const error = errorData(err);
    await appendAll(
      store,
      [
        createEvidenceCapturedEvent(metadata, sequence, {
          evidence_type: "browser-operator",
          visibility: "internal",
          data: {
            ...evidenceEventData(after, "after", "failure"),
            movement,
            error,
          },
          internal: after,
        }),
        createToolCallFailedEvent(metadata, sequence, {
          action: options.action,
          workspace: options.workspace,
          outcome: "failure",
          error,
        }),
        createRunFailedEvent(metadata, sequence, {
          action: options.action,
          workspace: options.workspace,
          outcome: "failure",
          error,
        }),
      ],
      warnings,
    );
    emitRunRecordWarnings(warnings);
    throw err;
  }
}

async function captureEvidence(
  page: IPage,
  options: BrowserActionEvidenceOptions,
  phase: BrowserEvidencePhase,
): Promise<BrowserEvidencePacket> {
  return await captureBrowserEvidencePacket(page, {
    action: `${options.action}.${phase}`,
    workspace: options.workspace,
    screenshotDir: options.screenshotDir ?? defaultScreenshotDir(),
  });
}

function metadataForBrowserAction(
  options: BrowserActionEvidenceOptions,
  traceId: TraceId,
): RunTraceMetadata {
  const [site, ...cmdParts] = options.command.split(".");
  return {
    run_id: options.runId ?? `run-${traceId}`,
    trace_id: traceId,
    command: options.command,
    site: site || options.namespace,
    cmd: cmdParts.join(".") || options.action,
    adapter_path: `src/commands/browser-operator.ts#${options.command}`,
    permission_profile: rawPermissionProfile(options.permissionProfile),
    transport_surface: "cli",
    target_surface: "web",
    args_hash: hashArgs(options.args ?? {}),
    pipeline_steps: 0,
  };
}

function permissionEventData(
  options: BrowserActionEvidenceOptions,
  metadata: RunTraceMetadata,
): Record<string, unknown> {
  const policy = evaluateOperationPolicy({
    site: metadata.site,
    command: metadata.cmd,
    description: `Browser operator ${options.action}`,
    adapterType: AdapterType.BROWSER,
    targetSurface: "web",
    strategy: Strategy.UI,
    browser: true,
    args: Object.keys(options.args ?? {}).map((name) => ({ name })),
    profile: options.permissionProfile,
    approved: options.approved,
  });
  return { ...policy };
}

function evidenceEventData(
  packet: BrowserEvidencePacket,
  phase: BrowserEvidencePhase,
  outcome: BrowserEvidenceOutcome,
): Record<string, unknown> {
  return {
    action: packet.action.replace(/\.(before|after)$/, ""),
    phase,
    outcome,
    workspace: packet.workspace,
    page_url: packet.page.url,
    partial: packet.partial,
    capture_scope: packet.capture_scope,
    dom_ref_count: packet.dom.ref_count,
    console_count: packet.console.count,
    console_error_count: packet.console.error_count,
    network_count: packet.network.count,
    screenshot_sha256: packet.screenshot.sha256,
    screenshot_path: packet.screenshot.path,
  };
}

function evidenceMovement(
  before: BrowserEvidencePacket,
  after: BrowserEvidencePacket,
): BrowserActionMovement {
  const networkCountDelta = after.network.count - before.network.count;
  const consoleCountDelta = after.console.count - before.console.count;
  const screenshotChanged = screenshotSha(before) !== screenshotSha(after);
  const changedDimensions: BrowserMovementDimension[] = [];
  if (before.page.url !== after.page.url) changedDimensions.push("url");
  if (before.page.title !== after.page.title) changedDimensions.push("title");
  if (before.dom.sha256 !== after.dom.sha256) changedDimensions.push("dom");
  if (screenshotChanged) changedDimensions.push("screenshot");
  if (networkCountDelta !== 0) changedDimensions.push("network");
  if (consoleCountDelta !== 0) changedDimensions.push("console");

  return {
    url_changed: before.page.url !== after.page.url,
    title_changed: before.page.title !== after.page.title,
    dom_changed: before.dom.sha256 !== after.dom.sha256,
    screenshot_changed: screenshotChanged,
    network_count_delta: networkCountDelta,
    console_count_delta: consoleCountDelta,
    changed_dimensions: changedDimensions,
    no_observed_change: changedDimensions.length === 0,
  };
}

function screenshotSha(packet: BrowserEvidencePacket): string | undefined {
  return packet.screenshot.sha256;
}

function evaluateWatchdog(
  options: BrowserActionEvidenceOptions,
  movement: BrowserActionMovement,
): BrowserActionWatchdogResult {
  const mode = options.watchdog?.mode ?? "off";
  const expectedMovement = options.watchdog?.expectMovement === true;
  const requiredDimensions = options.watchdog?.requiredDimensions ?? [];
  const missingDimensions = requiredDimensions.filter(
    (dimension) => !movement.changed_dimensions.includes(dimension),
  );
  const passed =
    !expectedMovement ||
    (!movement.no_observed_change && missingDimensions.length === 0);

  return {
    mode,
    expected_movement: expectedMovement,
    required_dimensions: requiredDimensions,
    observed_dimensions: movement.changed_dimensions,
    passed,
    ...(!passed
      ? {
          reason: movement.no_observed_change
            ? ("no_observed_change" as const)
            : ("missing_required_dimensions" as const),
        }
      : {}),
    ...(missingDimensions.length > 0
      ? { missing_dimensions: missingDimensions }
      : {}),
  };
}

function watchdogEventData(
  watchdog: BrowserActionWatchdogResult,
): Record<string, BrowserActionWatchdogResult> {
  return watchdog.mode === "off" ? {} : { watchdog };
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

function emitRunRecordWarnings(warnings: string[]): void {
  for (const warning of warnings) {
    process.stderr.write(`${warning}\n`);
  }
}

function errorData(err: unknown): Record<string, unknown> {
  if (isTargetError(err)) {
    return {
      code: err.detail.code,
      message: err.detail.message,
      ref: err.detail.ref,
      ...(err.detail.snapshot_age_ms !== undefined
        ? { snapshot_age_ms: err.detail.snapshot_age_ms }
        : {}),
      ...(err.detail.candidates !== undefined
        ? { candidates: err.detail.candidates }
        : {}),
    };
  }

  const tagged = err as Partial<{ code: string }>;
  return {
    ...(typeof tagged.code === "string" ? { code: tagged.code } : {}),
    message: err instanceof Error ? err.message : String(err),
  };
}

function defaultScreenshotDir(): string {
  return join(userHome(), ".unicli", "evidence", "browser");
}

function rawPermissionProfile(value?: string): string {
  const raw = value ?? process.env.UNICLI_PERMISSION_PROFILE;
  return raw && raw.trim().length > 0 ? raw.trim().toLowerCase() : "open";
}

function hashArgs(args: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(stableJson(args)).digest("hex")}`;
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
