/**
 * Generate command — one-shot explore + synthesize + select best adapter.
 *
 * Flow: explore URL → synthesize candidates → match against goal →
 * copy winning YAML to ~/.unicli/adapters/<site>/<name>.yaml →
 * print the generated adapter to stdout.
 */

import { Command } from "commander";
import chalk from "chalk";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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

interface CandidateInfo {
  name: string;
  file: string;
  endpoint: string;
  capability: string | undefined;
  strategy: string;
}

interface AuthInfo {
  strategy: "public" | "cookie" | "header";
  cookies: string[];
  csrfToken: boolean;
  notes: string[];
}

// ── Goal Alias Table ──────────────────────────────────────────────────

const GOAL_ALIASES: Array<{ keywords: RegExp; capability: string }> = [
  {
    keywords: /\b(hot|trending|热门|排行|rank|popular)\b/i,
    capability: "trending",
  },
  {
    keywords: /\b(search|搜索|find|query|查找)\b/i,
    capability: "search",
  },
  {
    keywords: /\b(profile|user|用户|account|member)\b/i,
    capability: "profile",
  },
  {
    keywords: /\b(detail|article|post|文章|content|story)\b/i,
    capability: "detail",
  },
  {
    keywords: /\b(comment|reply|review|评论|feedback)\b/i,
    capability: "comments",
  },
  {
    keywords: /\b(timeline|feed|stream|动态|home)\b/i,
    capability: "timeline",
  },
  {
    keywords: /\b(download|media|下载|file|resource)\b/i,
    capability: "download",
  },
];

// ── Command Registration ──────────────────────────────────────────────

