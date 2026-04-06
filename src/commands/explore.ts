/**
 * Explore command — API discovery engine.
 *
 * Flow: connect browser → navigate to URL → inject interceptor →
 * optionally auto-interact → capture network requests → score endpoints →
 * detect auth method → write results to ~/.unicli/explore/<site>/
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
import {
  processEndpoints,
  type EndpointEntry,
  type ScoredEndpoint,
} from "../engine/endpoint-scorer.js";

// ── Types ─────────────────────────────────────────────────────────────

interface CapturedRequest {
  url: string;
  data: unknown;
  ts: number;
}

interface AuthInfo {
  strategy: "public" | "cookie" | "header";
  cookies: string[];
  csrfToken: boolean;
  notes: string[];
}

interface CapabilityGroup {
  capability: string;
  endpoints: ScoredEndpoint[];
}

// ── Command Registration ──────────────────────────────────────────────

export function registerExploreCommand(program: Command): void {
  program
    .command("explore <url>")
    .description("Explore a site and discover API endpoints for adapters")
    .option("--timeout <seconds>", "exploration timeout", "30")
    .option("--site <name>", "override auto-detected site name")
    .option("--interact", "auto-interact with page (scroll, click tabs)")
    .option("--json", "output JSON only (for piping)")
    .action(
      async (
        url: string,
        opts: {
          timeout: string;
          site?: string;
          interact?: boolean;
          json?: boolean;
        },
      ) => {
        const timeoutMs = (parseInt(opts.timeout, 10) || 30) * 1000;
        const siteName = opts.site ?? extractSiteName(url);
        const jsonOnly = opts.json ?? false;

        if (!jsonOnly) {
          process.stderr.write(chalk.bold(`Exploring: ${url}\n`));
          process.stderr.write(
            chalk.dim(
              `Site: ${siteName} | Timeout: ${opts.timeout}s | Interact: ${opts.interact ? "yes" : "no"}\n`,
            ),
          );
          process.stderr.write(chalk.dim("Press Ctrl+C to stop early.\n\n"));
        }

        try {
          const bridge = new BrowserBridge();
          const page = await bridge.connect({
            timeout: 30_000,
            workspace: "explore:default",
          });

          // Inject interceptor before navigation to capture all requests
          const interceptorJs = generateInterceptorJs("");
          await page.evaluate(interceptorJs);

          // Navigate to target URL
          await page.goto(url, { settleMs: 2000 });

          // Re-inject after navigation (page context resets)
          await page.evaluate(interceptorJs);

          // Auto-interact if requested
          if (opts.interact) {
            await autoInteract(page, jsonOnly);
          }

          // Collect captured requests over the timeout period
          const allRequests: CapturedRequest[] = [];

          let polling = false;
          const pollInterval = setInterval(async () => {
            if (polling) return;
            polling = true;
            try {
              const raw = (await page.evaluate(
                generateReadInterceptedJs(),
              )) as string;
              const batch = JSON.parse(raw) as CapturedRequest[];
              if (batch.length > 0) {
                allRequests.push(...batch);
                if (!jsonOnly) {
                  process.stderr.write(
                    chalk.dim(`  Captured ${allRequests.length} requests\r`),
                  );
                }
              }
            } catch {
              /* page may have navigated */
            } finally {
              polling = false;
            }
          }, 2000);

          // Wait for timeout or Ctrl+C
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

          // Final drain
          try {
            const raw = (await page.evaluate(
              generateReadInterceptedJs(),
            )) as string;
            const batch = JSON.parse(raw) as CapturedRequest[];
            allRequests.push(...batch);
          } catch {
            /* ok */
          }

          if (!jsonOnly) {
            process.stderr.write(
              `\n\nCaptured ${allRequests.length} total requests.\n`,
            );
          }

          if (allRequests.length === 0) {
            if (jsonOnly) {
              console.log(JSON.stringify({ endpoints: [], auth: null }));
            } else {
              console.error(
                chalk.yellow(
                  "No API requests captured. Try --interact or interact manually.",
                ),
              );
            }
            return;
          }

          // Convert captured requests to EndpointEntry format
          const entries = convertToEndpointEntries(allRequests);

          // Filter, sort, annotate, and deduplicate endpoints
          const scored = processEndpoints(entries);

          // Detect auth
          const cookies = await page.cookies();
          const auth = detectAuth(cookies, allRequests);

          // Group by capability
          const capabilities = groupByCapability(scored);

          // Write results to disk
          const outDir = join(homedir(), ".unicli", "explore", siteName);
          mkdirSync(outDir, { recursive: true });

          writeFileSync(
            join(outDir, "endpoints.json"),
            JSON.stringify(scored, null, 2),
            "utf-8",
          );
          writeFileSync(
            join(outDir, "capabilities.json"),
            JSON.stringify(capabilities, null, 2),
            "utf-8",
          );
          writeFileSync(
            join(outDir, "auth.json"),
            JSON.stringify(auth, null, 2),
            "utf-8",
          );

          // Output
          if (jsonOnly) {
            console.log(
              JSON.stringify(
                {
                  site: siteName,
                  endpointCount: scored.length,
                  topEndpoints: scored.slice(0, 10),
                  capabilities,
                  auth,
                  outputDir: outDir,
                },
                null,
                2,
              ),
            );
          } else {
            printSummary(siteName, scored, capabilities, auth, outDir);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (jsonOnly) {
            console.error(JSON.stringify({ error: msg }));
          } else {
            console.error(chalk.red(`Explore failed: ${msg}`));
          }
          process.exitCode = 1;
        }
      },
    );
}

