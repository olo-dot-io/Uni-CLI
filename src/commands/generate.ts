/**
 * @owner   src/commands/generate.ts
 * @does    Run one-shot adapter authoring by exploring a URL, generating candidates, selecting one, and installing it locally.
 * @needs   commander, chalk, fs/path, browser bridge/workspace/site-memory, engine interceptor/endpoint-scorer/user-home, output, adapter-authoring
 * @feeds   src/cli.ts, eval smoke files, ~/.unicli/adapters, tests/unit/commands/explore-generate.test.ts
 * @breaks  Browser, endpoint, candidate, and filesystem failures emit structured command envelopes. No fallback.
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
import { BrowserBridge } from "../browser/bridge.js";
import { createOneShotWorkspace } from "../browser/workspace.js";
import {
  generateInterceptorJs,
  generateReadInterceptedJs,
} from "../engine/interceptor.js";
import { processEndpoints } from "../engine/endpoint-scorer.js";
import {
  buildGeneratedAdapterYaml,
  convertToEndpointEntries,
  deriveCommandName,
  detectAuth,
  extractSiteName,
  pickStrategy,
  uniqueName,
  type CapturedEndpointRequest,
} from "./adapter-authoring.js";
import { recordEndpointDiscoveries } from "../browser/site-memory.js";
import { format, detectFormat } from "../output/formatter.js";
import { makeCtx } from "../output/envelope.js";
import { mapErrorToExitCode } from "../output/error-map.js";
import { userHome } from "../engine/user-home.js";
import type { OutputFormat } from "../types.js";

// ── Types ─────────────────────────────────────────────────────────────

interface CandidateInfo {
  name: string;
  file: string;
  endpoint: string;
  capability: string | undefined;
  strategy: string;
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
        const startedAt = Date.now();
        const ctx = makeCtx("core.generate", startedAt);
        const rootFmt = program.opts().format as OutputFormat | undefined;
        const fmt = detectFormat(opts.json ? "json" : rootFmt);
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
            workspace: createOneShotWorkspace("generate"),
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
          const allRequests: CapturedEndpointRequest[] = [];

          let polling = false;
          const pollInterval = setInterval(async () => {
            if (polling) return;
            polling = true;
            try {
              const raw = (await page.evaluate(
                generateReadInterceptedJs(),
              )) as string;
              const batch = JSON.parse(raw) as CapturedEndpointRequest[];
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
            const batch = JSON.parse(raw) as CapturedEndpointRequest[];
            allRequests.push(...batch);
          } catch {
            /* ok */
          }

          if (allRequests.length === 0) {
            const msg =
              "No API requests captured. Try --interact or a different URL.";
            ctx.error = {
              code: "empty_result",
              message: msg,
              suggestion:
                "Retry with --interact, or open the URL manually and re-run.",
              retryable: true,
            };
            ctx.duration_ms = Date.now() - startedAt;
            console.error(format(null, undefined, fmt, ctx));
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
          recordEndpointDiscoveries(siteName, usable.slice(0, 10));

          if (usable.length === 0) {
            const msg = "No usable API endpoints found.";
            ctx.error = {
              code: "empty_result",
              message: msg,
              suggestion:
                "Re-run with --interact, or widen the exploration window.",
              retryable: true,
            };
            ctx.duration_ms = Date.now() - startedAt;
            console.error(format(null, undefined, fmt, ctx));
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
          const exploreDir = join(userHome(), ".unicli", "explore", siteName);
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
            const yaml = buildGeneratedAdapterYaml(
              siteName,
              name,
              ep,
              strategy,
            );
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
            ctx.error = {
              code: "empty_result",
              message: msg,
              suggestion: "Review captured endpoints with: unicli explore",
              retryable: true,
            };
            ctx.duration_ms = Date.now() - startedAt;
            console.error(format(null, undefined, fmt, ctx));
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
          const adapterDir = join(userHome(), ".unicli", "adapters", siteName);
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

          const data = {
            site: siteName,
            name: winner.name,
            capability: winner.capability,
            strategy: winner.strategy,
            adapterPath: destPath,
            yaml: yamlContent,
            allCandidates: candidates.length,
          };

          ctx.duration_ms = Date.now() - startedAt;
          console.log(format(data, undefined, fmt, ctx));

          console.error(
            chalk.green(`\n  ✓ Selected: ${winner.name}`) +
              chalk.dim(` (capability: ${winner.capability ?? "general"})`),
          );
          console.error(chalk.dim(`  Installed to: ${destPath}`));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.error = {
            code: "internal_error",
            message: msg,
            suggestion:
              "Check browser connectivity with: unicli browser status",
            retryable: true,
          };
          ctx.duration_ms = Date.now() - startedAt;
          console.error(format(null, undefined, fmt, ctx));
          process.exitCode = mapErrorToExitCode(err);
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
