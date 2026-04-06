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

import { execSync } from "node:child_process";
import { globSync } from "node:fs";

import type { RepairConfig } from "./config.js";
import { extractMetric } from "./config.js";
import { RepairLogger, type LogEntry } from "./logger.js";
import { buildRepairPrompt, getStuckHint } from "./prompt.js";
import { classifyFailure } from "./failure-classifier.js";
import type { RepairContext } from "../diagnostic.js";

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
  const initialMetric = runVerify(config);
  let bestMetric = initialMetric;
  const logger = new RepairLogger(config.site);

  let lastDiagnostic: RepairContext | undefined;

  for (let i = 1; i <= config.maxIterations; i++) {
    // Phase 1: Review
    const gitLog = safeExec("git log --oneline -20");
    const recentLog = logger.readLast(20);
    const scopeFiles = resolveScope(config.scope);

    // Phase 2: Classify
    let failureGuidance: string | undefined;
    if (lastDiagnostic) {
      const classified = classifyFailure(lastDiagnostic);
      failureGuidance = classified.guidance;

      // Run pre-action if specified (e.g., auth refresh)
      if (classified.preAction) {
        safeExec(classified.preAction);
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

    // Phase 4: Commit
    const committed = commitScopeFiles(scopeFiles, i);

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
    } catch (e) {
      metric = 0;
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
      config.direction === "higher"
        ? metric > bestMetric
        : metric < bestMetric;
    const absDelta = Math.abs(delta);

    let status: "keep" | "discard";
    if (improved && absDelta >= config.minDelta && guardPass) {
      status = "keep";
      bestMetric = metric;
    } else {
      status = "discard";
      if (committed) {
        safeRevert();
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
    const perfectScore = extractPerfectScore(config);
    if (perfectScore !== null && metric >= perfectScore) break;
  }

  const allLogs = logger.readAll();
  return {
    iterations: allLogs.length,
    finalMetric: bestMetric,
    bestMetric,
    improved: bestMetric > initialMetric,
    log: allLogs,
  };
}

// ── Internal helpers ──────────────────────────────────────────────────

function assertGitClean(): void {
  const status = safeExec("git status --porcelain").trim();
  if (status.length > 0) {
    throw new Error(
      "Git working directory is not clean. Commit or stash changes before running repair loop.",
    );
  }

  // Check not in detached HEAD
  const head = safeExec("git symbolic-ref HEAD 2>/dev/null").trim();
  if (!head) {
    throw new Error(
      "Detached HEAD state. Check out a branch before running repair loop.",
    );
  }
}

function runVerify(config: RepairConfig): number {
  try {
    const output = execSync(config.verify, {
      encoding: "utf-8",
      timeout: 60_000,
    });
    return extractMetric(output, config.metricPattern) ?? 0;
  } catch {
    return 0;
  }
}

function resolveScope(patterns: string[]): string[] {
  const files: string[] = [];
  for (const pattern of patterns) {
    try {
      const matched = globSync(pattern, { cwd: process.cwd() });
      for (const f of matched) {
        if (!files.includes(f)) files.push(f);
      }
    } catch {
      // Pattern may not match anything
    }
  }
  return files;
}

function commitScopeFiles(scopeFiles: string[], iteration: number): boolean {
  try {
    if (scopeFiles.length === 0) return false;
    const paths = scopeFiles.map((f) => `"${f}"`).join(" ");
    execSync(`git add ${paths}`, { encoding: "utf-8" });
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
    execSync("git revert HEAD --no-edit", { encoding: "utf-8" });
  } catch {
    try {
      execSync("git reset --hard HEAD~1", { encoding: "utf-8" });
    } catch {
      // Give up
    }
  }
}

function safeExec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 10_000 });
  } catch {
    return "";
  }
}

/**
 * Try to extract a perfect score from the metric pattern.
 * For SCORE=N/M patterns, returns M (the denominator).
 */
function extractPerfectScore(config: RepairConfig): number | null {
  // Run verify once more to get the denominator
  try {
    const output = execSync(config.verify, {
      encoding: "utf-8",
      timeout: 60_000,
    });
    const match = config.metricPattern.exec(output);
    if (match && match[2] !== undefined) {
      return Number(match[2]);
    }
  } catch {
    // Ignore
  }
  return null;
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
    return JSON.parse(jsonStr) as RepairContext;
  } catch {
    return undefined;
  }
}
