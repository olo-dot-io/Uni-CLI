/**
 * Strategy cascade — auto-probe authentication strategies.
 *
 * Tries strategies in order: PUBLIC -> COOKIE -> HEADER
 * INTERCEPT and UI require explicit site configuration.
 *
 * Probe mechanism: make a test fetch with each strategy,
 * first valid (non-error, non-empty) response wins.
 */

import { loadCookies, formatCookieHeader } from "./cookies.js";
import { USER_AGENT } from "../constants.js";

/** Strategy probe order — auto-probeable strategies only */
const CASCADE_ORDER = ["public", "cookie", "header"] as const;

/** Cache of resolved strategies per site */
const strategyCache = new Map<
  string,
  { strategy: string; confidence: number }
>();

interface ProbeResult {
  strategy: string;
  confidence: number;
  success: boolean;
}

/**
 * Build headers for a given strategy.
 */
function buildHeaders(strategy: string, site: string): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
  };

  if (strategy === "public") {
    return headers;
  }

  if (strategy === "cookie" || strategy === "header") {
    const cookies = loadCookies(site);
    if (cookies) {
      headers["Cookie"] = formatCookieHeader(cookies);
    }
  }

  if (strategy === "header") {
    // Extract CSRF token from cookies — common patterns
    const cookies = loadCookies(site);
    if (cookies) {
      const csrfKeys = [
        "ct0",
        "csrf_token",
        "_csrf",
        "x-csrf-token",
        "bili_jct",
      ];
      for (const key of csrfKeys) {
        if (cookies[key]) {
          headers["X-Csrf-Token"] = cookies[key];
          break;
        }
      }
    }
  }

  return headers;
}

/**
 * Probe a single strategy against a URL.
 */
async function probeStrategy(
  url: string,
  strategy: string,
  site: string,
): Promise<ProbeResult> {
  const confidence =
    1.0 -
    CASCADE_ORDER.indexOf(strategy as (typeof CASCADE_ORDER)[number]) * 0.1;

  try {
    const headers = buildHeaders(strategy, site);
    const resp = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(5000),
    });

    if (!resp.ok) {
      return { strategy, confidence, success: false };
    }

    const text = await resp.text();
    if (!text || text.length < 10) {
      return { strategy, confidence, success: false };
    }

    // Try to parse as JSON and check for API error codes
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      // Chinese API pattern: code !== 0 means error
      if (typeof json.code === "number" && json.code !== 0) {
        return { strategy, confidence, success: false };
      }
      // Empty data check
      if (json.data === null || json.data === undefined) {
        return { strategy, confidence, success: false };
      }
      if (Array.isArray(json.data) && json.data.length === 0) {
        return { strategy, confidence, success: false };
      }
    } catch {
      // Not JSON — might be HTML or text, still counts as success
    }

    return { strategy, confidence, success: true };
  } catch {
    return { strategy, confidence, success: false };
  }
}

/**
 * Run the cascade probe for a site.
 *
 * @param site - Site name (for cookie lookup)
 * @param probeUrl - URL to test against
 * @returns The best strategy and confidence, or null if all fail
 */
export async function cascadeProbe(
  site: string,
  probeUrl: string,
): Promise<{ strategy: string; confidence: number } | null> {
  // Check cache first
  const cached = strategyCache.get(site);
  if (cached) return cached;

  for (const strategy of CASCADE_ORDER) {
    const result = await probeStrategy(probeUrl, strategy, site);
    if (result.success) {
      const resolved = {
        strategy: result.strategy,
        confidence: result.confidence,
      };
      strategyCache.set(site, resolved);
      return resolved;
    }
  }

  return null;
}

/**
 * Get the resolved strategy for a site (from cache or explicit).
 * Falls back to the adapter's declared strategy if no probe URL available.
 */
export function getStrategy(site: string, declared?: string): string {
  const cached = strategyCache.get(site);
  if (cached) return cached.strategy;
  return declared ?? "public";
}

/**
 * Clear the strategy cache (useful for testing).
 */
export function clearCascadeCache(): void {
  strategyCache.clear();
}
