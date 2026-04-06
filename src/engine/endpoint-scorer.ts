/**
 * Endpoint Scorer — ranks captured network endpoints by likelihood of
 * being primary data APIs worth turning into CLI adapters.
 *
 * Used by `unicli explore` to surface the most valuable endpoints from
 * a browser session's network traffic.
 */

export interface EndpointEntry {
  url: string;
  method: string;
  status: number;
  contentType: string;
  responseBody?: string; // raw JSON string
  size: number;
}

export interface ScoredEndpoint extends EndpointEntry {
  score: number;
  reasons: string[]; // human-readable reasons for score
  detectedFields: string[];
  capability?: string; // auto-detected: "trending", "search", "profile", etc.
}

// ---------------------------------------------------------------------------
// Tracking / analytics URL patterns to penalize
// ---------------------------------------------------------------------------

const TRACKING_PATTERNS = [
  /google[-_]?analytics/i,
  /googletagmanager/i,
  /fbevents?/i,
  /doubleclick/i,
  /hotjar/i,
  /sentry/i,
  /segment\.io/i,
  /mixpanel/i,
  /amplitude/i,
  /clarity\.ms/i,
  /plausible/i,
  /matomo/i,
  /newrelic/i,
  /datadog/i,
  /bugsnag/i,
  /logrocket/i,
];

// ---------------------------------------------------------------------------
// Non-data content type prefixes to penalize
// ---------------------------------------------------------------------------

const NON_DATA_TYPES = [
  "image/",
  "font/",
  "text/css",
  "text/javascript",
  "application/javascript",
];

// ---------------------------------------------------------------------------
// Capability detection patterns: [regex on url+fields, label]
// ---------------------------------------------------------------------------

interface CapabilityRule {
  pattern: RegExp;
  label: string;
}

