/**
 * Envelope — the uniform result shape returned by every
 * `TransportAdapter.action()` call.
 *
 * Shape:
 *   { ok: true, data, elapsedMs? }
 *   { ok: false, error: { transport, step, action, reason, suggestion,
 *                         adapter_path?, diff_candidate?, minimum_capability?,
 *                         retryable, exit_code }, elapsedMs? }
 *
 * Sysexits codes (sysexits.h):
 *   0  SUCCESS
 *   1  GENERIC_ERROR
 *   2  USAGE_ERROR
 *   66 EMPTY_RESULT
 *   69 SERVICE_UNAVAILABLE  (EX_UNAVAILABLE)
 *   75 TEMP_FAILURE          (EX_TEMPFAIL)
 *   77 AUTH_REQUIRED         (EX_NOPERM)
 *   78 CONFIG_ERROR          (EX_CONFIG)
 */

import type { TransportKind } from "../transport/types.js";

/** Structured error carried inside a failed envelope. */
export interface EnvelopeError {
  transport: TransportKind;
  adapter_path?: string;
  step: number;
  action: string;
  reason: string;
  suggestion: string;
  minimum_capability?: string;
  diff_candidate?: string;
  retryable: boolean;
  exit_code: number;
}

/** Optional metadata fields the runner or orchestrator may attach. */
export interface EnvelopeMeta {
  elapsedMs?: number;
}

/** Success envelope — `data` is populated, `error` is absent. */
export interface EnvelopeOk<T> extends EnvelopeMeta {
  ok: true;
  data: T;
  error?: undefined;
}

/** Failure envelope — `error` is populated, `data` is absent. */
export interface EnvelopeErr extends EnvelopeMeta {
  ok: false;
  data?: undefined;
  error: EnvelopeError;
}

/** Discriminated union callers pattern-match on via `.ok`. */
export type Envelope<T = unknown> = EnvelopeOk<T> | EnvelopeErr;

/** Sysexits-aligned exit codes. Freeze for stability. */
export const EnvelopeExit = Object.freeze({
  SUCCESS: 0,
  GENERIC_ERROR: 1,
  USAGE_ERROR: 2,
  EMPTY_RESULT: 66,
  SERVICE_UNAVAILABLE: 69,
  TEMP_FAILURE: 75,
  AUTH_REQUIRED: 77,
  CONFIG_ERROR: 78,
} as const);

export type EnvelopeExitCode = (typeof EnvelopeExit)[keyof typeof EnvelopeExit];

/**
 * Map a short reason token to its sysexits code. Unknown tokens degrade to
 * GENERIC_ERROR so callers can always supply a code without branching.
 */
export function exitCodeFor(reason: string): EnvelopeExitCode {
  switch (reason) {
    case "success":
      return EnvelopeExit.SUCCESS;
    case "usage_error":
      return EnvelopeExit.USAGE_ERROR;
    case "empty_result":
      return EnvelopeExit.EMPTY_RESULT;
    case "service_unavailable":
    case "unavailable":
      return EnvelopeExit.SERVICE_UNAVAILABLE;
    case "temp_failure":
    case "timeout":
      return EnvelopeExit.TEMP_FAILURE;
    case "auth_required":
    case "auth":
      return EnvelopeExit.AUTH_REQUIRED;
    case "config_error":
    case "config":
      return EnvelopeExit.CONFIG_ERROR;
    default:
      return EnvelopeExit.GENERIC_ERROR;
  }
}

/** Build a success envelope. */
export function ok<T>(data: T, meta: EnvelopeMeta = {}): EnvelopeOk<T> {
  return {
    ok: true,
    data,
    ...(meta.elapsedMs !== undefined ? { elapsedMs: meta.elapsedMs } : {}),
  };
}

/** Input shape for {@link err}. All but five fields are optional. */
export interface ErrInput {
  transport: TransportKind;
  step: number;
  action: string;
  reason: string;
  suggestion: string;
  adapter_path?: string;
  diff_candidate?: string;
  minimum_capability?: string;
  retryable?: boolean;
  exit_code?: number;
}

/** Build a failure envelope. Missing fields get safe defaults. */
export function err(input: ErrInput, meta: EnvelopeMeta = {}): EnvelopeErr {
  const error: EnvelopeError = {
    transport: input.transport,
    step: input.step,
    action: input.action,
    reason: input.reason,
    suggestion: input.suggestion,
    retryable: input.retryable ?? false,
    exit_code: input.exit_code ?? EnvelopeExit.GENERIC_ERROR,
    ...(input.adapter_path !== undefined
      ? { adapter_path: input.adapter_path }
      : {}),
    ...(input.diff_candidate !== undefined
      ? { diff_candidate: input.diff_candidate }
      : {}),
    ...(input.minimum_capability !== undefined
      ? { minimum_capability: input.minimum_capability }
      : {}),
  };
  return {
    ok: false,
    error,
    ...(meta.elapsedMs !== undefined ? { elapsedMs: meta.elapsedMs } : {}),
  };
}
