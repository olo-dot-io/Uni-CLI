/**
 * Prompt builder for the self-repair loop.
 * Assembles context for Claude Code to make targeted adapter fixes.
 */

import type { LogEntry } from "./logger.js";
import type { RepairConfig } from "./config.js";

export interface RepairLoopContext {
  iteration: number;
  bestMetric: number;
  currentMetric: number;
  recentLog: LogEntry[];
  gitLog: string;
  scopeFiles: string[];
  consecutiveDiscards: number;
  stuckHint?: string;
  failureGuidance?: string;
}

/**
 * Build the repair prompt sent to Claude Code for each iteration.
 */
export function buildRepairPrompt(
  ctx: RepairLoopContext,
  config: RepairConfig,
): string {
  const sections: string[] = [];

  // 1. Goal
  sections.push(
    `# Self-Repair Iteration ${ctx.iteration}`,
    "",
    `**Goal**: Fix the failing adapter for site "${config.site}".`,
    `Current score: ${ctx.currentMetric}. Best score: ${ctx.bestMetric}.`,
    `Verify command: \`${config.verify}\``,
    "",
  );

  // 2. Scope
  sections.push(
    "## Scope",
    `You may ONLY edit files matching these patterns:`,
    ...config.scope.map((s) => `- \`${s}\``),
    "",
    "Resolved files:",
    ...ctx.scopeFiles.map((f) => `- ${f}`),
    "",
  );

  // 3. Recent history
  if (ctx.recentLog.length > 0) {
    sections.push(
      "## Recent Repair History",
      "iteration\tmetric\tstatus\tdelta\tsummary",
      ...ctx.recentLog.map(
        (e) =>
          `${e.iteration}\t${e.metric}\t${e.status}\t${e.delta}\t${e.summary}`,
      ),
      "",
    );
  }

  // 4. Git log
  if (ctx.gitLog.trim()) {
    sections.push("## Recent Git Log", "```", ctx.gitLog.trim(), "```", "");
  }

  // 5. Failure guidance
  if (ctx.failureGuidance) {
    sections.push(
      "## Failure Analysis",
      ctx.failureGuidance,
      "",
    );
  }

  // 6. Stuck hint
  if (ctx.stuckHint) {
    sections.push(
      "## Hint (you are stuck)",
      ctx.stuckHint,
      "",
    );
  }

  // 7. Rules
  sections.push(
    "## Rules",
    "- Make ONE atomic change per iteration.",
    "- Do NOT refactor unrelated code.",
    "- Do NOT add features — only fix what is broken.",
    "- Read the adapter YAML/TS source before editing.",
    "- If a CSS selector is broken, read the DOM snapshot first.",
    "- After editing, the verify command will be run automatically.",
    "",
  );

  return sections.join("\n");
}

/**
 * Get a hint based on how many consecutive iterations have been discarded.
 * Returns undefined if the loop is not stuck.
 */
export function getStuckHint(
  consecutiveDiscards: number,
): string | undefined {
  if (consecutiveDiscards >= 11)
    return "Simplify — remove complexity. Strip the adapter down to its minimal working form.";
  if (consecutiveDiscards >= 9)
    return "Try a radical architectural change. Switch strategy, change endpoint, or restructure the pipeline.";
  if (consecutiveDiscards >= 7)
    return "Try the OPPOSITE of what has been failing. If you've been fixing selectors, try a different API endpoint instead.";
  if (consecutiveDiscards >= 5)
    return "Review the entire results log — what approach worked before? Go back to that direction.";
  if (consecutiveDiscards >= 3)
    return "Re-read ALL scope files from scratch. You may be working from stale assumptions.";
  return undefined;
}
