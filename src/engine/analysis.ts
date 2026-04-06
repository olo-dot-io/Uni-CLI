/**
 * Shared Analysis Module — boolean endpoint filters + transparent sort keys.
 *
 * Replaces the numeric scoring approach with composable boolean predicates and
 * a tuple sort key, making ranking logic explicit and unit-testable.
 *
 * Reference: APISensor (NJU 2026), industry best practices.
 */

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/**
 * Returns the pathname component of a URL, or the full string for invalid URLs.
 */
function safePathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/**
 * Returns the hostname component of a URL, or the full string for invalid URLs.
 */
function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// isNoiseUrl
// ---------------------------------------------------------------------------

const NOISE_DOMAINS = [
  "google-analytics.com",
  "googletagmanager.com",
  "hotjar.com",
  "hotjar.io",
  "doubleclick.net",
  "connect.facebook.net",
  "facebook.com/tr",
  "sentry.io",
  "cdn.segment.com",
  "api.segment.io",
  "mixpanel.com",
  "amplitude.com",
  "newrelic.com",
  "datadoghq.com",
  "googlesyndication.com",
  "adservice.google.com",
  "clarity.ms",
  "intercom.io",
  "intercomassets.com",
  "crisp.chat",
  "hs-analytics.net",
  "hubspot.com",
  "tealiumiq.com",
  "tiqcdn.com",
];

const NOISE_PATH_PATTERNS = [
  /\/beacon(\/|$)/i,
  /\/pixel(\/|$)/i,
  /\/track(\/|$)/i,
  /\/collect(\/|$)/i,
  /\/analytics(\/|$)/i,
  /\/telemetry(\/|$)/i,
  /\/log(\/|$)/i,
  /\/event(\/|$)/i,
  /\/_next\/data\//i,
  /\/sockjs-node(\/|$)/i,
  /\.hot-update\./i,
];

/**
 * Returns true if the URL belongs to a known noise source: trackers, analytics
 * beacons, Next.js internals, or hot-reload endpoints.
 */
export function isNoiseUrl(url: string): boolean {
  // Domain check — match against hostname only to avoid false positives from
  // noise domain names appearing in query params or redirect paths.
  const hostname = safeHostname(url).toLowerCase();
  if (NOISE_DOMAINS.some((domain) => hostname.includes(domain))) {
    return true;
  }
  // Path pattern check — match against pathname only.
  const pathname = safePathname(url);
  return NOISE_PATH_PATTERNS.some((re) => re.test(pathname));
}

// ---------------------------------------------------------------------------
// isStaticResource
// ---------------------------------------------------------------------------

const STATIC_EXTENSIONS = new Set([
  ".js",
  ".css",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".ico",
  ".map",
  ".webp",
  ".avif",
]);

const STATIC_CONTENT_TYPE_PREFIXES = [
  "image/",
  "font/",
  "text/css",
  "application/javascript",
  "application/x-javascript",
  "text/javascript",
];

/**
 * Returns true if the URL or content-type indicates a static resource
 * (image, font, stylesheet, script, or source map).
 */
