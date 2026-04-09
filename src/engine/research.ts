/**
 * AutoResearch Engine — Karpathy-style self-improvement loop.
 *
 * 8-phase loop: precondition → review → modify (Claude Code) →
 * commit → verify (eval) → guard → decide (keep/discard) → log.
 *
 * Adapted from Open-CLI's autoresearch concept, scoped to YAML
 * adapter modification and integrated with Uni-CLI's eval harness.
 */

import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  appendFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Strict site name pattern — prevents shell injection in interpolated commands. */
const SAFE_SITE_NAME = /^[a-zA-Z0-9_-]+$/;

// ── Types ────────────────────────────────────────────────────────────────

export interface ResearchConfig {
  site: string;
  command?: string;
  goal: string;
  verify: string; // shell command that outputs SCORE=N/M
  guard?: string; // optional regression guard command
  scope: string[]; // file glob patterns to allow modification
  metric: string; // regex to extract numeric metric
  direction: "higher" | "lower";
  maxIterations: number;
  minDelta: number;
}

export interface IterationResult {
  iteration: number;
  status: "baseline" | "keep" | "discard" | "crash" | "no-op" | "hook-blocked";
  metric: number;
  description: string;
  durationMs: number;
}

export interface ResearchCallbacks {
  onStatus?: (msg: string) => void;
  onIteration?: (result: IterationResult) => void;
}

// ── Stuck Hints ──────────────────────────────────────────────────────────

const STUCK_HINTS = [
  "Try a completely different approach — the current direction is not working.",
  "Try the OPPOSITE of what has been failing.",
  "Consider changing the pipeline pattern entirely (e.g. fetch→intercept).",
  "Consider if the endpoint URL itself needs to change.",
  "The adapter may need a fundamentally different strategy.",
];

// ── Engine ───────────────────────────────────────────────────────────────

const EXEC_OPTS: ExecFileSyncOptions = { encoding: "utf-8", timeout: 60_000 };
const LOG_DIR = join(homedir(), ".unicli");
const LOG_FILE = join(LOG_DIR, "research.tsv");

function extractMetric(output: string, metricRegex: string): number {
  const re = new RegExp(metricRegex);
  // Reset lastIndex for safety with global/sticky regexes
  re.lastIndex = 0;
  const match = re.exec(output);
  if (!match) return 0;
  // If capturing groups exist, use first group; otherwise use full match
  const raw = match[1] ?? match[0];
  const val = parseFloat(raw);
  return Number.isFinite(val) ? val : 0;
}

function gitExec(args: string[]): string {
  return execFileSync("git", args, EXEC_OPTS) as string;
}

function appendLog(result: IterationResult, site: string): void {
  mkdirSync(LOG_DIR, { recursive: true });
  const line = [
    new Date().toISOString(),
    site,
    result.iteration,
    result.status,
    result.metric,
    result.description.slice(0, 120),
    result.durationMs,
  ].join("\t");
  appendFileSync(LOG_FILE, line + "\n");
}

// ── Safe glob resolution (no shell) ─────────────────────────────────────

/**
 * Resolve scope patterns to actual files without shell execution.
 * Supports simple patterns like `src/adapters/site/*.yaml`.
 */
function resolveScope(patterns: string[]): string[] {
  const files: string[] = [];
  for (const pattern of patterns) {
    // Split at last directory separator before the glob
    const starIdx = pattern.indexOf("*");
    if (starIdx === -1) {
      // No glob — treat as literal file
      if (existsSync(pattern)) files.push(pattern);
      continue;
    }
    const dir = pattern.slice(0, pattern.lastIndexOf("/", starIdx));
    const extFilter = pattern.slice(pattern.lastIndexOf("."));
    if (!existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir)) {
        if (extFilter && !entry.endsWith(extFilter)) continue;
        const fullPath = join(dir, entry);
        files.push(fullPath);
      }
    } catch {
      /* directory read failed */
    }
  }
  return files;
}

// ── Phase 0: Preconditions ──────────────────────────────────────────────

function checkPreconditions(): void {
  // Must be in a git repo
  try {
    gitExec(["rev-parse", "--is-inside-work-tree"]);
  } catch {
    throw new Error("Not inside a git repository");
  }

  // No index.lock
  if (existsSync(".git/index.lock")) {
    throw new Error(
      ".git/index.lock exists — another git process may be running",
    );
  }

  // Not detached HEAD
  try {
    gitExec(["symbolic-ref", "--short", "HEAD"]);
  } catch {
    throw new Error("Detached HEAD — checkout a branch first");
  }

  // Clean working tree for scope files
  const status = gitExec(["status", "--porcelain"]).trim();
  if (status.length > 0) {
    throw new Error(
      "Working tree has uncommitted changes. Commit or stash first.",
    );
  }
}

// ── Phase 4: Verify ─────────────────────────────────────────────────────

