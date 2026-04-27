/**
 * Error-to-envelope mapping helpers.
 *
 * Translates caught exceptions into the fields required by the v2 AgentError
 * envelope (`code`, `adapter_path`, `step`, `suggestion`, `retryable`,
 * `alternatives`) and into sysexits.h-style exit codes.
 *
 * Lives alongside `envelope.ts` because the output here is strictly envelope-
 * shaped — no dispatch-specific state. Extracted from `src/commands/dispatch.ts`
 * in v0.213.1 Task T4 to collapse the 7-way `err instanceof` ternary into one
 * call to `errorToAgentFields`.
 */

import { PipelineError } from "../engine/executor.js";
import { BridgeConnectionError } from "../browser/bridge.js";
import { isTargetError } from "../browser/target-errors.js";
import { ExitCode } from "../types.js";

/**
 * Ref-locator error codes that pass through to the v2 envelope verbatim
 * (TargetError.detail.code → PipelineError.detail.errorType → AgentError.code).
 * Centralised as a Set so adding a 4th code is a one-line change and can't
 * drift out of sync with target-errors.ts.
 */
export const REF_LOCATOR_CODES = new Set<string>([
  "stale_ref",
  "ambiguous",
  "ref_not_found",
]);

function isAuthMessage(message: string): boolean {
  return /401|403|auth|No cookies found|auth setup/i.test(message);
}

function isRetryableMessage(message: string): boolean {
  return /timeout|ETIMEDOUT|ECONNREFUSED|ECONNRESET|socket hang up|daemon failed|429|rate.?limit/i.test(
    message,
  );
}

/**
 * Map a caught error to an AgentError code string following the self-repair
 * contract. Covers the most common pipeline / network / HTTP failure modes.
 */
export function errorTypeToCode(err: unknown): string {
  if (isTargetError(err)) return err.detail.code;
  if (err instanceof PipelineError) {
    const { errorType, statusCode } = err.detail;
    if (
      statusCode === 401 ||
      statusCode === 403 ||
      (errorType === "http_error" &&
        (statusCode === 401 ||
          statusCode === 403 ||
          isAuthMessage(err.message)))
    )
      return "auth_required";
    if (statusCode === 404) return "not_found";
    if (statusCode === 429) return "rate_limited";
    if (REF_LOCATOR_CODES.has(errorType)) return errorType;
    if (errorType === "selector_miss") return "selector_miss";
    if (errorType === "empty_result") return "empty_result";
    if (errorType === "network_error") return "network_error";
    if (errorType === "timeout") return "network_error";
    return "internal_error";
  }
  const message = err instanceof Error ? err.message : String(err);
  if (
    /ETIMEDOUT|ENOTFOUND|ECONNREFUSED|ECONNRESET|socket hang up/i.test(message)
  )
    return "network_error";
  if (isAuthMessage(message)) return "auth_required";
  if (/404/i.test(message)) return "not_found";
  if (/429|rate.?limit/i.test(message)) return "rate_limited";
  return "internal_error";
}

/** Map a caught error to the appropriate sysexits exit code. */
export function mapErrorToExitCode(err: unknown): number {
  if (isTargetError(err)) return ExitCode.GENERIC_ERROR;
  if (err instanceof PipelineError) {
    const { errorType, statusCode } = err.detail;
    if (
      statusCode === 401 ||
      statusCode === 403 ||
      (errorType === "http_error" && isAuthMessage(err.message))
    )
      return ExitCode.AUTH_REQUIRED;
    if (errorType === "empty_result") return ExitCode.EMPTY_RESULT;
    if (errorType === "network_error" || errorType === "timeout") {
      return ExitCode.TEMP_FAILURE;
    }
    return ExitCode.GENERIC_ERROR;
  }
  if (err instanceof BridgeConnectionError) return ExitCode.SERVICE_UNAVAILABLE;
  const message = err instanceof Error ? err.message : String(err);
  if (
    /ETIMEDOUT|ENOTFOUND|ECONNREFUSED|ECONNRESET|socket hang up|daemon failed/i.test(
      message,
    )
  )
    return ExitCode.TEMP_FAILURE;
  return ExitCode.GENERIC_ERROR;
}

/**
 * Destructure a caught error into the AgentError payload fields.
 *
 * All three branches (PipelineError / BridgeConnectionError / generic Error)
 * produce the same shape; callers no longer need to re-case on the class.
 *
 * `adapterPath` is the full YAML path (e.g. `src/adapters/twitter/search.yaml`)
 * used to populate `adapter_path` on the PipelineError branch. `siteName` is
 * the bare adapter name (e.g. `twitter`) interpolated into the default-branch
 * `unicli test <site>` suggestion.
 */
export function errorToAgentFields(
  err: unknown,
  adapterPath: string,
  siteName: string,
): {
  adapter_path: string | undefined;
  step: number | undefined;
  suggestion: string;
  retryable: boolean;
  alternatives: string[];
} {
  if (isTargetError(err)) {
    return {
      adapter_path: undefined,
      step: undefined,
      suggestion:
        err.detail.code === "stale_ref"
          ? "Take a fresh browser state snapshot before retrying the action."
          : "Inspect the current browser state and choose an unambiguous ref.",
      retryable: err.detail.code === "stale_ref",
      alternatives: ["unicli browser state", "unicli operate state"],
    };
  }
  if (err instanceof PipelineError) {
    return {
      adapter_path: adapterPath,
      step: err.detail.step,
      suggestion: err.detail.suggestion,
      retryable:
        err.detail.retryable ?? errorTypeToCode(err) === "rate_limited",
      alternatives: err.detail.alternatives ?? [],
    };
  }
  if (err instanceof BridgeConnectionError) {
    return {
      adapter_path: undefined,
      step: undefined,
      suggestion: err.suggestion,
      retryable: err.retryable,
      alternatives: err.alternatives,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    adapter_path: undefined,
    step: undefined,
    suggestion: `Run 'unicli test ${siteName}' to diagnose, or report this error.`,
    retryable: isRetryableMessage(message),
    alternatives: [],
  };
}