export function registerGenerateCommand(program: Command): void {
  program
    .command("generate <url>")
    .description(
      "One-shot: explore URL, synthesize adapters, select best match",
    )
    .option("--goal <description>", "goal description to match against")
    .option("--timeout <seconds>", "exploration timeout", "30")
    .option("--site <name>", "override auto-detected site name")
    .option("--interact", "auto-interact with page during explore")
    .option("--json", "output JSON only (for piping)")
    .action(
      async (
        url: string,
        opts: {
          goal?: string;
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
          process.stderr.write(chalk.bold(`Generate: ${url}\n`));
          if (opts.goal) {
            process.stderr.write(chalk.dim(`Goal: ${opts.goal}\n`));
          }
          process.stderr.write(
            chalk.dim(`Site: ${siteName} | Timeout: ${opts.timeout}s\n\n`),
          );
        }

        try {
          // ── Phase 1: Explore ──────────────────────────────────────
          if (!jsonOnly) {
            process.stderr.write(
              chalk.cyan("Phase 1: Exploring endpoints...\n"),
            );
          }

          const bridge = new BrowserBridge();
          const page = await bridge.connect({
            timeout: 30_000,
            workspace: "generate:default",
          });

          // Inject interceptor and navigate
          const interceptorJs = generateInterceptorJs("");
          await page.evaluate(interceptorJs);
          await page.goto(url, { settleMs: 2000 });
          await page.evaluate(interceptorJs);

          // Auto-interact if requested
          if (opts.interact) {
            try {
              await page.autoScroll({ maxScrolls: 5, delay: 800 });
              await page.wait(1);
            } catch {
              /* scroll may fail */
            }
          }

          // Collect captured requests
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
              allRequests.push(...batch);
            } catch {
              /* page may have navigated */
            } finally {
              polling = false;
            }
          }, 2000);

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

          if (allRequests.length === 0) {
            const msg =
              "No API requests captured. Try --interact or a different URL.";
            if (jsonOnly) {
              console.error(JSON.stringify({ error: msg }));
            } else {
              console.error(chalk.yellow(msg));
            }
            process.exitCode = 1;
            return;
          }

          if (!jsonOnly) {
            process.stderr.write(
              chalk.dim(`  Captured ${allRequests.length} requests\n`),
            );
          }

          // Convert, filter, sort, annotate, and deduplicate
          const entries = convertToEndpointEntries(allRequests);
          const usable = processEndpoints(entries);

          if (usable.length === 0) {
            const msg = "No usable API endpoints found.";
            if (jsonOnly) {
              console.error(JSON.stringify({ error: msg }));
            } else {
              console.error(chalk.yellow(msg));
            }
            process.exitCode = 1;
            return;
          }

          // Detect auth
          const cookies = await page.cookies();
          const auth = detectAuth(cookies);

          // ── Phase 2: Synthesize ───────────────────────────────────
          if (!jsonOnly) {
            process.stderr.write(
              chalk.cyan(
                `\nPhase 2: Synthesizing from ${usable.length} endpoints...\n`,
              ),
            );
          }

          // Build candidates inline (same logic as synthesize command)
          const candidates: CandidateInfo[] = [];
          const exploreDir = join(homedir(), ".unicli", "explore", siteName);
          const candidatesDir = join(exploreDir, "candidates");
          mkdirSync(candidatesDir, { recursive: true });

          const usedNames = new Set<string>();
          const topEndpoints = usable.slice(0, 10);

          for (const ep of topEndpoints) {
            const name = uniqueName(
              ep.capability ?? deriveCommandName(ep.url),
              usedNames,
            );
            usedNames.add(name);

            const strategy = pickStrategy(auth);
            const yaml = buildYaml(siteName, name, ep, strategy);
            const filePath = join(candidatesDir, `${name}.yaml`);

            const { writeFileSync } = await import("node:fs");
            writeFileSync(filePath, yaml, "utf-8");

            candidates.push({
              name,
              file: filePath,
              endpoint: ep.url,
              capability: ep.capability,
              strategy,
            });
          }

          if (candidates.length === 0) {
            const msg = "No candidates could be generated.";
            if (jsonOnly) {
              console.error(JSON.stringify({ error: msg }));
            } else {
              console.error(chalk.yellow(msg));
            }
            process.exitCode = 1;
            return;
          }

          // ── Phase 3: Select best ──────────────────────────────────
          if (!jsonOnly) {
            process.stderr.write(
              chalk.cyan("\nPhase 3: Selecting best candidate...\n"),
            );
          }

          const winner = selectBest(candidates, opts.goal);

          // Copy winning YAML to adapters directory
          const adapterDir = join(homedir(), ".unicli", "adapters", siteName);
          mkdirSync(adapterDir, { recursive: true });
          const destPath = join(adapterDir, `${winner.name}.yaml`);
          copyFileSync(winner.file, destPath);

          // Auto-generate minimal eval file for the new adapter
          const evalDir = join("evals", "smoke");
          const evalPath = join(evalDir, `${siteName}.yaml`);
          if (!existsSync(evalPath)) {
            mkdirSync(evalDir, { recursive: true });
            const evalContent =
              [
                `# Auto-generated eval for ${siteName} (via unicli generate)`,
                `name: ${siteName} smoke`,
                `cases:`,
                `  - name: ${winner.name} returns data`,
                `    command: unicli ${siteName} ${winner.name} --json`,
                `    judge:`,
                `      - type: nonEmpty`,
              ].join("\n") + "\n";
            writeFileSync(evalPath, evalContent, "utf-8");
            if (!jsonOnly) {
              process.stderr.write(
                chalk.dim(`  Auto-generated eval: ${evalPath}\n`),
              );
            }
          }

          // Read and output the winning YAML
          const yamlContent = readFileSync(winner.file, "utf-8");

          if (jsonOnly) {
            console.log(
              JSON.stringify(
                {
                  site: siteName,
                  name: winner.name,
                  capability: winner.capability,
                  strategy: winner.strategy,
                  adapterPath: destPath,
                  yaml: yamlContent,
                  allCandidates: candidates.length,
                },
                null,
                2,
              ),
            );
          } else {
            process.stderr.write(
              chalk.green(`\n  ✓ Selected: ${winner.name}`) +
                chalk.dim(` (capability: ${winner.capability ?? "general"})`) +
                "\n",
            );
            process.stderr.write(chalk.dim(`  Installed to: ${destPath}\n\n`));

            // Print YAML to stdout (for piping)
            console.log(yamlContent);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (jsonOnly) {
            console.error(JSON.stringify({ error: msg }));
          } else {
            console.error(chalk.red(`Generate failed: ${msg}`));
          }
          process.exitCode = 1;
        }
      },
    );
}

