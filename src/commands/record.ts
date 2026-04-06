/**
 * Record mode — capture network requests and auto-generate adapter YAML.
 *
 * Flow: connect browser → navigate → inject full-capture interceptor →
 * poll captured requests → analyze → score → write YAML candidates.
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

interface RecordedRequest {
  url: string;
  data: unknown;
  ts: number;
}

interface ScoredCandidate {
  name: string;
  url: string;
  score: number;
  isWrite: boolean;
  responsePreview: unknown;
}

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

        // Poll for captured requests
        const allRequests: RecordedRequest[] = [];

        const pollInterval = setInterval(async () => {
          try {
            const raw = (await page.evaluate(
              generateReadInterceptedJs(),
            )) as string;
            const batch = JSON.parse(raw) as RecordedRequest[];
            if (batch.length > 0) {
              allRequests.push(...batch);
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

        // Final drain
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

        // Score and analyze
        const candidates = analyzeRequests(allRequests);
        if (candidates.length === 0) {
          console.log(chalk.yellow("No suitable API endpoints found."));
          return;
        }

        // Generate and write YAML candidates
        const outDir = join(homedir(), ".unicli", "adapters", siteName);
        mkdirSync(outDir, { recursive: true });

        for (const candidate of candidates.slice(0, 5)) {
          const yaml = buildCandidateYaml(siteName, candidate, url);
          const filePath = join(outDir, `${candidate.name}.yaml`);
          writeFileSync(filePath, yaml, "utf-8");
          console.log(
            chalk.green(`  ✓ ${candidate.name}`) +
              chalk.dim(` (score: ${candidate.score}) → ${filePath}`),
          );
        }

        console.log(
          chalk.bold(
            `\n${candidates.length} adapter candidates written to ${outDir}`,
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

function analyzeRequests(requests: RecordedRequest[]): ScoredCandidate[] {
  const candidates: ScoredCandidate[] = [];
  const seen = new Set<string>();

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

    const score = scoreRequest(req);
    if (score < 6) continue;

    const name = generateCommandName(pathname);
    candidates.push({
      name,
      url: req.url,
      score,
      isWrite: false,
      responsePreview: req.data,
    });
  }

  return candidates.sort((a, b) => b.score - a.score);
}

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

function generateCommandName(pathname: string): string {
  // Extract meaningful name from API path
  const parts = pathname
    .replace(/^\/api\/(v\d+\/)?/, "")
    .replace(/\/$/, "")
    .split("/")
    .filter(Boolean);

  if (parts.length === 0) return "data";

  // Take last 2 meaningful segments
  const name = parts
    .slice(-2)
    .join("-")
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();

  return name || "data";
}

function buildCandidateYaml(
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

  const lines = [
    `site: ${site}`,
    `name: ${candidate.name}`,
    `description: "Auto-generated from record session"`,
    `type: web-api`,
    `domain: ${domain}`,
    `strategy: cookie`,
    `pipeline:`,
    `  - navigate:`,
    `      url: "${baseUrl}"`,
    `      settleMs: 2000`,
    `  - evaluate: |`,
    `      (async () => {`,
    `        const resp = await fetch("${url}", { credentials: "include" });`,
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
