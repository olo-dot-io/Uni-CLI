/**
 * Record mode — capture network requests and auto-generate adapter YAML.
 *
 * Flow: connect browser → navigate → inject full-capture interceptor →
 * poll captured requests (multi-tab via CDP Target domain) →
 * analyze → score → deduplicate → write YAML candidates.
 *
 * Enhanced with:
 *   - Multi-tab recording via CDP Target.setDiscoverTargets
 *   - Write candidate generation (POST/PUT/PATCH/DELETE with JSON bodies)
 *   - URL parameter templatization (query/page/id/limit params + numeric path segments)
 *   - Deduplication by normalized URL pattern
 */

import { Command } from "commander";
import chalk from "chalk";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { BrowserBridge } from "../browser/bridge.js";
import {
  generateInterceptorJs,
  generateReadInterceptedJs,
} from "../engine/interceptor.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface RecordedRequest {
  url: string;
  data: unknown;
  ts: number;
  method?: string;
  requestBody?: unknown;
  targetId?: string;
}

export interface ScoredCandidate {
  name: string;
  url: string;
  score: number;
  isWrite: boolean;
  responsePreview: unknown;
  requestBody?: unknown;
  method?: string;
}

/** Template variable descriptor for templatizeUrl */
export interface TemplateArg {
  name: string;
  required: boolean;
}

/** Return value of templatizeUrl */
export interface TemplatizeResult {
  url: string;
  args: TemplateArg[];
}

// ── Query param → template variable mapping ──────────────────────────────────

/** Query params that map to standard template variables */
const QUERY_PARAM_MAP: Record<string, { varName: string; default?: string }> = {
  query: { varName: "query" },
  keyword: { varName: "query" },
  q: { varName: "query" },
  search: { varName: "query" },
  s: { varName: "query" },
  wd: { varName: "query" },
  kw: { varName: "query" },
  keywords: { varName: "query" },
  page: { varName: "page", default: "1" },
  p: { varName: "page", default: "1" },
  offset: { varName: "page", default: "1" },
  start: { varName: "page", default: "1" },
  from: { varName: "page", default: "1" },
  pageNum: { varName: "page", default: "1" },
  limit: { varName: "limit", default: "20" },
  count: { varName: "limit", default: "20" },
  size: { varName: "limit", default: "20" },
  num: { varName: "limit", default: "20" },
  per_page: { varName: "limit", default: "20" },
  pageSize: { varName: "limit", default: "20" },
  id: { varName: "id" },
  uid: { varName: "id" },
  pid: { varName: "id" },
  item_id: { varName: "id" },
  user_id: { varName: "id" },
  sort: { varName: "sort", default: '""' },
  order: { varName: "sort", default: '""' },
  orderby: { varName: "sort", default: '""' },
  type: { varName: "type", default: '""' },
  category: { varName: "type", default: '""' },
  cat: { varName: "type", default: '""' },
  tab: { varName: "type", default: '""' },
};

// ── Step 5.3: URL parameter templatization ───────────────────────────────────

/**
 * Templatize a URL by replacing known query params and numeric path segments
 * with Jinja2-style template variables (`${{ args.X }}`).
 *
 * Returns the templatized URL string and the list of discovered arg names.
 *
 * NOTE: The URL is assembled as a raw string (not via URL.toString()) to
 * prevent URLSearchParams from percent-encoding the template expressions.
 */
