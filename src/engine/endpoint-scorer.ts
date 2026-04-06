/**
 * Endpoint Scorer — thin facade over src/engine/analysis.ts.
 *
 * The numeric scoring approach has been replaced with composable boolean
 * predicates and a tuple sort key from analysis.ts. This file re-exports
 * those functions and provides deduplication and annotation utilities.
 *
 * Used by `unicli explore`, `unicli synthesize`, and `unicli generate`.
 */

import {
  isNoiseUrl,
  isStaticResource,
  isUsefulEndpoint,
  endpointSortKey,
  detectCapability as _detectCapability,
} from "./analysis.js";

// Re-export analysis functions for consumers that import from endpoint-scorer
export {
  isNoiseUrl,
  isStaticResource,
  isUsefulEndpoint,
  endpointSortKey,
  detectCapability,
} from "./analysis.js";

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export interface EndpointEntry {
  url: string;
  method: string;
  status: number;
  contentType: string;
  responseBody?: string; // raw JSON string
  size: number;
}

/**
 * EndpointEntry augmented with derived analysis fields used downstream by
 * explore, synthesize, and generate commands.
 */
export interface ScoredEndpoint extends EndpointEntry {
  detectedFields: string[];
  capability?: string; // auto-detected: "trending", "search", "profile", etc.
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function urlPath(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

function extractFields(parsed: unknown): string[] {
  if (Array.isArray(parsed)) {
    if (
      parsed.length > 0 &&
      typeof parsed[0] === "object" &&
      parsed[0] !== null
    ) {
      return Object.keys(parsed[0] as Record<string, unknown>);
    }
    return [];
  }
  if (typeof parsed === "object" && parsed !== null) {
    return Object.keys(parsed as Record<string, unknown>);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Annotate an EndpointEntry with detected fields and capability label.
 * Replaces the old numeric scoreEndpoint() function.
 */
export function annotateEndpoint(entry: EndpointEntry): ScoredEndpoint {
  let parsed: unknown;
  if (entry.responseBody) {
    try {
      parsed = JSON.parse(entry.responseBody);
    } catch {
      // malformed JSON — skip body analysis
    }
  }

  const detectedFields = parsed !== undefined ? extractFields(parsed) : [];
  const capabilityResult = _detectCapability(entry.url, parsed);

  return {
    ...entry,
    detectedFields,
    ...(capabilityResult != null ? { capability: capabilityResult } : {}),
  };
}

/**
 * Deduplicate a list of endpoint entries, keeping one entry per URL path
 * (origin + pathname, ignoring query string and fragment).
 *
 * When multiple entries share the same path, preference is given to entries
 * with a JSON content-type, a 200 status, and a larger response body.
 */
export function deduplicateEndpoints(
  entries: EndpointEntry[],
): EndpointEntry[] {
  const preference = (e: EndpointEntry): number => {
    let p = 0;
    if (e.contentType.toLowerCase().includes("json")) p += 10;
    if (e.status === 200) p += 5;
    p += Math.min(e.size / 100, 5); // up to +5 for size
    return p;
  };

  const best = new Map<string, EndpointEntry>();
  for (const entry of entries) {
    const path = urlPath(entry.url);
    const existing = best.get(path);
    if (!existing || preference(entry) > preference(existing)) {
      best.set(path, entry);
    }
  }

  return Array.from(best.values());
}

/**
 * Filter, sort, annotate, and deduplicate a list of raw endpoint entries.
 *
 * Filter: removes noise URLs and static resources.
 * Sort: uses endpointSortKey (4-tuple: itemCount, fieldCount, isApiPath, hasParams).
 * Annotate: adds detectedFields and capability to each entry.
 * Deduplicate: keeps one entry per URL path.
 */
export function processEndpoints(entries: EndpointEntry[]): ScoredEndpoint[] {
  // Parse bodies once for reuse in filtering and sorting
  const withParsed: Array<{ entry: EndpointEntry; parsed: unknown }> =
    entries.map((entry) => {
      let parsed: unknown;
      if (entry.responseBody) {
        try {
          parsed = JSON.parse(entry.responseBody);
        } catch {
          // ignore
        }
      }
      return { entry, parsed };
    });

  // Filter out noise and static resources; keep only useful endpoints
  const filtered = withParsed.filter(({ entry, parsed }) => {
    if (isNoiseUrl(entry.url)) return false;
    if (isStaticResource(entry.url, entry.contentType)) return false;
    return isUsefulEndpoint({
      url: entry.url,
      status: entry.status,
      contentType: entry.contentType,
      body: parsed,
    });
  });

  // Sort by endpointSortKey descending
  filtered.sort((a, b) => {
    const ka = endpointSortKey({ url: a.entry.url, body: a.parsed });
    const kb = endpointSortKey({ url: b.entry.url, body: b.parsed });
    for (let i = 0; i < 4; i++) {
      if (kb[i] !== ka[i]) return kb[i] - ka[i];
    }
    return 0;
  });

  // Annotate and deduplicate
  const seen = new Set<string>();
  const results: ScoredEndpoint[] = [];

  for (const { entry } of filtered) {
    const path = urlPath(entry.url);
    if (seen.has(path)) continue;
    seen.add(path);
    results.push(annotateEndpoint(entry));
  }

  return results;
}
