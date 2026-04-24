/**
 * Self-Repair Engine — Karpathy-style autonomous repair loop.
 *
 * The loop:
 *   1. Review: gather git log, repair history, scope files
 *   2. Classify: identify failure type from last error
 *   3. Modify: spawn Claude Code to make targeted edits
 *   4. Commit: stage and commit scope files
 *   5. Verify: run the verify command and extract metric
 *   6. Decide: keep (improved) or revert (no improvement)
 *   7. Log: append result to TSV log
 */

import { execFileSync, execSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { RepairConfig, MetricDirection } from "./config.js";
import { extractMetric } from "./config.js";
import { RepairLogger, type LogEntry } from "./logger.js";
import { buildRepairPrompt, getStuckHint } from "./prompt.js";
import { classifyFailure } from "./failure-classifier.js";
import { isValidRepairContext, type RepairContext } from "../diagnostic.js";

export interface RepairResult {
  iterations: number;
  finalMetric: number;
  bestMetric: number;
  improved: boolean;
  log: LogEntry[];
}

/**
 * Run the self-repair loop for the given configuration.
 */
export async function runRepairLoop(
  config: RepairConfig,
): Promise<RepairResult> {
  // Phase 0: Preconditions
  assertGitClean();

  // Baseline metric
  const initialMetric = runVerify(
    config.verify,
    config.metricPattern,
    config.direction,
  );
  let bestMetric = initialMetric;
  const logger = new RepairLogger(config.site);

  let lastDiagnostic: RepairContext | undefined;

  // Cache perfect score — extracted from the first successful verify output
  let perfectScore: number | null = null;

  for (let i = 1; i <= config.maxIterations; i++) {
    // Phase 1: Review
    const gitLog = safeExecFile("git", ["log", "--oneline", "-20"]);
    const recentLog = logger.readLast(20);
    const scopeFiles = resolveScope(config.scope);

    // Phase 2: Classify
    let failureGuidance: string | undefined;
    if (lastDiagnostic) {
      const classified = classifyFailure(lastDiagnostic);
      failureGuidance = classified.guidance;

      // Run pre-action if specified (e.g., auth refresh)
      if (classified.preAction && classified.preAction.length > 0) {
        try {
          execFileSync(classified.preAction[0], classified.preAction.slice(1), {
            encoding: "utf-8",
            timeout: 30_000,
          });
        } catch {
          // Pre-action failure is non-fatal
        }
      }
    }

    // Phase 3: Modify — spawn Claude Code
    const consecutiveDiscards = logger.consecutiveDiscards();
    const stuckHint = getStuckHint(consecutiveDiscards);
    const prompt = buildRepairPrompt(
      {
        iteration: i,
        bestMetric,
        currentMetric: bestMetric,
        recentLog,
        gitLog,
        scopeFiles,
        consecutiveDiscards,
        stuckHint,
        failureGuidance,
      },
      config,
    );

    try {
      execSync(
        `claude -p --dangerously-skip-permissions --allowedTools "Read,Edit,Write,Glob,Grep" --output-format text --no-session-persistence`,
        {
          input: prompt,
          cwd: process.cwd(),
          timeout: config.timeout,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    } catch {
      // Timeout or error — continue to verify
    }

    // Phase 4: Commit — re-resolve scope AFTER Claude ran so new files are included
    const freshScopeFiles = resolveScope(config.scope);
    const committed = commitScopeFiles(freshScopeFiles, config.scope, i);

    // Phase 5: Verify
    let metric: number;
    let stderrCapture = "";
    try {
      const verifyOut = execSync(config.verify, {
        encoding: "utf-8",
        timeout: 60_000,
      });
      metric = extractMetric(verifyOut, config.metricPattern) ?? bestMetric;
      lastDiagnostic = undefined;

      // Cache perfect score from first successful verify
      if (perfectScore === null) {
        config.metricPattern.lastIndex = 0;
        const match = config.metricPattern.exec(verifyOut);
        if (match?.[2] !== undefined) {
          perfectScore = Number(match[2]);
        }
      }
    } catch (e) {
      metric = config.direction === "lower" ? Infinity : 0;
      // Try to capture diagnostic from stderr
      if (e instanceof Error && "stderr" in e) {
        stderrCapture = String((e as { stderr?: string }).stderr ?? "");
        lastDiagnostic = parseDiagnostic(stderrCapture);
      }
    }

    // Phase 5.5: Guard (optional regression check)
    let guardPass = true;
    if (config.guard) {
      try {
        execSync(config.guard, {
          timeout: 60_000,
          encoding: "utf-8",
        });
      } catch {
        guardPass = false;
      }
    }

    // Phase 6: Decide
    const delta = metric - bestMetric;
    const improved =
      config.direction === "higher" ? metric > bestMetric : metric < bestMetric;
    const absDelta = Math.abs(delta);

    let status: "keep" | "discard";
    if (improved && absDelta >= config.minDelta && guardPass) {
      status = "keep";
      bestMetric = metric;
    } else {
      status = "discard";
      if (committed) {
        safeRevert();
      } else {
        // Nothing was committed but Claude may have left unstaged changes in scope —
        // clean them up so the next iteration starts from a clean working tree.
        safeRevertUnstaged(freshScopeFiles);
      }
    }

    // Phase 7: Log
    logger.append({
      iteration: i,
      metric,
      status,
      delta,
      summary: `iteration ${i}`,
      timestamp: new Date().toISOString(),
    });

    // Early exit on perfect score
    if (perfectScore !== null) {
      const reachedPerfect =
        config.direction === "lower"
          ? metric <= perfectScore && metric <= 0
          : metric >= perfectScore;
      if (reachedPerfect) break;
    }
  }

  const allLogs = logger.readAll();
  const improved =
    config.direction === "lower"
      ? bestMetric < initialMetric
      : bestMetric > initialMetric;
  return {
    iterations: allLogs.length,
    finalMetric: bestMetric,
    bestMetric,
    improved,
    log: allLogs,
  };
}

// ── Internal helpers ──────────────────────────────────────────────────

function assertGitClean(): void {
  const status = safeExecFile("git", ["status", "--porcelain"]).trim();
  if (status.length > 0) {
    throw new Error(
      "Git working directory is not clean. Commit or stash changes before running repair loop.",
    );
  }

  // Check not in detached HEAD
  let head = "";
  try {
    head = execFileSync("git", ["symbolic-ref", "HEAD"], {
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();
  } catch {
    // execFileSync throws when git symbolic-ref fails (detached HEAD)
  }
  if (!head) {
    throw new Error(
      "Detached HEAD state. Check out a branch before running repair loop.",
    );
  }
}

function runVerify(
  verify: string,
  metricPattern: RegExp,
  direction: MetricDirection,
): number {
  try {
    const output = execSync(verify, {
      encoding: "utf-8",
      timeout: 60_000,
    });
    return extractMetric(output, metricPattern) ?? 0;
  } catch {
    return direction === "lower" ? Infinity : 0;
  }
}

/**
 * Resolve scope glob patterns to concrete file paths.
 * Uses readdirSync({ recursive: true }) + simple extension matching for
 * Node 20 compatibility (node:fs globSync requires Node 22+).
 */
function resolveScope(patterns: string[]): string[] {
  const files: string[] = [];
  const cwd = process.cwd();
  for (const pattern of patterns) {
    try {
      // Get the static base directory from the pattern (before any glob chars)
      const baseDir = getGlobBase(pattern);
      const absBase = join(cwd, baseDir);
      // Verify the base directory exists
      try {
        statSync(absBase);
      } catch {
        continue;
      }
      const matcher = simpleGlobMatcher(pattern);
      const entries = readdirSync(absBase, { recursive: true });
      for (const entry of entries) {
        const entryStr = typeof entry === "string" ? entry : String(entry);
        const relPath = join(baseDir, entryStr);
        if (matcher(relPath) && !files.includes(relPath)) {
          files.push(relPath);
        }
      }
    } catch {
      // Pattern may not match anything
    }
  }
  return files;
}

/**
 * Extract the static base directory from a glob pattern.
 * e.g. "src/adapters/zhihu/**\/*.yaml" → "src/adapters/zhihu"
 */
function getGlobBase(pattern: string): string {
  const parts = pattern.split("/");
  const staticParts: string[] = [];
  for (const part of parts) {
    if (
      part.includes("*") ||
      part.includes("?") ||
      part.includes("{") ||
      part.includes("[")
    ) {
      break;
    }
    staticParts.push(part);
  }
  return staticParts.length > 0 ? staticParts.join("/") : ".";
}

/**
 * Convert a simple glob pattern to a matcher function.
 * Supports: ** (any path), * (any name segment), and literal path segments.
 * Covers the patterns used by repair scope: "dir/**\/*.ext"
 */
function simpleGlobMatcher(pattern: string): (path: string) => boolean {
  // Escape regex special chars except * and ?
  const parts = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    // **/ matches zero or more path segments (including zero)
    .replace(/\*\*\//g, "\u0000")
    // Remaining ** (at end) matches any path
    .replace(/\*\*/g, "\u0001")
    // * matches anything except /
    .replace(/\*/g, "[^/]*")
    // ? matches single char except /
    .replace(/\?/g, "[^/]")
    // Restore **/ as optional path prefix (zero or more dirs)
    .replaceAll("\u0000", "(.*/)?")
    // Restore trailing ** as .* (any path)
    .replaceAll("\u0001", ".*");
  const re = new RegExp(`^${parts}$`);
  return (path: string) => re.test(path);
}

function commitScopeFiles(
  scopeFiles: string[],
  scopePatterns: string[],
  iteration: number,
): boolean {
  try {
    // Stage known resolved files first
    if (scopeFiles.length > 0) {
      try {
        execFileSync("git", ["add", "--", ...scopeFiles], {
          encoding: "utf-8",
        });
      } catch {
        // Some files may not exist
      }
    }
    // Also stage any new files matching the scope glob patterns (handles files
    // created by Claude that weren't in the pre-run resolveScope result).
    for (const pattern of scopePatterns) {
      try {
        execFileSync("git", ["add", "--", pattern], {
          encoding: "utf-8",
        });
      } catch {
        // Pattern may not match
      }
    }
    // Check if there is anything staged before committing
    const staged = safeExecFile("git", [
      "diff",
      "--cached",
      "--name-only",
    ]).trim();
    if (!staged) return false;
    execSync(`git commit -m "repair: auto-fix iteration ${iteration}"`, {
      encoding: "utf-8",
    });
    return true;
  } catch {
    return false;
  }
}

function safeRevert(): void {
  try {
    execFileSync("git", ["reset", "--hard", "HEAD~1"], { encoding: "utf-8" });
  } catch {
    /* give up */
  }
}

/**
 * Discard unstaged changes to the given files. Used when commit returned false
 * (nothing was staged/committed) but Claude may have modified scope files
 * without staging them.
 */
function safeRevertUnstaged(files: string[]): void {
  if (files.length === 0) return;
  try {
    execFileSync("git", ["checkout", "--", ...files], { encoding: "utf-8" });
  } catch {
    // Some files may not exist in HEAD
  }
  // Also remove any untracked files in scope (new files that were never staged)
  for (const f of files) {
    try {
      execFileSync("git", ["clean", "-f", "--", f], { encoding: "utf-8" });
    } catch {
      // Ignore
    }
  }
}

function safeExecFile(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf-8", timeout: 10_000 });
  } catch {
    return "";
  }
}

/**
 * Parse a RepairContext from stderr diagnostic output.
 */
function parseDiagnostic(stderr: string): RepairContext | undefined {
  const marker = "___UNICLI_DIAGNOSTIC___";
  const startIdx = stderr.indexOf(marker);
  const endIdx = stderr.lastIndexOf(marker);
  if (startIdx === -1 || endIdx === -1 || startIdx === endIdx) {
    return undefined;
  }
  const jsonStr = stderr.slice(startIdx + marker.length, endIdx).trim();
  try {
    const parsed: unknown = JSON.parse(jsonStr);
    if (!isValidRepairContext(parsed)) return undefined;
    return parsed as RepairContext;
  } catch {
    return undefined;
  }
}