export function templatizeUrl(rawUrl: string): TemplatizeResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { url: rawUrl, args: [] };
  }

  const argsMap = new Map<string, TemplateArg>();

  // Jinja2 template var builder — uses string concatenation to avoid
  // template-literal interpolation conflicts with ${{ syntax.
  function jinjaVar(varName: string, def?: string): string {
    return def
      ? "${{ args." + varName + " | default(" + def + ") }}"
      : "${{ args." + varName + " }}";
  }

  // --- Templatize numeric path segments (> 3 digits) that look like IDs ---
  const newPathSegments = parsed.pathname.split("/").map((seg) => {
    // Purely numeric segment with more than 3 digits
    if (/^\d{4,}$/.test(seg)) {
      if (!argsMap.has("id")) {
        argsMap.set("id", { name: "id", required: true });
      }
      return jinjaVar("id");
    }
    return seg;
  });
  const newPathname = newPathSegments.join("/");

  // --- Templatize query params (build raw query string to avoid encoding) ---
  const queryParts: string[] = [];
  for (const [key, value] of parsed.searchParams.entries()) {
    const mapping = QUERY_PARAM_MAP[key];
    if (mapping) {
      const { varName, default: def } = mapping;
      const templateExpr = jinjaVar(varName, def);
      queryParts.push(`${key}=${templateExpr}`);
      if (!argsMap.has(varName)) {
        argsMap.set(varName, { name: varName, required: !def });
      }
    } else {
      // Re-encode the original key=value pair
      queryParts.push(
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
      );
    }
  }

  // Reconstruct URL as raw string to preserve template expressions verbatim.
  // Use parsed.host (includes port) rather than parsed.origin, and preserve
  // any username:password@ credentials that origin would drop.
  const auth = parsed.username
    ? parsed.username +
      (parsed.password ? ":" + parsed.password : "") +
      "@"
    : "";
  const base = `${parsed.protocol}//${auth}${parsed.host}`;
  const search = queryParts.length > 0 ? `?${queryParts.join("&")}` : "";
  const hash = parsed.hash; // preserve fragment if present
  const templatizedUrl = `${base}${newPathname}${search}${hash}`;

  return {
    url: templatizedUrl,
    args: [...argsMap.values()],
  };
}

// ── Step 5.4: Deduplication ──────────────────────────────────────────────────

/**
 * Normalize a URL into a dedup key:
 *   - Strip query param values (keep only param names)
 *   - Replace numeric path segments (>3 digits) with ":id"
 *   - Lowercase
 */
function normalizeUrlForDedup(url: string, method: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `${method}:${url.toLowerCase()}`;
  }

  // Strip query values — keep only sorted param names
  const paramNames = [...parsed.searchParams.keys()].sort().join(",");
  const paramSuffix = paramNames ? `?${paramNames}` : "";

  // Normalize numeric path segments
  const pathNorm = parsed.pathname
    .split("/")
    .map((seg) => (/^\d{4,}$/.test(seg) ? ":id" : seg))
    .join("/");

  // Use parsed.host (hostname + port) so ports are not dropped.
  // e.g. "api.example.com:8080" and "api.example.com:8443" stay distinct.
  return `${method.toUpperCase()}:${parsed.host}${pathNorm}${paramSuffix}`.toLowerCase();
}

/**
 * Count the richness (number of fields/items) of a response body.
 */
function responseRichness(data: unknown): number {
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === "object") {
    let total = 0;
    for (const v of Object.values(data as Record<string, unknown>)) {
      if (Array.isArray(v)) total += v.length;
      else total += 1;
    }
    return total;
  }
  return 0;
}

/**
 * Deduplicate captured requests by normalized URL pattern.
 * For each dedup group, keep the request with the richest response.
 */
export function deduplicateRequests(
  requests: RecordedRequest[],
): RecordedRequest[] {
  const groups = new Map<string, RecordedRequest>();

  for (const req of requests) {
    const method = req.method ?? "GET";
    const key = normalizeUrlForDedup(req.url, method);

    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, req);
    } else {
      // Keep the richer response
      if (responseRichness(req.data) > responseRichness(existing.data)) {
        groups.set(key, req);
      }
    }
  }

  return [...groups.values()];
}

// ── Step 5.2: Write candidate detection ─────────────────────────────────────

/** HTTP methods that indicate a write (mutating) operation */
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Return true if the request is a write candidate:
 * mutating HTTP method + JSON-parseable request body (or no body for DELETE).
 */
