/**
 * Synthesize command — YAML adapter candidate generator.
 *
 * Reads explore results from ~/.unicli/explore/<site>/ and generates
 * YAML adapter candidates for each high-scoring endpoint. Three pipeline
 * modes: public API, cookie API, browser intercept.
 */

import { Command } from "commander";
import chalk from "chalk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ScoredEndpoint } from "../engine/endpoint-scorer.js";

// ── Types ─────────────────────────────────────────────────────────────

interface AuthInfo {
  strategy: "public" | "cookie" | "header";
  cookies: string[];
  csrfToken: boolean;
  notes: string[];
}

interface CandidateInfo {
  name: string;
  file: string;
  endpoint: string;
  score: number;
  capability: string | undefined;
  strategy: string;
}

// ── Command Registration ──────────────────────────────────────────────

export function registerSynthesizeCommand(program: Command): void {
  program
    .command("synthesize <site>")
    .description("Generate YAML adapter candidates from explore results")
    .option("--min-score <n>", "minimum endpoint score", "10")
    .option("--max <n>", "maximum candidates to generate", "10")
    .option("--json", "output JSON only (for piping)")
    .action(
      async (
        site: string,
        opts: { minScore: string; max: string; json?: boolean },
      ) => {
        const minScore = parseInt(opts.minScore, 10) || 10;
        const maxCandidates = parseInt(opts.max, 10) || 10;
        const jsonOnly = opts.json ?? false;

        const exploreDir = join(homedir(), ".unicli", "explore", site);
        const endpointsPath = join(exploreDir, "endpoints.json");
        const authPath = join(exploreDir, "auth.json");

        // Validate explore data exists
        if (!existsSync(endpointsPath)) {
          const msg = `No explore data found for "${site}". Run: unicli explore <url> --site ${site}`;
          if (jsonOnly) {
            console.error(JSON.stringify({ error: msg }));
          } else {
            console.error(chalk.red(msg));
          }
          process.exitCode = 1;
          return;
        }

        try {
          // Read explore data
          const endpoints: ScoredEndpoint[] = JSON.parse(
            readFileSync(endpointsPath, "utf-8"),
          );

          let auth: AuthInfo = {
            strategy: "public",
            cookies: [],
            csrfToken: false,
            notes: [],
          };
          if (existsSync(authPath)) {
            auth = JSON.parse(readFileSync(authPath, "utf-8")) as AuthInfo;
          }

          // Filter to high-scoring endpoints
          const topEndpoints = endpoints
            .filter((ep) => ep.score > minScore)
            .slice(0, maxCandidates);

          if (topEndpoints.length === 0) {
            const msg = `No endpoints with score > ${minScore} found. Try lowering --min-score.`;
            if (jsonOnly) {
              console.error(JSON.stringify({ error: msg }));
            } else {
              console.error(chalk.yellow(msg));
            }
            return;
          }

          if (!jsonOnly) {
            process.stderr.write(
              chalk.bold(
                `Synthesizing ${topEndpoints.length} adapter candidates for ${site}...\n\n`,
              ),
            );
          }

          // Generate YAML candidates
          const candidatesDir = join(exploreDir, "candidates");
          mkdirSync(candidatesDir, { recursive: true });

          const candidates: CandidateInfo[] = [];
          const usedNames = new Set<string>();

          for (const ep of topEndpoints) {
            const name = uniqueName(
              ep.capability ?? deriveCommandName(ep.url),
              usedNames,
            );
            usedNames.add(name);

            const strategy = pickStrategy(auth, ep);
            const yaml = buildYaml(site, name, ep, strategy);
            const fileName = `${name}.yaml`;
            const filePath = join(candidatesDir, fileName);

            writeFileSync(filePath, yaml, "utf-8");

            candidates.push({
              name,
              file: filePath,
              endpoint: ep.url,
              score: ep.score,
              capability: ep.capability,
              strategy,
            });

            if (!jsonOnly) {
              process.stderr.write(
                chalk.green(`  ✓ ${name}`) +
                  chalk.dim(` (score: ${ep.score}, strategy: ${strategy})`) +
                  "\n",
              );
            }
          }

          // Write candidates index
          writeFileSync(
            join(exploreDir, "candidates.json"),
            JSON.stringify(candidates, null, 2),
            "utf-8",
          );

          // Output
          if (jsonOnly) {
            console.log(
              JSON.stringify(
                {
                  site,
                  candidateCount: candidates.length,
                  candidates,
                  candidatesDir,
                },
                null,
                2,
              ),
            );
          } else {
            process.stderr.write(
              chalk.bold(
                `\n${candidates.length} candidates written to ${candidatesDir}\n`,
              ),
            );
            process.stderr.write(
              chalk.dim(`Index: ${join(exploreDir, "candidates.json")}\n`),
            );
            process.stderr.write(
              chalk.dim(`Next: unicli generate <url> --site ${site}\n\n`),
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (jsonOnly) {
            console.error(JSON.stringify({ error: msg }));
          } else {
            console.error(chalk.red(`Synthesize failed: ${msg}`));
          }
          process.exitCode = 1;
        }
      },
    );
}

// ── Strategy Selection ────────────────────────────────────────────────

function pickStrategy(auth: AuthInfo, _ep: ScoredEndpoint): string {
  // If the auth detection found CSRF tokens, use header strategy
  if (auth.csrfToken) return "header";
  // If auth cookies found, use cookie strategy
  if (auth.cookies.length > 0) return "cookie";
  // Default to public
  return "public";
}

// ── YAML Generation ───────────────────────────────────────────────────

function buildYaml(
  site: string,
  name: string,
  ep: ScoredEndpoint,
  strategy: string,
): string {
  const description = ep.capability
    ? `Auto-generated: ${ep.capability}`
    : `Auto-generated from ${deriveCommandName(ep.url)}`;

  // Detect the select path for nested arrays
  let parsedBody: unknown;
  try {
    parsedBody = ep.responseBody ? JSON.parse(ep.responseBody) : undefined;
  } catch {
    parsedBody = undefined;
  }
  const selectPath = detectSelectPath(parsedBody);

  // Build field map from detected fields
  const fields = ep.detectedFields.slice(0, 10);
  const columns = fields.slice(0, 6);

  const lines: string[] = [
    `site: ${site}`,
    `name: ${name}`,
    `description: "${description}"`,
  ];

  if (strategy === "public") {
    // Public API pipeline: fetch + select + map + limit
    lines.push("type: web-api");
    lines.push("strategy: public");
    lines.push("pipeline:");
    lines.push(`  - fetch:`);
    lines.push(`      url: "${ep.url}"`);

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
  } else if (strategy === "cookie" || strategy === "header") {
    // Cookie/header API pipeline: fetch with cookie injection
    lines.push("type: web-api");
    lines.push(`strategy: ${strategy}`);
    lines.push("pipeline:");
    lines.push(`  - fetch:`);
    lines.push(`      url: "${ep.url}"`);

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
  } else {
    // Browser intercept pipeline: navigate + intercept + select + map + limit
    lines.push("type: browser");
    lines.push("strategy: intercept");
    lines.push("pipeline:");

    // Extract base URL from endpoint
    let baseUrl: string;
    try {
      const u = new URL(ep.url);
      baseUrl = `${u.protocol}//${u.hostname}`;
    } catch {
      baseUrl = ep.url;
    }

    lines.push(`  - navigate:`);
    lines.push(`      url: "${baseUrl}"`);
    lines.push(`      settleMs: 2000`);

    // Extract URL pattern for intercept
    let pattern: string;
    try {
      pattern = new URL(ep.url).pathname;
    } catch {
      pattern = ep.url;
    }

    lines.push(`  - intercept:`);
    lines.push(`      pattern: "${pattern}"`);
    lines.push(`      wait: 5000`);

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
  }

  if (columns.length > 0) {
    lines.push(`columns: [${columns.join(", ")}]`);
  } else {
    lines.push("columns: []");
  }

  return lines.join("\n") + "\n";
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Detect the JSON path to the main data array in a response body.
 * Returns the key name (e.g. "data", "items", "results") or empty string.
 */
function detectSelectPath(body: unknown): string {
  if (body == null) return "";
  if (Array.isArray(body)) return ""; // Top-level array, no select needed

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

/**
 * Derive a command name from a URL pathname.
 */
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

/**
 * Ensure a unique name by appending -2, -3, etc. if needed.
 */
function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}
