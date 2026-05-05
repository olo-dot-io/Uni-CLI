/**
 * @owner   src/commands/adapter-authoring.ts
 * @does    Share pure adapter-authoring helpers for explore, generate, and synthesize command flows.
 * @needs   src/engine/endpoint-scorer types, URL parsing, JSON parsing
 * @feeds   src/commands/explore.ts, src/commands/generate.ts, src/commands/synthesize.ts, tests/unit/commands/adapter-authoring.test.ts
 * @breaks  Invalid URLs and malformed response bodies stay bounded to deterministic command names or empty select paths.
 */

import type {
  EndpointEntry,
  ScoredEndpoint,
} from "../engine/endpoint-scorer.js";

export interface CapturedEndpointRequest {
  url: string;
  data: unknown;
  method?: string;
  status?: number;
}

export interface AdapterAuthoringAuthInfo {
  strategy: "public" | "cookie" | "header";
  cookies: string[];
  csrfToken: boolean;
  notes: string[];
}

const AUTH_COOKIE_NAMES = [
  "session_id",
  "sessionid",
  "session",
  "token",
  "access_token",
  "auth_token",
  "jwt",
  "sid",
  "PHPSESSID",
  "connect.sid",
  "_session",
  "user_session",
  "login_token",
];

export function extractSiteName(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    return (
      hostname
        .replace(/^www\./, "")
        .split(".")
        .slice(0, -1)
        .join("-") || hostname
    );
  } catch {
    return "unknown";
  }
}

export function convertToEndpointEntries(
  requests: CapturedEndpointRequest[],
): EndpointEntry[] {
  const seen = new Set<string>();
  const entries: EndpointEntry[] = [];

  for (const req of requests) {
    let pathname: string;
    try {
      pathname = new URL(req.url).pathname;
    } catch {
      continue;
    }
    if (seen.has(pathname)) continue;
    seen.add(pathname);

    const bodyStr = req.data != null ? JSON.stringify(req.data) : "";

    entries.push({
      url: req.url,
      method: req.method ?? "GET",
      status: req.status ?? 200,
      contentType: "application/json",
      responseBody: bodyStr || undefined,
      size: bodyStr.length,
    });
  }

  return entries;
}

export function detectAuth(
  cookies: Record<string, string>,
): AdapterAuthoringAuthInfo {
  const notes: string[] = [];
  const authCookies: string[] = [];
  let csrfToken = false;

  for (const name of Object.keys(cookies)) {
    const lower = name.toLowerCase();
    if (AUTH_COOKIE_NAMES.some((pat) => lower.includes(pat.toLowerCase()))) {
      authCookies.push(name);
    }
    if (lower.includes("csrf") || lower.includes("xsrf")) {
      csrfToken = true;
      notes.push(`CSRF cookie detected: ${name}`);
    }
  }

  if (authCookies.length > 0) {
    notes.push(`Auth cookies: ${authCookies.join(", ")}`);
  }

  let strategy: AdapterAuthoringAuthInfo["strategy"] = "public";
  if (csrfToken) {
    strategy = "header";
    notes.push("Recommended strategy: header (CSRF token present)");
  } else if (authCookies.length > 0) {
    strategy = "cookie";
    notes.push("Recommended strategy: cookie");
  } else {
    notes.push("No auth detected - public API likely");
  }

  return { strategy, cookies: authCookies, csrfToken, notes };
}

export function pickStrategy(auth: AdapterAuthoringAuthInfo): string {
  if (auth.csrfToken) return "header";
  if (auth.cookies.length > 0) return "cookie";
  return "public";
}

export function deriveCommandName(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return "data";
  }

  const parts = pathname
    .replace(/^\/api\/(v\d+\/)?/, "")
    .replace(/\/$/, "")
    .split("/")
    .filter(Boolean);

  if (parts.length === 0) return "data";

  const name = parts
    .slice(-2)
    .join("-")
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();

  return name || "data";
}

export function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

function parseResponseBody(ep: ScoredEndpoint): unknown {
  try {
    return ep.responseBody ? JSON.parse(ep.responseBody) : undefined;
  } catch {
    return undefined;
  }
}

function getBaseUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}`;
  } catch {
    return url;
  }
}

function getPathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function pipelineMapLines(fields: string[]): string[] {
  if (fields.length === 0) return [];
  const lines = ["  - map:"];
  for (const field of fields) {
    lines.push(`      ${field}: "\${{ item.${field} }}"`);
  }
  return lines;
}

function pipelineSelectLine(selectPath: string): string[] {
  return selectPath ? [`  - select: "${selectPath}"`] : [];
}

function buildApiPipeline(
  ep: ScoredEndpoint,
  strategy: string,
  selectPath: string,
  fields: string[],
): string[] {
  return [
    "type: web-api",
    `strategy: ${strategy}`,
    "pipeline:",
    "  - fetch:",
    `      url: "${ep.url}"`,
    ...pipelineSelectLine(selectPath),
    ...pipelineMapLines(fields),
    `  - limit: "\${{ args.limit | default(20) }}"`,
  ];
}

function buildBrowserPipeline(
  ep: ScoredEndpoint,
  selectPath: string,
  fields: string[],
): string[] {
  return [
    "type: browser",
    "strategy: intercept",
    "pipeline:",
    "  - navigate:",
    `      url: "${getBaseUrl(ep.url)}"`,
    "      settleMs: 2000",
    "  - intercept:",
    `      pattern: "${getPathname(ep.url)}"`,
    "      wait: 5000",
    ...pipelineSelectLine(selectPath),
    ...pipelineMapLines(fields),
    `  - limit: "\${{ args.limit | default(20) }}"`,
  ];
}

function detectSelectPath(body: unknown): string {
  if (body == null) return "";
  if (Array.isArray(body)) return "";

  if (typeof body === "object") {
    const obj = body as Record<string, unknown>;
    for (const [key, val] of Object.entries(obj)) {
      if (Array.isArray(val) && val.length > 0) {
        return key;
      }
    }
  }

  return "";
}

export function buildGeneratedAdapterYaml(
  site: string,
  name: string,
  ep: ScoredEndpoint,
  strategy: string,
): string {
  const description = ep.capability
    ? `Auto-generated: ${ep.capability}`
    : `Auto-generated from ${deriveCommandName(ep.url)}`;
  const selectPath = detectSelectPath(parseResponseBody(ep));
  const fields = ep.detectedFields.slice(0, 10);
  const columns = fields.slice(0, 6);

  const header = [
    `site: ${site}`,
    `name: ${name}`,
    `description: "${description}"`,
  ];
  const body =
    strategy === "public" || strategy === "cookie" || strategy === "header"
      ? buildApiPipeline(ep, strategy, selectPath, fields)
      : buildBrowserPipeline(ep, selectPath, fields);
  const footer = [
    columns.length > 0 ? `columns: [${columns.join(", ")}]` : "columns: []",
  ];

  return [...header, ...body, ...footer].join("\n") + "\n";
}