export function isWriteCandidate(req: RecordedRequest): boolean {
  const method = (req.method ?? "GET").toUpperCase();
  return WRITE_METHODS.has(method);
}

// ── YAML builders ────────────────────────────────────────────────────────────

/**
 * Build a write-candidate YAML adapter string.
 */
export function buildWriteCandidateYaml(
  site: string,
  candidate: ScoredCandidate,
  baseUrl: string,
): string {
  const { url, name, method = "POST" } = candidate;

  let domain: string;
  try {
    domain = new URL(url).hostname;
  } catch {
    domain = new URL(baseUrl).hostname;
  }

  // Templatize the URL
  const { url: templateUrl, args } = templatizeUrl(url);

  // Args as YAML mapping (name → properties) to match the loader's expectation:
  //   args:
  //     query:
  //       required: true
  //       positional: false
  const argsYaml =
    args.length > 0
      ? args
          .map((a) => `  ${a.name}:\n    required: ${String(a.required)}\n    positional: false`)
          .join("\n")
      : "  {}";

  const hasBody = method !== "DELETE";

  const lines = [
    `site: ${site}`,
    `name: ${name}`,
    `description: "Auto-generated write adapter from record session"`,
    `type: web-api`,
    `domain: ${domain}`,
    `strategy: cookie`,
    `args:`,
    argsYaml,
    `pipeline:`,
    `  - fetch:`,
    `      url: "${templateUrl}"`,
    `      method: ${method}`,
    `      headers:`,
    `        Content-Type: application/json`,
  ];

  if (hasBody) {
    lines.push(`      body: '\${{ args.body | default("{}") }}'`);
  }

  lines.push(`columns: []  # TODO: fill in from response fields`);

  return lines.join("\n") + "\n";
}

function buildReadCandidateYaml(
  site: string,
  candidate: ScoredCandidate,
  baseUrl: string,
): string {
  let selectPath = "";
  const { responsePreview: data, url } = candidate;

  // Try to find the array in the response for the select step
  if (data && typeof data === "object" && !Array.isArray(data)) {
    for (const [key, val] of Object.entries(data as Record<string, unknown>)) {
      if (Array.isArray(val) && val.length > 0) {
        selectPath = key;
        break;
      }
    }
  }

  // Extract domain
  let domain: string;
  try {
    domain = new URL(url).hostname;
  } catch {
    domain = new URL(baseUrl).hostname;
  }

  // Templatize the URL
  const { url: templateUrl, args } = templatizeUrl(url);

  // Args as YAML mapping (name → properties) to match the loader's expectation.
  const argsYaml =
    args.length > 0
      ? args
          .map(
            (a) =>
              `  ${a.name}:\n    required: ${String(a.required)}\n    positional: ${a.name === "query" ? "true" : "false"}`,
          )
          .join("\n")
      : "  {}";

  const lines = [
    `site: ${site}`,
    `name: ${candidate.name}`,
    `description: "Auto-generated from record session"`,
    `type: web-api`,
    `domain: ${domain}`,
    `strategy: cookie`,
    `args:`,
    argsYaml,
    `pipeline:`,
    `  - navigate:`,
    `      url: "${baseUrl}"`,
    `      settleMs: 2000`,
    `  - evaluate: |`,
    `      (async () => {`,
    `        const resp = await fetch("${templateUrl}", { credentials: "include" });`,
    `        return resp.json();`,
    `      })()`,
  ];

  if (selectPath) {
    lines.push(`  - select: "${selectPath}"`);
  }

  lines.push(`  - limit: "\${{ args.limit | default(20) }}"`);
  lines.push(`columns: []  # TODO: fill in from response fields`);

  return lines.join("\n") + "\n";
}

// ── Analysis ─────────────────────────────────────────────────────────────────

