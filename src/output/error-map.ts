/**
 * @owner       src::output::error-map
 * @does        Maps caught failures, including nested outcome ambiguity, into stable AgentError fields and exit codes.
 * @needs       pipeline, browser bridge/target, contained-process error contracts, auth guidance
 * @feeds       kernel envelopes and every CLI/MCP/ACP error renderer
 * @breaks      Flattening structured runtime truth can make agents retry an already-committed mutation.
 * @invariants  Nested outcome ambiguity is non-retryable and retains operation/target usability metadata across AggregateError boundaries.
 */

import { PipelineError } from "../engine/executor.js";
import { BridgeConnectionError } from "../browser/bridge.js";
import { isTargetError } from "../browser/target-errors.js";
import { ExitCode } from "../types.js";
import { findOperationOutcomeAmbiguousError } from "../transport/contained-process.js";
import {
  authFailureSuggestion,
  challengeFailureSuggestion,
} from "./auth-guidance.js";

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

type ActionableError = Error & {
  code?: string;
  suggestion?: string;
  retryable?: boolean;
  alternatives?: string[];
  adapter_path?: string;
  step?: number;
  outcome_ambiguous?: true;
  partial_success?: true;
  mutation_receipts?: {
    successful_count: number;
    failed_count: number;
    truncated: boolean;
    successful: unknown[];
    failed: unknown[];
  };
  stage?: string;
};

export interface ErrorTaxonomyEntry {
  exitCode: number;
  retryable: boolean;
}

/**
 * The single code → process-semantics table used by every error class.
 * Message inspection may classify legacy untyped ingress, but it never
 * independently selects an exit code or retry policy.
 */
export const ERROR_TAXONOMY: Readonly<Record<string, ErrorTaxonomyEntry>> =
  Object.freeze({
    internal_error: { exitCode: ExitCode.GENERIC_ERROR, retryable: false },
    invalid_input: { exitCode: ExitCode.USAGE_ERROR, retryable: false },
    empty_result: { exitCode: ExitCode.EMPTY_RESULT, retryable: false },
    not_found: { exitCode: ExitCode.EMPTY_RESULT, retryable: false },
    auth_required: { exitCode: ExitCode.AUTH_REQUIRED, retryable: false },
    challenge_required: { exitCode: ExitCode.AUTH_REQUIRED, retryable: false },
    permission_denied: { exitCode: ExitCode.AUTH_REQUIRED, retryable: false },
    config_error: { exitCode: ExitCode.CONFIG_ERROR, retryable: false },
    unknown_action: { exitCode: ExitCode.CONFIG_ERROR, retryable: false },
    network_error: { exitCode: ExitCode.TEMP_FAILURE, retryable: true },
    timeout: { exitCode: ExitCode.TEMP_FAILURE, retryable: true },
    rate_limited: { exitCode: ExitCode.TEMP_FAILURE, retryable: true },
    upstream_error: {
      exitCode: ExitCode.SERVICE_UNAVAILABLE,
      retryable: true,
    },
    service_unavailable: {
      exitCode: ExitCode.SERVICE_UNAVAILABLE,
      retryable: true,
    },
    background_unavailable: {
      exitCode: ExitCode.SERVICE_UNAVAILABLE,
      retryable: true,
    },
    cdp_unavailable: {
      exitCode: ExitCode.SERVICE_UNAVAILABLE,
      retryable: true,
    },
    browser_broker_unavailable: {
      exitCode: ExitCode.SERVICE_UNAVAILABLE,
      retryable: true,
    },
    remote_browser_unavailable: {
      exitCode: ExitCode.CONFIG_ERROR,
      retryable: false,
    },
    remote_browser_configuration_invalid: {
      exitCode: ExitCode.CONFIG_ERROR,
      retryable: false,
    },
    remote_browser_endpoint_unsupported: {
      exitCode: ExitCode.CONFIG_ERROR,
      retryable: false,
    },
    remote_browser_connect_failed: {
      exitCode: ExitCode.SERVICE_UNAVAILABLE,
      retryable: true,
    },
    remote_browser_target_not_found: {
      exitCode: ExitCode.EMPTY_RESULT,
      retryable: false,
    },
    remote_browser_shutdown_failed: {
      exitCode: ExitCode.SERVICE_UNAVAILABLE,
      retryable: false,
    },
    operation_outcome_ambiguous: {
      exitCode: ExitCode.GENERIC_ERROR,
      retryable: false,
    },
    partial_mutation: {
      exitCode: ExitCode.GENERIC_ERROR,
      retryable: false,
    },
    PATENT_AUTH_REQUIRED: {
      exitCode: ExitCode.AUTH_REQUIRED,
      retryable: false,
    },
    PATENT_RATE_LIMIT: {
      exitCode: ExitCode.TEMP_FAILURE,
      retryable: true,
    },
    PATENT_NOT_FOUND: {
      exitCode: ExitCode.EMPTY_RESULT,
      retryable: false,
    },
    PATENT_API_DEPRECATED: {
      exitCode: ExitCode.SERVICE_UNAVAILABLE,
      retryable: false,
    },
    PATENT_REGION_BLOCKED: {
      exitCode: ExitCode.AUTH_REQUIRED,
      retryable: false,
    },
    PATENT_INVALID_NUMBER: {
      exitCode: ExitCode.USAGE_ERROR,
      retryable: false,
    },
    PATENT_FAMILY_BROKER_DOWN: {
      exitCode: ExitCode.SERVICE_UNAVAILABLE,
      retryable: true,
    },
    PATENT_BROWSER_CAPTCHA: {
      exitCode: ExitCode.AUTH_REQUIRED,
      retryable: false,
    },
    PATENT_UNSUPPORTED_QUERY: {
      exitCode: ExitCode.USAGE_ERROR,
      retryable: false,
    },
    PATENT_SCHEMA_DRIFT: {
      exitCode: ExitCode.CONFIG_ERROR,
      retryable: false,
    },
  });