const CAPABILITY_RULES: CapabilityRule[] = [
  { pattern: /hot|trending|rank|popular/i, label: "trending" },
  { pattern: /search|query|q=/i, label: "search" },
  { pattern: /profile|user|account|\/me\b/i, label: "profile" },
  { pattern: /detail|article|post\/|\/item/i, label: "detail" },
  { pattern: /comment|reply|review/i, label: "comments" },
  { pattern: /timeline|feed|stream/i, label: "timeline" },
  { pattern: /download|media|\/file/i, label: "download" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTrackingUrl(url: string): boolean {
  return TRACKING_PATTERNS.some((re) => re.test(url));
}

function isNonDataContentType(ct: string): boolean {
  const lower = ct.toLowerCase();
  return NON_DATA_TYPES.some((prefix) => lower.includes(prefix));
}

function hasApiPathPattern(url: string): boolean {
  return /\/api\//i.test(url) || /\/v\d+\//i.test(url);
}

function hasSearchParam(url: string): boolean {
  try {
    const params = new URL(url).searchParams;
    for (const key of params.keys()) {
      if (/^(search|query|q|keyword|keywords)$/i.test(key)) return true;
    }
  } catch {
    // malformed URL — no bonus
  }
  return false;
}

function hasPaginationParam(url: string): boolean {
  try {
    const params = new URL(url).searchParams;
    for (const key of params.keys()) {
      if (/^(page|offset|cursor|after|before|skip|start)$/i.test(key))
        return true;
    }
  } catch {
    // malformed URL — no bonus
  }
  return false;
}

function hasLimitParam(url: string): boolean {
  try {
    const params = new URL(url).searchParams;
    for (const key of params.keys()) {
      if (/^(limit|count|size|per_page|pageSize|page_size|num)$/i.test(key))
        return true;
    }
  } catch {
    // malformed URL — no bonus
  }
  return false;
}

/**
 * Extract field names from parsed JSON. For arrays, inspects the first item.
 * Returns a flat list of top-level keys.
 */
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

/**
 * Check whether the parsed body is an array with >0 items.
 */
function isNonEmptyArray(parsed: unknown): boolean {
  return Array.isArray(parsed) && parsed.length > 0;
}

/**
 * Check whether any top-level value in the parsed object is an array.
 */
function hasNestedArray(parsed: unknown): boolean {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return false;
  return Object.values(parsed as Record<string, unknown>).some(
    (v) => Array.isArray(v) && v.length > 0,
  );
}

/**
 * Extract the URL path, stripping query string and fragment.
 */
function urlPath(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect a capability label from the URL and detected field names.
 */
export function detectCapability(
  url: string,
  fields: string[],
): string | undefined {
  const combined = url + " " + fields.join(" ");
  for (const rule of CAPABILITY_RULES) {
    if (rule.pattern.test(combined)) return rule.label;
  }
  return undefined;
}

/**
 * Score a single endpoint entry. Higher = more likely a primary data API.
 */
export function scoreEndpoint(entry: EndpointEntry): ScoredEndpoint {
  let score = 0;
  const reasons: string[] = [];
  let detectedFields: string[] = [];
  let parsed: unknown = undefined;

  // --- Content-Type JSON ---
  if (entry.contentType.toLowerCase().includes("json")) {
    score += 10;
    reasons.push("+10 content-type json");
  }

  // --- Parse response body once ---
  if (entry.responseBody) {
    try {
      parsed = JSON.parse(entry.responseBody);
    } catch {
      // malformed JSON — no bonus from body parsing
    }
  }

  // --- Array response ---
  if (parsed !== undefined && isNonEmptyArray(parsed)) {
    score += 8;
    reasons.push("+8 response is non-empty array");
  }

  // --- Nested array field ---
  if (parsed !== undefined && hasNestedArray(parsed)) {
    score += 5;
    reasons.push("+5 response has nested array field");
  }

  // --- Detected fields ---
  if (parsed !== undefined) {
    detectedFields = extractFields(parsed);
    const fieldScore = Math.min(detectedFields.length * 2, 20);
    if (fieldScore > 0) {
      score += fieldScore;
      reasons.push(`+${fieldScore} detected ${detectedFields.length} fields`);
    }
  }

  // --- API URL pattern ---
  if (hasApiPathPattern(entry.url)) {
    score += 4;
    reasons.push("+4 url matches /api/ or /v[N]/");
  }

  // --- Search/query param ---
  if (hasSearchParam(entry.url)) {
    score += 3;
    reasons.push("+3 url has search/query param");
  }

  // --- Pagination param ---
  if (hasPaginationParam(entry.url)) {
    score += 2;
    reasons.push("+2 url has pagination param");
  }

  // --- Limit param ---
  if (hasLimitParam(entry.url)) {
    score += 2;
    reasons.push("+2 url has limit/count/size param");
  }

  // --- Status 200 ---
  if (entry.status === 200) {
    score += 2;
    reasons.push("+2 status 200");
  }

  // --- Tracking penalty ---
  if (isTrackingUrl(entry.url)) {
    score -= 5;
    reasons.push("-5 tracking/analytics url");
  }

  // --- Non-data content type penalty ---
  if (isNonDataContentType(entry.contentType)) {
    score -= 3;
    reasons.push("-3 non-data content-type");
  }

  // --- Empty/small body penalty ---
  if (!entry.responseBody || entry.size < 10) {
    score -= 3;
    reasons.push("-3 empty or small response body");
  }

  // --- Capability detection ---
  const capability = detectCapability(entry.url, detectedFields);

  return {
    ...entry,
    score,
    reasons,
    detectedFields,
    ...(capability ? { capability } : {}),
  };
}

/**
 * Score, sort (descending), and deduplicate a list of endpoints.
 * Deduplication keeps the highest-scored entry per URL path (ignoring query params).
 */
export function scoreEndpoints(entries: EndpointEntry[]): ScoredEndpoint[] {
  const scored = entries.map(scoreEndpoint);

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Deduplicate by URL path (keep first = highest score)
  const seen = new Set<string>();
  const deduped: ScoredEndpoint[] = [];
  for (const ep of scored) {
    const path = urlPath(ep.url);
    if (!seen.has(path)) {
      seen.add(path);
      deduped.push(ep);
    }
  }

  return deduped;
}