function scoreRequest(req: RecordedRequest): number {
  let score = 0;
  const { url, data } = req;

  // Skip tracking/analytics URLs
  const TRACKING =
    /analytics|tracking|beacon|pixel|collect|log|heartbeat|ping|stat/i;
  if (TRACKING.test(url)) return -10;

  // Array response with items
  if (Array.isArray(data)) {
    score += 10;
    score += Math.min(data.length, 10);
  } else if (data && typeof data === "object") {
    // Check for nested arrays (common API pattern: {data: [...], code: 0})
    const values = Object.values(data as Record<string, unknown>);
    for (const v of values) {
      if (Array.isArray(v) && v.length > 0) {
        score += 10;
        score += Math.min(v.length, 10);
        break;
      }
    }
  }

  // API path bonus
  if (/\/api\//.test(url)) score += 3;
  if (/\/v[12345]\//.test(url)) score += 2;

  return score;
}

function generateCommandName(pathname: string, method?: string): string {
  // Extract meaningful name from API path
  const parts = pathname
    .replace(/^\/api\/(v\d+\/)?/, "")
    .replace(/\/$/, "")
    .split("/")
    .filter(Boolean)
    // Remove pure-numeric segments (they become template vars)
    .filter((seg) => !/^\d+$/.test(seg));

  if (parts.length === 0) return "data";

  // Take last 2 meaningful segments
  const name = parts
    .slice(-2)
    .join("-")
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();

  const base = name || "data";
  // Prefix write operations with the HTTP method verb
  if (method && WRITE_METHODS.has(method.toUpperCase())) {
    const verbMap: Record<string, string> = {
      POST: "create",
      PUT: "update",
      PATCH: "patch",
      DELETE: "delete",
    };
    const verb = verbMap[method.toUpperCase()] ?? method.toLowerCase();
    return `${verb}-${base}`;
  }
  return base;
}

/**
 * Analyze captured requests, separating read and write candidates.
 * Deduplication is applied before scoring.
 */
export function analyzeRequests(requests: RecordedRequest[]): {
  readCandidates: ScoredCandidate[];
  writeCandidates: ScoredCandidate[];
} {
  const readCandidates: ScoredCandidate[] = [];
  const writeCandidates: ScoredCandidate[] = [];

  // Deduplicate first
  const deduped = deduplicateRequests(requests);

  const seenPatterns = new Set<string>();

  for (const req of deduped) {
    let pathname: string;
    try {
      pathname = new URL(req.url).pathname;
    } catch {
      continue;
    }

    // Further dedup by normalized pathname pattern
    const normalizedPath = pathname
      .split("/")
      .map((seg) => (/^\d{4,}$/.test(seg) ? ":id" : seg))
      .join("/");

    const method = (req.method ?? "GET").toUpperCase();
    const patternKey = `${method}:${normalizedPath}`;
    if (seenPatterns.has(patternKey)) continue;
    seenPatterns.add(patternKey);

    const score = scoreRequest(req);
    const name = generateCommandName(pathname, method);

    if (isWriteCandidate(req)) {
      // Tracking URLs are excluded even for write candidates
      if (score <= -5) continue;
      writeCandidates.push({
        name,
        url: req.url,
        score: Math.max(score, 5), // write candidates always included (if not tracking)
        isWrite: true,
        responsePreview: req.data,
        requestBody: req.requestBody,
        method,
      });
    } else {
      if (score < 6) continue;
      readCandidates.push({
        name,
        url: req.url,
        score,
        isWrite: false,
        responsePreview: req.data,
      });
    }
  }

  return {
    readCandidates: readCandidates.sort((a, b) => b.score - a.score),
    writeCandidates: writeCandidates.sort((a, b) => b.score - a.score),
  };
}

// ── Utility ──────────────────────────────────────────────────────────────────

function extractSiteName(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    // Remove www. and TLD
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

// ── CDP Target session tracking ──────────────────────────────────────────────

interface ActiveSession {
  targetId: string;
  sessionId: string;
}

// ── Command registration ─────────────────────────────────────────────────────

export function registerRecordCommand(program: Command): void {
  program
    .command("record <url>")
    .description("Record network requests and generate adapter YAML")
    .option("--timeout <seconds>", "recording timeout", "60")
    .option("--site <name>", "site name for generated adapters")
    .action(async (url: string, opts: { timeout: string; site?: string }) => {
      const timeoutMs = (parseInt(opts.timeout, 10) || 60) * 1000;
      const siteName = opts.site ?? extractSiteName(url);

      console.log(chalk.bold(`Recording: ${url}`));
      console.log(chalk.dim(`Site: ${siteName} | Timeout: ${opts.timeout}s`));
      console.log(chalk.dim("Press Ctrl+C to stop early.\n"));

      try {
        const bridge = new BrowserBridge();
        const page = await bridge.connect({
          timeout: 30_000,
          workspace: "record:default",
        });

        // Navigate to target URL
        await page.goto(url, { settleMs: 2000 });

        // Inject full-capture interceptor (captures ALL requests, no pattern filter)
        const interceptorJs = generateInterceptorJs("");
        await page.evaluate(interceptorJs);

        // ── Step 5.1: Multi-tab recording via CDP Target domain ──────────────
        const activeSessions: ActiveSession[] = [];
        let mainTargetId: string | undefined;

        try {
          // Get the main target ID
          const targets = (await page.sendCDP("Target.getTargets")) as {
            targetInfos?: Array<{ targetId: string; type: string; attached?: boolean }>;
          };
          const mainTarget = targets.targetInfos?.find(
            (t) => t.type === "page" && t.attached !== false,
          );
          mainTargetId = mainTarget?.targetId;

          // Enable target discovery to detect new tabs
          await page.sendCDP("Target.setDiscoverTargets", { discover: true });

          // Listen for new tabs being created
          // BrowserPage.sendCDP goes through the CDPClient which has an on() method.
          // We use evaluate to set up a polling mechanism for new tab detection
          // since we cannot directly attach CDP event listeners from record.ts.
          // Instead, we poll for new targets periodically during recording.
        } catch {
          // Multi-tab CDP discovery not available — gracefully degrade to single-tab
        }

        // Poll for captured requests (main tab + any newly discovered tabs)
        const allRequests: RecordedRequest[] = [];

        const pollInterval = setInterval(async () => {
          try {
            // Poll main tab
            const raw = (await page.evaluate(
              generateReadInterceptedJs(),
            )) as string;
            const batch = JSON.parse(raw) as RecordedRequest[];
            if (batch.length > 0) {
              allRequests.push(...batch);
            }

            // Poll any additional tab sessions
            for (const session of activeSessions) {
              try {
                const sessionRaw = (await page.sendCDP(
                  "Runtime.evaluate",
                  {
                    expression: generateReadInterceptedJs(),
                    returnByValue: true,
                    awaitPromise: true,
                    sessionId: session.sessionId,
                  },
                )) as { result?: { value?: string } };
                if (sessionRaw?.result?.value) {
                  const sessionBatch = JSON.parse(
                    sessionRaw.result.value,
                  ) as RecordedRequest[];
                  // Tag each request with its targetId
                  for (const req of sessionBatch) {
                    req.targetId = session.targetId;
                  }
                  allRequests.push(...sessionBatch);
                }
              } catch {
                /* session may have closed */
              }
            }

            // Discover new tabs (poll-based fallback for multi-tab)
            if (mainTargetId) {
              try {
                const newTargets = (await page.sendCDP(
                  "Target.getTargets",
                )) as {
                  targetInfos?: Array<{
                    targetId: string;
                    type: string;
                    attached?: boolean;
                  }>;
                };
                const knownTargetIds = new Set([
                  mainTargetId,
                  ...activeSessions.map((s) => s.targetId),
                ]);
                const newPages =
                  newTargets.targetInfos?.filter(
                    (t) => t.type === "page" && !knownTargetIds.has(t.targetId),
                  ) ?? [];

                for (const target of newPages) {
                  try {
                    const { sessionId } = (await page.sendCDP(
                      "Target.attachToTarget",
                      {
                        targetId: target.targetId,
                        flatten: true,
                      },
                    )) as { sessionId: string };

                    // Enable Network + inject interceptor on new session
                    await page.sendCDP("Network.enable", {
                      sessionId,
                    } as Record<string, unknown>);
                    await page.sendCDP("Runtime.evaluate", {
                      expression: interceptorJs,
                      sessionId,
                    } as Record<string, unknown>);

                    activeSessions.push({
                      targetId: target.targetId,
                      sessionId,
                    });
                    process.stderr.write(
                      chalk.dim(`  [multi-tab] Attached to new tab\n`),
                    );
                  } catch {
                    /* attach failed — tab may have closed immediately */
                  }
                }
              } catch {
                /* Target.getTargets not available — single-tab mode */
              }
            }

            if (allRequests.length > 0) {
              process.stderr.write(
                chalk.dim(`  Captured ${allRequests.length} requests\r`),
              );
            }
          } catch {
            /* page may have navigated */
          }
        }, 2000);

        // Wait for timeout
        await new Promise<void>((resolve) => {
          let settled = false;
          const settle = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            process.removeListener("SIGINT", sigintHandler);
            resolve();
          };
          const timer = setTimeout(settle, timeoutMs);
          const sigintHandler = () => settle();
          process.on("SIGINT", sigintHandler);
        });

        clearInterval(pollInterval);

        // Final drain — main tab
        try {
          const raw = (await page.evaluate(
            generateReadInterceptedJs(),
          )) as string;
          const batch = JSON.parse(raw) as RecordedRequest[];
          allRequests.push(...batch);
        } catch {
          /* ok */
        }

        console.log(`\n\nCaptured ${allRequests.length} total requests.`);

        if (allRequests.length === 0) {
          console.log(
            chalk.yellow(
              "No API requests captured. Try interacting with the page.",
            ),
          );
          return;
        }

        // Score and analyze (returns separated read + write candidates)
        const { readCandidates, writeCandidates } =
          analyzeRequests(allRequests);

        if (readCandidates.length === 0 && writeCandidates.length === 0) {
          console.log(chalk.yellow("No suitable API endpoints found."));
          return;
        }

        // Generate and write read YAML candidates
        const outDir = join(homedir(), ".unicli", "adapters", siteName);
        mkdirSync(outDir, { recursive: true });

        for (const candidate of readCandidates.slice(0, 5)) {
          const yaml = buildReadCandidateYaml(siteName, candidate, url);
          const filePath = join(outDir, `${candidate.name}.yaml`);
          writeFileSync(filePath, yaml, "utf-8");
          console.log(
            chalk.green(`  ✓ ${candidate.name}`) +
              chalk.dim(` (score: ${candidate.score}) → ${filePath}`),
          );
        }

        // Generate and write write YAML candidates to candidates/write/ subdir
        if (writeCandidates.length > 0) {
          const writeDir = join(outDir, "write");
          mkdirSync(writeDir, { recursive: true });

          for (const candidate of writeCandidates.slice(0, 5)) {
            const yaml = buildWriteCandidateYaml(siteName, candidate, url);
            const filePath = join(writeDir, `${candidate.name}.yaml`);
            writeFileSync(filePath, yaml, "utf-8");
            console.log(
              chalk.blue(`  ✎ ${candidate.name}`) +
                chalk.dim(
                  ` [${candidate.method ?? "POST"}] (score: ${candidate.score}) → ${filePath}`,
                ),
            );
          }
        }

        const totalCandidates = readCandidates.length + writeCandidates.length;
        console.log(
          chalk.bold(
            `\n${totalCandidates} adapter candidates written to ${outDir}`,
          ),
        );
      } catch (err) {
        console.error(
          chalk.red(
            `Record failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        process.exitCode = 1;
      }
    });
}