// ── Auto-Interaction ──────────────────────────────────────────────────

async function autoInteract(
  page: import("../types.js").IPage,
  jsonOnly: boolean,
): Promise<void> {
  if (!jsonOnly) {
    process.stderr.write(chalk.dim("  Auto-interacting...\n"));
  }

  // Scroll down to trigger lazy-loaded content
  try {
    await page.autoScroll({ maxScrolls: 5, delay: 800 });
  } catch {
    /* scroll may fail on some pages */
  }

  // Wait for any lazy content to load
  await page.wait(1);

  // Try to detect and click tab/pagination elements via snapshot
  try {
    const snap = await page.snapshot({ interactive: true, compact: true });

    // Look for common tab/pagination patterns in the snapshot
    const tabPatterns = /\[ref=(\d+)\].*(?:tab|pagination|next|more|load)/gi;
    const matches: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = tabPatterns.exec(snap)) !== null) {
      matches.push(match[1]);
    }

    // Click up to 3 detected interactive elements
    for (const ref of matches.slice(0, 3)) {
      try {
        await page.evaluate(
          `(() => {
            const el = document.querySelector('[data-unicli-ref="${ref}"]');
            if (el) el.click();
          })()`,
        );
        await page.wait(1);
      } catch {
        /* click may fail */
      }
    }
  } catch {
    /* snapshot may fail */
  }
}

// ── Data Conversion ───────────────────────────────────────────────────

function convertToEndpointEntries(
  requests: CapturedRequest[],
): EndpointEntry[] {
  const seen = new Set<string>();
  const entries: EndpointEntry[] = [];

  for (const req of requests) {
    // Deduplicate by URL pathname
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
      method: "GET", // interceptor does not capture method; default to GET
      status: 200, // interceptor only captures successful responses
      contentType: "application/json",
      responseBody: bodyStr || undefined,
      size: bodyStr.length,
    });
  }

  return entries;
}

// ── Auth Detection ────────────────────────────────────────────────────

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

function detectAuth(
  cookies: Record<string, string>,
  _requests: CapturedRequest[],
): AuthInfo {
  const notes: string[] = [];
  const authCookies: string[] = [];
  let csrfToken = false;

  // Scan cookie names for auth indicators
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

  // Determine strategy
  let strategy: AuthInfo["strategy"] = "public";
  if (csrfToken) {
    strategy = "header";
    notes.push("Recommended strategy: header (CSRF token present)");
  } else if (authCookies.length > 0) {
    strategy = "cookie";
    notes.push("Recommended strategy: cookie");
  } else {
    notes.push("No auth detected — public API likely");
  }

  return { strategy, cookies: authCookies, csrfToken, notes };
}

// ── Capability Grouping ───────────────────────────────────────────────

function groupByCapability(scored: ScoredEndpoint[]): CapabilityGroup[] {
  const groups = new Map<string, ScoredEndpoint[]>();

  for (const ep of scored) {
    if (ep.capability) {
      const existing = groups.get(ep.capability) ?? [];
      existing.push(ep);
      groups.set(ep.capability, existing);
    }
  }

  // Order preserves the sort from processEndpoints (endpointSortKey descending)
  return Array.from(groups.entries()).map(([capability, endpoints]) => ({
    capability,
    endpoints,
  }));
}

// ── Output ────────────────────────────────────────────────────────────

function printSummary(
  siteName: string,
  scored: ScoredEndpoint[],
  capabilities: CapabilityGroup[],
  auth: AuthInfo,
  outDir: string,
): void {
  process.stderr.write(chalk.bold(`\n--- Explore Results: ${siteName} ---\n`));
  process.stderr.write(chalk.dim(`  ${scored.length} endpoints found\n\n`));

  // Top endpoints table
  process.stderr.write(chalk.bold("  Top Endpoints:\n"));
  for (const ep of scored.slice(0, 10)) {
    let pathname: string;
    try {
      pathname = new URL(ep.url).pathname;
    } catch {
      pathname = ep.url;
    }
    const cap = ep.capability ? chalk.cyan(` [${ep.capability}]`) : "";
    const fields =
      ep.detectedFields.length > 0
        ? chalk.dim(` (${ep.detectedFields.slice(0, 5).join(", ")})`)
        : "";
    process.stderr.write(`    ${pathname}${cap}${fields}\n`);
  }

  // Capabilities
  if (capabilities.length > 0) {
    process.stderr.write(chalk.bold("\n  Capabilities Detected:\n"));
    for (const group of capabilities) {
      process.stderr.write(
        `    ${chalk.cyan(group.capability)} — ${group.endpoints.length} endpoint(s)\n`,
      );
    }
  }

  // Auth
  process.stderr.write(chalk.bold("\n  Auth:\n"));
  process.stderr.write(`    Strategy: ${chalk.yellow(auth.strategy)}\n`);
  for (const note of auth.notes) {
    process.stderr.write(`    ${chalk.dim(note)}\n`);
  }

  process.stderr.write(chalk.bold(`\n  Output: ${outDir}\n`));
  process.stderr.write(
    chalk.dim("  Next: unicli synthesize " + siteName + "\n\n"),
  );
}

// ── Helpers ───────────────────────────────────────────────────────────

function extractSiteName(url: string): string {
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