function runVerify(config: ResearchConfig): {
  output: string;
  metric: number;
} {
  // Validate site name to prevent injection when used in command construction
  if (!SAFE_SITE_NAME.test(config.site)) {
    return { output: "invalid site name", metric: 0 };
  }
  try {
    // Use execFileSync with explicit args — no shell interpretation
    const output = execFileSync(
      "unicli",
      ["eval", "run", config.site, "--json"],
      { encoding: "utf-8", timeout: 120_000, stdio: ["pipe", "pipe", "pipe"] },
    ) as string;
    return { output, metric: extractMetric(output, config.metric) };
  } catch (err) {
    const output =
      err instanceof Error && "stdout" in err
        ? String((err as { stdout: unknown }).stdout)
        : "";
    return {
      output,
      metric:
        config.direction === "lower"
          ? Infinity
          : extractMetric(output, config.metric),
    };
  }
}

// ── Phase 5.5: Guard ────────────────────────────────────────────────────

function runGuard(config: ResearchConfig): "pass" | "fail" | "skip" {
  if (!config.guard) return "skip";
  // Guard runs `unicli eval run --all` or similar — use execFile with args
  try {
    execFileSync("unicli", ["eval", "run", "--all"], {
      encoding: "utf-8",
      timeout: 120_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return "pass";
  } catch {
    return "fail";
  }
}

// ── Phase 6: Keep/Discard ───────────────────────────────────────────────

function safeRevert(): void {
  try {
    gitExec(["revert", "HEAD", "--no-edit"]);
  } catch {
    try {
      gitExec(["revert", "--abort"]);
    } catch {
      /* ignore */
    }
    gitExec(["reset", "--hard", "HEAD~1"]);
  }
}

// ── Phase 2: Modify (Claude Code invocation) ────────────────────────────

function buildModifyPrompt(
  config: ResearchConfig,
  iteration: number,
  bestMetric: number,
  currentMetric: number,
  consecutiveDiscards: number,
  recentLog: IterationResult[],
  scopeContents: string,
): string {
  const stuckHint =
    consecutiveDiscards >= 5
      ? STUCK_HINTS[Math.min(consecutiveDiscards - 5, STUCK_HINTS.length - 1)]
      : null;

  const logSummary = recentLog
    .slice(-10)
    .map(
      (r) =>
        `  ${String(r.status).padEnd(12)} metric=${r.metric} ${r.description}`,
    )
    .join("\n");

  return `You are improving a Uni-CLI YAML adapter for "${config.site}".

## Goal
${config.goal}

## Current State
- Iteration: ${iteration}
- Current metric: ${currentMetric}
- Best metric: ${bestMetric}
- Consecutive discards: ${consecutiveDiscards}
${stuckHint ? `\n## STUCK HINT\n${stuckHint}\n` : ""}
## Recent History
${logSummary || "(none)"}

## Scope Files
${scopeContents}

## Rules
1. Make exactly ONE focused change per iteration
2. Only modify files matching the scope patterns: ${config.scope.join(", ")}
3. The verify command is: ${config.verify}
4. Metric direction: ${config.direction} is better
5. Do NOT add comments explaining your changes
6. Do NOT modify test files or configuration`;
}

function invokeClaudeCode(prompt: string): string | null {
  try {
    // Use execFileSync (no shell) to avoid injection — safer than Open-CLI's
    // execSync approach which requires manual quote escaping.
    const result = execFileSync(
      "claude",
      [
        "-p",
        "--dangerously-skip-permissions",
        "--allowedTools",
        "Read,Edit,Glob,Grep",
        "--output-format",
        "text",
        "--no-session-persistence",
        prompt,
      ],
      { encoding: "utf-8", timeout: 300_000, stdio: ["pipe", "pipe", "pipe"] },
    ) as string;

    // Extract description from last non-empty line
    const lines = result.trim().split("\n").filter(Boolean);
    const desc = lines.length > 0 ? lines[lines.length - 1].trim() : null;
    return desc ? desc.slice(0, 120) : "change made by research loop";
  } catch {
    return null;
  }
}

// ── Main Loop ────────────────────────────────────────────────────────────

export async function runResearchLoop(
  config: ResearchConfig,
  callbacks?: ResearchCallbacks,
): Promise<IterationResult[]> {
  const results: IterationResult[] = [];
  let bestMetric: number;
  let consecutiveDiscards = 0;

  // Phase 0: Preconditions
  checkPreconditions();

  // Baseline measurement
  callbacks?.onStatus?.("Running baseline verification...");
  const baseline = runVerify(config);
  bestMetric = baseline.metric;

  const baselineResult: IterationResult = {
    iteration: 0,
    status: "baseline",
    metric: baseline.metric,
    description: "Baseline measurement",
    durationMs: 0,
  };
  results.push(baselineResult);
  appendLog(baselineResult, config.site);
  callbacks?.onIteration?.(baselineResult);
  callbacks?.onStatus?.(`Baseline: metric=${baseline.metric}`);

  // Main loop
  for (let i = 1; i <= config.maxIterations; i++) {
    const startMs = Date.now();

    // Stuck detection: abort if too many consecutive discards
    if (consecutiveDiscards >= 13) {
      callbacks?.onStatus?.(
        `Stuck after ${consecutiveDiscards} consecutive discards. Stopping.`,
      );
      break;
    }

    callbacks?.onStatus?.(
      `Iteration ${i}/${config.maxIterations} (best=${bestMetric}, discards=${consecutiveDiscards})`,
    );

    // Phase 1: Review — read scope files (safe glob, no shell)
    let scopeContents = "";
    const scopeFiles = resolveScope(config.scope);
    for (const f of scopeFiles) {
      scopeContents += `\n--- ${f} ---\n${readFileSync(f, "utf-8")}\n`;
    }

    // Phase 2+3: Modify
    const prompt = buildModifyPrompt(
      config,
      i,
      bestMetric,
      bestMetric, // pass current best, not stale baseline
      consecutiveDiscards,
      results,
      scopeContents,
    );
    const description = invokeClaudeCode(prompt);

    if (!description) {
      const result: IterationResult = {
        iteration: i,
        status: "crash",
        metric: bestMetric,
        description: "Claude Code invocation failed",
        durationMs: Date.now() - startMs,
      };
      results.push(result);
      appendLog(result, config.site);
      callbacks?.onIteration?.(result);
      consecutiveDiscards++;
      continue;
    }

    // Phase 4: Commit
    try {
      // Stage only scope files (safe — no shell, explicit file list)
      const filesToStage = resolveScope(config.scope);
      if (filesToStage.length > 0) {
        gitExec(["add", "--", ...filesToStage]);
      }

      const diff = gitExec(["diff", "--cached", "--stat"]).trim();
      if (!diff) {
        const result: IterationResult = {
          iteration: i,
          status: "no-op",
          metric: bestMetric,
          description: "No changes made",
          durationMs: Date.now() - startMs,
        };
        results.push(result);
        appendLog(result, config.site);
        callbacks?.onIteration?.(result);
        consecutiveDiscards++;
        continue;
      }

      try {
        gitExec(["commit", "-m", `research(${config.site}): ${description}`]);
      } catch {
        // Hook failure
        gitExec(["reset", "HEAD"]);
        const result: IterationResult = {
          iteration: i,
          status: "hook-blocked",
          metric: bestMetric,
          description: "Pre-commit hook blocked",
          durationMs: Date.now() - startMs,
        };
        results.push(result);
        appendLog(result, config.site);
        callbacks?.onIteration?.(result);
        consecutiveDiscards++;
        continue;
      }
    } catch {
      const result: IterationResult = {
        iteration: i,
        status: "crash",
        metric: bestMetric,
        description: "Git commit failed",
        durationMs: Date.now() - startMs,
      };
      results.push(result);
      appendLog(result, config.site);
      callbacks?.onIteration?.(result);
      consecutiveDiscards++;
      continue;
    }

    // Phase 5: Verify
    const verification = runVerify(config);

    // Phase 5.5: Guard
    const guardResult = runGuard(config);

    // Phase 6: Decide
    const improved =
      config.direction === "higher"
        ? verification.metric > bestMetric
        : verification.metric < bestMetric;

    const delta = Math.abs(verification.metric - bestMetric);

    if (improved && delta >= config.minDelta && guardResult !== "fail") {
      // Keep
      bestMetric = verification.metric;
      consecutiveDiscards = 0;
      const result: IterationResult = {
        iteration: i,
        status: "keep",
        metric: verification.metric,
        description,
        durationMs: Date.now() - startMs,
      };
      results.push(result);
      appendLog(result, config.site);
      callbacks?.onIteration?.(result);
      callbacks?.onStatus?.(`KEEP: metric ${bestMetric} (${description})`);
    } else {
      // Discard
      safeRevert();
      consecutiveDiscards++;
      const reason =
        guardResult === "fail"
          ? "guard blocked"
          : !improved
            ? "no improvement"
            : "below min delta";
      const result: IterationResult = {
        iteration: i,
        status: "discard",
        metric: verification.metric,
        description: `${reason}: ${description}`,
        durationMs: Date.now() - startMs,
      };
      results.push(result);
      appendLog(result, config.site);
      callbacks?.onIteration?.(result);
    }
  }

  return results;
}

// ── Log Reading ──────────────────────────────────────────────────────────

export function readResearchLog(opts?: {
  site?: string;
  since?: number;
}): IterationResult[] {
  if (!existsSync(LOG_FILE)) return [];
  const lines = readFileSync(LOG_FILE, "utf-8").trim().split("\n");
  const results: IterationResult[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 7) continue;

    const [ts, site, iteration, status, metric, description, durationMs] =
      parts;

    if (opts?.site && site !== opts.site) continue;
    if (opts?.since && new Date(ts).getTime() < opts.since) continue;

    results.push({
      iteration: parseInt(iteration, 10),
      status: status as IterationResult["status"],
      metric: parseFloat(metric),
      description,
      durationMs: parseInt(durationMs, 10),
    });
  }

  return results;
}