export function isStaticResource(url: string, contentType?: string): boolean {
  // Content-type takes precedence when provided
  if (contentType) {
    const ct = contentType.toLowerCase();
    if (STATIC_CONTENT_TYPE_PREFIXES.some((prefix) => ct.startsWith(prefix))) {
      return true;
    }
  }
  // Extension check on pathname
  try {
    const pathname = new URL(url).pathname;
    const dot = pathname.lastIndexOf(".");
    if (dot !== -1) {
      const ext = pathname.slice(dot).toLowerCase().split("?")[0];
      if (STATIC_EXTENSIONS.has(ext)) return true;
    }
  } catch {
    // malformed URL — try raw string
    const dot = url.lastIndexOf(".");
    if (dot !== -1) {
      const ext = url.slice(dot, dot + 10).toLowerCase().split(/[?#]/)[0];
      if (STATIC_EXTENSIONS.has(ext)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// isUsefulEndpoint
// ---------------------------------------------------------------------------

/**
 * Returns true if the endpoint appears to return useful structured data:
 * JSON content-type, 2xx status (when provided), and non-trivial body.
 */
export function isUsefulEndpoint(entry: {
  url: string;
  status?: number;
  contentType?: string;
  body?: unknown;
}): boolean {
  const { status, contentType, body } = entry;

  // Must have JSON content-type
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  if (
    !ct.includes("application/json") &&
    !ct.includes("text/json") &&
    !ct.includes("+json")
  ) {
    return false;
  }

  // Status must be 2xx if provided
  if (status !== undefined && (status < 200 || status >= 300)) {
    return false;
  }

  // Body must be non-trivial
  if (body === null || body === undefined) return false;
  if (typeof body !== "object") return false;

  // Reject empty object
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.length === 0) return false;

  // Reject trivial status-only responses: {status: "ok"} or {success: true}
  if (keys.length === 1 && (keys[0] === "status" || keys[0] === "success")) {
    return false;
  }
  if (
    keys.length === 2 &&
    keys.includes("status") &&
    keys.includes("success")
  ) {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// endpointSortKey
// ---------------------------------------------------------------------------

const TOP_LEVEL_ARRAY_FIELDS = new Set([
  "data",
  "items",
  "results",
  "list",
  "records",
  "entries",
  "rows",
  "hits",
  "posts",
  "articles",
  "comments",
]);

/**
 * Returns a 4-tuple sort key for transparent, deterministic endpoint ranking.
 *
 * Tuple: [itemCount, fieldCount, isApiPath, hasParams]
 *
 * Sort descending on all dimensions (higher = better).
 */
export function endpointSortKey(entry: {
  url: string;
  body?: unknown;
}): [number, number, number, number] {
  const { url, body } = entry;

  let itemCount = 0;
  let fieldCount = 0;

  if (body !== null && body !== undefined) {
    if (Array.isArray(body)) {
      itemCount = body.length;
      if (
        body.length > 0 &&
        typeof body[0] === "object" &&
        body[0] !== null
      ) {
        fieldCount = Object.keys(body[0] as Record<string, unknown>).length;
      }
    } else if (typeof body === "object") {
      const obj = body as Record<string, unknown>;
      const topKeys = Object.keys(obj);
      fieldCount = topKeys.length;
      // Check for a top-level array field with a well-known name
      for (const key of topKeys) {
        if (TOP_LEVEL_ARRAY_FIELDS.has(key) && Array.isArray(obj[key])) {
          itemCount = (obj[key] as unknown[]).length;
          break;
        }
      }
    }
  }

  // Test API path regex against pathname only to avoid false positives from
  // query params that happen to contain /api/ or /v1/.
  const isApiPath =
    /\/api\/|\/v[1-9]\d*\/|\/graphql\b/i.test(safePathname(url)) ? 1 : 0;

  let hasParams = 0;
  try {
    hasParams = new URL(url).search.length > 0 ? 1 : 0;
  } catch {
    hasParams = url.includes("?") ? 1 : 0;
  }

  return [itemCount, fieldCount, isApiPath, hasParams];
}

// ---------------------------------------------------------------------------
// detectCapability
// ---------------------------------------------------------------------------

interface CapabilityRule {
  urlPattern: RegExp;
  label: string;
}

const URL_CAPABILITY_RULES: CapabilityRule[] = [
  { urlPattern: /\/search(\/|$|\?)|\/query(\/|$|\?)/i, label: "search" },
  {
    urlPattern: /\/hot(\/|$|\?)|\/trending(\/|$|\?)|\/popular(\/|$|\?)|\/rank(\/|$|\?)|\/top(\/|$|\?)/i,
    label: "hot",
  },
  {
    urlPattern: /\/feed(\/|$|\?)|\/timeline(\/|$|\?)|\/stream(\/|$|\?)|\/latest(\/|$|\?)|\/new(\/|$|\?)/i,
    label: "feed",
  },
  {
    urlPattern: /\/profile(\/|$|\?)|\/user(\/|$|\?)|\/account(\/|$|\?)|\/me(\/|$|\?)/i,
    label: "profile",
  },
  {
    urlPattern: /\/comment(\/|$|\?)|\/reply(\/|$|\?)|\/review(\/|$|\?)/i,
    label: "comments",
  },
  {
    urlPattern: /\/detail(\/|$|\?)|\/article(\/|$|\?)|\/post(\/|$|\?)|\/item(\/|$|\?)|\/content(\/|$|\?)/i,
    label: "detail",
  },
  {
    urlPattern: /\/download(\/|$|\?)|\/media(\/|$|\?)|\/video(\/|$|\?)|\/audio(\/|$|\?)/i,
    label: "download",
  },
];

/**
 * Detect a capability label from the URL and optionally the body shape.
 *
 * URL patterns take priority. If no URL match, falls back to field-name
 * heuristics on the first item in an array body.
 */
export function detectCapability(
  url: string,
  body?: unknown,
): string | null {
  // URL-based detection (highest priority) — test against pathname only to
  // avoid false positives from capability keywords in query parameters.
  const pathname = safePathname(url);
  for (const rule of URL_CAPABILITY_RULES) {
    if (rule.urlPattern.test(pathname)) return rule.label;
  }

  // Body field heuristics
  if (body === null || body === undefined) return null;

  let firstItem: Record<string, unknown> | null = null;
  if (Array.isArray(body) && body.length > 0 && typeof body[0] === "object") {
    firstItem = body[0] as Record<string, unknown>;
  } else if (typeof body === "object") {
    const obj = body as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (
        Array.isArray(val) &&
        val.length > 0 &&
        typeof val[0] === "object"
      ) {
        firstItem = val[0] as Record<string, unknown>;
        break;
      }
    }
  }

  if (firstItem) {
    const fields = new Set(Object.keys(firstItem).map((k) => k.toLowerCase()));
    if (fields.has("title") && fields.has("url")) return "feed";
    if (fields.has("price") && fields.has("name")) return "product";
    if (fields.has("author") && fields.has("content")) return "article";
  }

  return null;
}

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

/**
 * Format a duration in milliseconds into a human-readable string.
 *
 * - < 1000 ms  → "42ms"
 * - < 60000 ms → "3.2s"
 * - else       → "1m 23s"
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}