// ── Goal Matching ─────────────────────────────────────────────────────

function selectBest(
  candidates: CandidateInfo[],
  goal: string | undefined,
): CandidateInfo {
  if (!goal) {
    // No goal — return first candidate (processEndpoints already sorted by quality)
    return candidates[0];
  }

  // Map goal to capability via alias table
  let targetCapability: string | undefined;
  for (const { keywords, capability } of GOAL_ALIASES) {
    if (keywords.test(goal)) {
      targetCapability = capability;
      break;
    }
  }

  if (targetCapability) {
    // Find candidate with matching capability
    const match = candidates.find((c) => c.capability === targetCapability);
    if (match) return match;
  }

  // Fallback: fuzzy match goal words against candidate names and capabilities
  const goalWords = goal.toLowerCase().split(/\s+/);
  let bestMatch = candidates[0];
  let bestMatchCount = 0;

  for (const candidate of candidates) {
    let matchCount = 0;
    const text = [
      candidate.name,
      candidate.capability ?? "",
      candidate.endpoint,
    ]
      .join(" ")
      .toLowerCase();

    for (const word of goalWords) {
      if (text.includes(word)) {
        matchCount += 1;
      }
    }

    if (matchCount > bestMatchCount) {
      bestMatchCount = matchCount;
      bestMatch = candidate;
    }
  }

  return bestMatch;
}

// ── Shared Helpers (duplicated from explore/synthesize for isolation) ─

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

function convertToEndpointEntries(
  requests: CapturedRequest[],
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
      method: "GET",
      status: 200,
      contentType: "application/json",
      responseBody: bodyStr || undefined,
      size: bodyStr.length,
    });
  }

  return entries;
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

function detectAuth(cookies: Record<string, string>): AuthInfo {
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
    }
  }

  let strategy: AuthInfo["strategy"] = "public";
  if (csrfToken) {
    strategy = "header";
  } else if (authCookies.length > 0) {
    strategy = "cookie";
  }

  return { strategy, cookies: authCookies, csrfToken, notes };
}

function pickStrategy(auth: AuthInfo): string {
  if (auth.csrfToken) return "header";
  if (auth.cookies.length > 0) return "cookie";
  return "public";
}

function deriveCommandName(url: string): string {
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

function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
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

function buildYaml(
  site: string,
  name: string,
  ep: ScoredEndpoint,
  strategy: string,
): string {
  const description = ep.capability
    ? `Auto-generated: ${ep.capability}`
    : `Auto-generated from ${deriveCommandName(ep.url)}`;

  let parsedBody: unknown;
  try {
    parsedBody = ep.responseBody ? JSON.parse(ep.responseBody) : undefined;
  } catch {
    parsedBody = undefined;
  }
  const selectPath = detectSelectPath(parsedBody);
  const fields = ep.detectedFields.slice(0, 10);
  const columns = fields.slice(0, 6);

  const lines: string[] = [
    `site: ${site}`,
    `name: ${name}`,
    `description: "${description}"`,
    "type: web-api",
    `strategy: ${strategy}`,
    "pipeline:",
    `  - fetch:`,
    `      url: "${ep.url}"`,
  ];

  if (selectPath) {
    lines.push(`  - select: "${selectPath}"`);
  }

  if (fields.length > 0) {
    lines.push("  - map:");
    for (const field of fields) {
      lines.push(`      ${field}: "\${{ item.${field} }}"`);
    }
  }

  lines.push(`  - limit: "\${{ args.limit | default(20) }}"`);

  if (columns.length > 0) {
    lines.push(`columns: [${columns.join(", ")}]`);
  } else {
    lines.push("columns: []");
  }

  return lines.join("\n") + "\n";
}