function taxonomyFor(code: string): ErrorTaxonomyEntry {
  return ERROR_TAXONOMY[code] ?? ERROR_TAXONOMY.internal_error;
}

function isAuthMessage(message: string): boolean {
  return /(?:\bHTTP\s+(?:401|403)\b|\bunauthori[sz]ed\b|\bforbidden\b|\bnot[_ -]?authenticated\b|\bauth[_ -]?required\b|No cookies found|auth setup)/i.test(
    message,
  );
}

function isNotFoundMessage(message: string): boolean {
  return /(?:\bHTTP\s+404\b|\b404\s+Not Found\b|\bstatus(?:\s+code)?\s*[:=]?\s*404\b)/i.test(
    message,
  );
}

function isRateLimitMessage(message: string): boolean {
  return /(?:\bHTTP\s+429\b|\b429\s+Too Many Requests\b|\brate[- _]?limit(?:ed|ing)?\b)/i.test(
    message,
  );
}

function isChallengeMessage(message: string): boolean {
  return /captcha|cloudflare|challenge|verify you are human|human verification|risk.?control|风控|验证码|人机验证|安全验证/i.test(
    message,
  );
}

/**
 * Map a caught error to an AgentError code string following the self-repair
 * contract. Covers the most common pipeline / network / HTTP failure modes.
 */
