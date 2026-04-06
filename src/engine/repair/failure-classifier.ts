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
  preAction?: string;
}

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

  // Determine HTTP status from the error message if available
  const statusMatch = /\b(401|403|404|429)\b/.exec(
    repairContext.error.message,
  );
  const httpStatus = statusMatch ? Number(statusMatch[1]) : undefined;

  // Also check network requests for status codes
  const networkStatuses =
    repairContext.page?.networkRequests.map((r) => r.status) ?? [];

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
    httpStatus === 401 ||
    httpStatus === 403 ||
    networkStatuses.includes(401) ||
    networkStatuses.includes(403) ||
    message.includes("unauthorized") ||
    message.includes("forbidden") ||
    message.includes("login")
  ) {
    return {
      type: "auth_expired",
      guidance:
        "Authentication expired. The adapter needs fresh cookies or updated auth headers.",
      preAction: `npx unicli auth setup ${site}`,
    };
  }

  // 3. API versioned
  if (
    httpStatus === 404 ||
    networkStatuses.includes(404) ||
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
    httpStatus === 429 ||
    networkStatuses.includes(429) ||
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
