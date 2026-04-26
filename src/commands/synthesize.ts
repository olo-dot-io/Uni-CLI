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
import { isUsefulEndpoint } from "../engine/analysis.js";
import type { ScoredEndpoint } from "../engine/endpoint-scorer.js";
import { userHome } from "../engine/user-home.js";
import { readSiteMemory } from "../browser/site-memory.js";
import { ExitCode } from "../types.js";
import type { OutputFormat } from "../types.js";
import { format, detectFormat } from "../output/formatter.js";
import { makeCtx } from "../output/envelope.js";
import { errorTypeToCode, mapErrorToExitCode } from "../output/error-map.js";

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
  capability: string | undefined;
  strategy: string;
}

function memoryEndpointsToScored(site: string): ScoredEndpoint[] {
  const memory = readSiteMemory(site);
  return Object.entries(memory.endpoints).map(([key, endpoint]) => {
    const response =
      endpoint.response && typeof endpoint.response === "object"
        ? (endpoint.response as Record<string, unknown>)
        : {};
    const fields = Array.isArray(response.fields)
      ? response.fields.filter(
          (field): field is string => typeof field === "string",
        )
      : [];
    const sample = response.sample;
    return {
      url: endpoint.url,
      method: endpoint.method,
      status: typeof response.status === "number" ? response.status : 200,
      contentType:
        typeof response.contentType === "string"
          ? response.contentType
          : "application/json",
      responseBody: sample === undefined ? undefined : JSON.stringify(sample),
      size: typeof response.size === "number" ? response.size : 0,
      detectedFields: fields,
      capability: key,
    };
  });
}

// ── Command Registration ──────────────────────────────────────────────

export function registerSynthesizeCommand(program: Command): void {
  program
    .command("synthesize <site>")
    .description("Generate YAML adapter candidates from explore results")
    .option("--max <n>", "maximum candidates to generate", "10")
    .action(async (site: string, opts: { max: string }) => {
      const startedAt = Date.now();
      const ctx = makeCtx("core.synthesize", startedAt);
      const fmt = detectFormat(
        program.opts().format as OutputFormat | undefined,
      );

      const maxCandidates = parseInt(opts.max, 10) || 10;

      const exploreDir = join(userHome(), ".unicli", "explore", site);
      const endpointsPath = join(exploreDir, "endpoints.json");
      const authPath = join(exploreDir, "auth.json");

      const memoryEndpoints = existsSync(endpointsPath)
        ? []
        : memoryEndpointsToScored(site);

      // Validate explore data or reusable site memory exists
      if (!existsSync(endpointsPath) && memoryEndpoints.length === 0) {
        ctx.error = {
          code: "not_found",
          message: `No explore data found for "${site}"`,
          suggestion: `Run: unicli explore <url> --site ${site}`,
          retryable: false,
        };
        ctx.duration_ms = Date.now() - startedAt;
        console.error(format(null, undefined, fmt, ctx));
        process.exit(ExitCode.USAGE_ERROR);
      }

      try {
        // Read explore data
        const endpoints: ScoredEndpoint[] = existsSync(endpointsPath)
          ? JSON.parse(readFileSync(endpointsPath, "utf-8"))
          : memoryEndpoints;

        let auth: AuthInfo = {
          strategy: "public",
          cookies: [],
          csrfToken: false,
          notes: [],
        };
        if (existsSync(authPath)) {
          auth = JSON.parse(readFileSync(authPath, "utf-8")) as AuthInfo;
        }

        // Filter to useful endpoints and take the top N
        const topEndpoints = endpoints
          .filter((ep) => {
            let body: unknown;
            if (ep.responseBody) {
              try {
                body = JSON.parse(ep.responseBody);
              } catch {
                // ignore malformed JSON
              }
            }
            return isUsefulEndpoint({
              url: ep.url,
              status: ep.status,
              contentType: ep.contentType,
              body,
            });
          })
          .slice(0, maxCandidates);

        if (topEndpoints.length === 0) {
          const data = {
            site,
            candidate_count: 0,
            candidates: [] as CandidateInfo[],
            candidates_dir: join(exploreDir, "candidates"),
          };
          ctx.duration_ms = Date.now() - startedAt;
          console.log(format(data, undefined, fmt, ctx));
          console.error(
            chalk.yellow(
              "\n  No useful endpoints found. Re-run unicli explore to capture more data.",
            ),
          );
          return;
        }

        console.error(
          chalk.bold(
            `Synthesizing ${topEndpoints.length} adapter candidates for ${site}...\n`,
          ),
        );

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
            capability: ep.capability,
            strategy,
          });

          console.error(
            chalk.green(`  ✓ ${name}`) +
              chalk.dim(
                ` (strategy: ${strategy}${ep.capability ? `, capability: ${ep.capability}` : ""})`,
              ),
          );
        }

        // Write candidates index
        writeFileSync(
          join(exploreDir, "candidates.json"),
          JSON.stringify(candidates, null, 2),
          "utf-8",
        );

        const data = {
          site,
          candidate_count: candidates.length,
          candidates,
          candidates_dir: candidatesDir,
        };

        ctx.duration_ms = Date.now() - startedAt;
        console.log(format(data, undefined, fmt, ctx));

        console.error(
          chalk.bold(
            `\n${candidates.length} candidate(s) written to ${candidatesDir}`,
          ),
        );
        console.error(
          chalk.dim(`Index: ${join(exploreDir, "candidates.json")}`),
        );
        console.error(
          chalk.dim(`Next: unicli generate <url> --site ${site}\n`),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.error = {
          code: errorTypeToCode(err),
          message,
          suggestion: `Re-run unicli explore to refresh endpoints.json`,
          retryable: false,
        };
        ctx.duration_ms = Date.now() - startedAt;
        console.error(format(null, undefined, fmt, ctx));
        process.exit(mapErrorToExitCode(err));
      }
    });
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

function buildYaml(
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