export function errorTypeToCode(err: unknown): string {
  if (findOperationOutcomeAmbiguousError(err)) {
    return "operation_outcome_ambiguous";
  }
  if (isTargetError(err)) return err.detail.code;
  if (err instanceof PipelineError) {
    const { errorType, preserveErrorCode, statusCode } = err.detail;
    if (preserveErrorCode) return errorType;
    if (isChallengeMessage(err.message)) return "challenge_required";
    if (
      errorType === "auth_required" ||
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
    if (
      statusCode === 500 ||
      statusCode === 502 ||
      statusCode === 503 ||
      statusCode === 504
    )
      return "upstream_error";
    if (REF_LOCATOR_CODES.has(errorType)) return errorType;
    if (
      errorType === "invalid_input" ||
      errorType === "not_found" ||
      errorType === "config_error" ||
      errorType === "upstream_error" ||
      errorType === "rate_limited" ||
      errorType === "challenge_required"
    ) {
      return errorType;
    }
    if (errorType === "permission_denied") return "permission_denied";
    if (errorType === "selector_miss") return "selector_miss";
    if (errorType === "empty_result") return "empty_result";
    if (errorType === "network_error") return "network_error";
    if (errorType === "timeout") return "network_error";
    if (errorType === "unknown_action") return "unknown_action";
    return "internal_error";
  }
  if (err instanceof Error && typeof (err as ActionableError).code === "string")
    return (err as ActionableError).code!;
  const message = err instanceof Error ? err.message : String(err);
  if (isChallengeMessage(message)) return "challenge_required";
  if (
    /timeout|timed out|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|ECONNRESET|socket hang up|daemon failed/i.test(
      message,
    )
  )
    return "network_error";
  if (isAuthMessage(message)) return "auth_required";
  if (isNotFoundMessage(message)) return "not_found";
  if (isRateLimitMessage(message)) return "rate_limited";
  return "internal_error";
}

/** Map a caught error to the appropriate sysexits exit code. */
export function mapErrorToExitCode(err: unknown): number {
  if (err instanceof BridgeConnectionError) {
    return taxonomyFor(err.code).exitCode;
  }
  return taxonomyFor(errorTypeToCode(err)).exitCode;
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
  cmdName = "<command>",
  domain?: string,
): {
  adapter_path: string | undefined;
  step: number | undefined;
  suggestion: string;
  retryable: boolean;
  alternatives: string[];
  outcome_ambiguous?: true;
  partial_success?: true;
  mutation_receipts?: ActionableError["mutation_receipts"];
  target_unusable?: true;
  operation?: string;
  stage?: string;
} {
  const ambiguity = findOperationOutcomeAmbiguousError(err);
  if (ambiguity) {
    return {
      adapter_path: adapterPath,
      step: 0,
      suggestion: ambiguity.target_unusable
        ? "Discard the affected target, inspect external state from a fresh target, and do not replay the operation automatically."
        : "Inspect external state before deciding whether to issue a new operation; do not replay automatically.",
      retryable: false,
      alternatives: [],
      outcome_ambiguous: true,
      ...(ambiguity.target_unusable ? { target_unusable: true } : {}),
      ...(ambiguity.operation ? { operation: ambiguity.operation } : {}),
    };
  }
  if (isTargetError(err)) {
    return {
      adapter_path: adapterPath,
      step: 0,
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
      adapter_path: adapterPath,
      step: 0,
      suggestion: err.suggestion,
      retryable: err.retryable,
      alternatives: err.alternatives,
    };
  }
  const actionable =
    err instanceof Error ? (err as ActionableError) : undefined;
  const code = errorTypeToCode(err);
  return {
    adapter_path: actionable?.adapter_path ?? adapterPath,
    step: actionable?.step ?? 0,
    suggestion:
      actionable?.suggestion ??
      (code === "auth_required"
        ? authFailureSuggestion(siteName, cmdName, domain)
        : code === "challenge_required"
          ? challengeFailureSuggestion(siteName, cmdName, domain)
          : code === "rate_limited"
            ? "Retry after the upstream rate-limit window, reduce request frequency, or select another source."
            : `Run 'unicli test ${siteName}' to diagnose, or report this error.`),
    retryable: actionable?.retryable ?? taxonomyFor(code).retryable,
    alternatives: actionable?.alternatives ?? [],
    ...(actionable?.outcome_ambiguous
      ? { outcome_ambiguous: true as const }
      : {}),
    ...(actionable?.partial_success ? { partial_success: true as const } : {}),
    ...(actionable?.mutation_receipts
      ? { mutation_receipts: actionable.mutation_receipts }
      : {}),
    ...(actionable?.stage ? { stage: actionable.stage } : {}),
  };
}

/**
 * AgentError payload for an intent search that matched nothing.
 *
 * Shared by the commander search command and the fast-path discovery handler
 * so both surfaces dead-end agents with the same actionable fallback instead
 * of a bare "no results" line.
 */
export function emptySearchResultError(
  queryLabel: string,
  webSearchQuery: string,
): {
  code: string;
  message: string;
  suggestion: string;
  retryable: boolean;
  alternatives: string[];
} {
  return {
    code: "empty_result",
    message: `No commands matched: ${queryLabel}`,
    suggestion:
      "Rephrase with a site or domain word (e.g. 'twitter search', '股票行情'), or fall back to a generic web search.",
    retryable: false,
    alternatives: [
      ...(webSearchQuery ? [`unicli google search "${webSearchQuery}"`] : []),
      "unicli list --site <site>",
      "unicli list",
    ],
  };
}
