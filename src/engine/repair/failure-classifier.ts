/**
 * Failure classifier for the self-repair loop.
 * Categorizes pipeline failures and provides targeted guidance.
 */

import type { RepairContext } from "../diagnostic.js";

export type FailureType =
  | "selector_miss"
  | "auth_expired"
  | "api_versioned"
  | "rate_limited"
  | "unknown";

export interface ClassifiedFailure {
  type: FailureType;
  guidance: string;
  preAction?: string[];
}

/**
 * Extract all HTTP error statuses (>= 400) from structured network request data.
 * Returns a Set of unique failing status codes.
 */
function extractStatusesFromContext(ctx?: {
  page?: {
    networkRequests?: Array<{ status?: number }>;
  };
}): Set<number> {
  const statuses = new Set<number>();
  if (!ctx?.page?.networkRequests) return statuses;
  for (const req of ctx.page.networkRequests) {
    if (req.status && req.status >= 400) statuses.add(req.status);
  }
  return statuses;
}

/**
 * Extract HTTP status code from an error message string.
 * Requires nearby HTTP context words to avoid false positives from
 * numbers like port numbers or IDs.
 */
const STATUS_PATTERN = /(?:status|http|response|code|error)[:\s]*(\d{3})\b/i;

function extractStatusFromMessage(message: string): number | null {
  const match = STATUS_PATTERN.exec(message);
  if (!match) return null;
  const code = Number(match[1]);
  return code >= 400 && code <= 599 ? code : null;
}

/** Pattern to detect API-style URL paths */
const API_PATH_PATTERN = /\/(api|v\d|graphql|rest|endpoint)\//i;

/**
 * Classify a pipeline failure from its RepairContext and return
 * targeted guidance for the repair agent.
 */
export function classifyFailure(
  repairContext: RepairContext,
): ClassifiedFailure {
  const message = repairContext.error.message.toLowerCase();
  const code = repairContext.error.code.toUpperCase();
  const site = repairContext.adapter.site;

  // Collect all failing HTTP statuses from structured data + message
  const networkStatuses = extractStatusesFromContext(repairContext);
  const messageStatus = extractStatusFromMessage(repairContext.error.message);
  if (messageStatus) networkStatuses.add(messageStatus);

  // 1. Selector miss
  if (
    code === "SELECTOR_MISS" ||
    message.includes("selector") ||
    message.includes("element not found") ||
    message.includes("not found in dom")
  ) {
    return {
      type: "selector_miss",
      guidance:
        "The CSS selector is broken. Read the DOM snapshot and find the correct selector. " +
        "Use the browser snapshot or page source to identify the new element structure.",
    };
  }

  // 2. Auth expired
  if (
    networkStatuses.has(401) ||
    networkStatuses.has(403) ||
    message.includes("unauthorized") ||
    message.includes("forbidden") ||
    message.includes("login")
  ) {
    return {
      type: "auth_expired",
      guidance:
        "Authentication expired. The adapter needs fresh cookies or updated auth headers.",
      preAction: ["npx", "unicli", "auth", "setup", site],
    };
  }

  // 3. API versioned — only classify 404 as api_versioned if URL looks like an API endpoint
  if (networkStatuses.has(404)) {
    if (
      repairContext.error.message &&
      API_PATH_PATTERN.test(repairContext.error.message)
    ) {
      return {
        type: "api_versioned",
        guidance:
          "The API endpoint or response shape has changed. " +
          "Inspect the current response and update the adapter URL, select path, or map fields.",
      };
    }
    // Generic 404 without API path — fall through to unknown
  }

  // 3b. Schema/shape changes
  if (
    message.includes("unexpected") ||
    message.includes("schema") ||
    message.includes("shape")
  ) {
    return {
      type: "api_versioned",
      guidance:
        "The API endpoint or response shape has changed. " +
        "Inspect the current response and update the adapter URL, select path, or map fields.",
    };
  }

  // 4. Rate limited
  if (
    networkStatuses.has(429) ||
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("throttle")
  ) {
    return {
      type: "rate_limited",
      guidance:
        "Rate limited. Add or increase wait/delay steps in the pipeline. " +
        "Consider adding a rate_limit step or increasing backoff intervals.",
    };
  }

  // 5. Unknown
  return {
    type: "unknown",
    guidance:
      "Unknown failure. Read the full error context, adapter source, and any available " +
      "page diagnostics to diagnose the root cause.",
  };
}
