/**
 * `unicli lint [path]` — minimal schema-v2 lint engine.
 *
 * Four checks, all static (no network):
 *
 *   1. Every YAML adapter parses and matches schema-v2 shape.
 *   2. Every step name in every `pipeline` is in the known-steps registry.
 *   3. No cycles in nested `if` / `each` sub-pipelines (BFS visit).
 *   4. Quarantined adapters (quarantine: true) must carry a non-empty
 *      `quarantineReason`.
 *
 * Non-zero exit on any failure so CI can gate. `--json` emits a
 * structured report for agents.
 */

import { Command } from "commander";
import chalk from "chalk";
import yaml from "js-yaml";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, extname, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ExitCode } from "../types.js";
import type { OutputFormat } from "../types.js";
import {
  AdapterTrustSchema,
  AdapterConfidentialitySchema,
} from "../core/schema-v2.js";
import "../engine/steps/index.js";
import { listSteps } from "../engine/step-registry.js";
import { CUA_STEP_HANDLERS } from "../engine/steps/cua.js";
import { DESKTOP_AX_STEP_HANDLERS } from "../engine/steps/desktop-ax.js";
import { format, detectFormat } from "../output/formatter.js";
import { makeCtx } from "../output/envelope.js";

// ── Known step registry ─────────────────────────────────────────────────
//
// Source of truth is the registry in src/engine/step-registry.ts (populated
// by src/engine/steps/*.ts on import via steps/index.ts). The side-effect
// import above guarantees the registry is fully populated before lint runs.
//
// `rate_limit` is dispatched directly by the executor and does not
// self-register. CUA and desktop-ax steps route through dispatch tables
// instead of the registry, so we add their kinds explicitly.

const KNOWN_STEPS = new Set<string>([
  ...listSteps(),
  "rate_limit",
  ...Object.keys(CUA_STEP_HANDLERS),
  ...Object.keys(DESKTOP_AX_STEP_HANDLERS),
]);

// Step keys that modify other keys rather than being executable themselves.
// They count as metadata, not actions.
const STEP_META_KEYS = new Set(["retry", "continue_on_error", "label"]);

const VALID_TYPES = new Set([
  "web-api",
  "desktop",
  "browser",
  "bridge",
  "service",
]);

const VALID_STRATEGIES = new Set([
  "public",
  "cookie",
  "header",
  "intercept",
  "ui",
]);

// ── Types ───────────────────────────────────────────────────────────────

interface YamlAdapter {
  site?: unknown;
  name?: unknown;
  type?: unknown;
  strategy?: unknown;
  pipeline?: unknown;
  quarantine?: unknown;
  quarantineReason?: unknown;
  // schema-v2 required metadata
  capabilities?: unknown;
  minimum_capability?: unknown;
  trust?: unknown;
  confidentiality?: unknown;
}

export interface LintIssue {
  file: string;
  severity: "error" | "warning";
  rule: string;
  message: string;
}

export interface LintReport {
  scanned: number;
  passed: number;
  failed: number;
  warnings: number;
  issues: LintIssue[];
}

// ── Step extraction ─────────────────────────────────────────────────────

/**
 * A pipeline step is a single-key object: `{ fetch: { url: ... } }`.
 * Returns the action name (the key) excluding metadata siblings.
 */
function extractActionName(step: unknown): string | null {
  if (!step || typeof step !== "object" || Array.isArray(step)) return null;
  const keys = Object.keys(step as Record<string, unknown>).filter(
    (k) => !STEP_META_KEYS.has(k),
  );
  return keys[0] ?? null;
}

/**
 * BFS walk of a pipeline tracking step-object identity to detect cycles.
 * Returns `true` if any step object is reachable from itself.
 *
 * Cycles in native YAML trees are rare (`&anchor`/`*alias` can create
 * them), but they would crash the runner. We catch them statically.
 */
function hasCycle(pipeline: unknown[]): boolean {
  const queue: unknown[] = [...pipeline];
  const visited = new Set<unknown>();

  while (queue.length > 0) {
    const step = queue.shift();
    if (!step || typeof step !== "object") continue;
    if (visited.has(step)) return true;
    visited.add(step);

    // Drill into `if` and `each` sub-pipelines
    const rec = step as Record<string, unknown>;
    for (const key of ["if", "each"]) {
      const config = rec[key];
      if (!config || typeof config !== "object") continue;
      for (const branch of ["then", "else", "do"] as const) {
        const sub = (config as Record<string, unknown>)[branch];
        if (Array.isArray(sub)) queue.push(...sub);
      }
    }
    // `parallel` has `branches: [{ pipeline: [...] }, ...]`
    const parallel = rec["parallel"];
    if (parallel && typeof parallel === "object") {
      const branches = (parallel as Record<string, unknown>)["branches"];
      if (Array.isArray(branches)) {
        for (const b of branches) {
          if (b && typeof b === "object") {
            const sub = (b as Record<string, unknown>)["pipeline"];
            if (Array.isArray(sub)) queue.push(...sub);
          }
        }
      }
    }
  }

  return false;
}

/**
 * Walk every step (including nested `if`/`each`/`parallel`) and yield
 * each step's action name.
 */
function* walkStepNames(pipeline: unknown[]): Generator<string> {
  const queue: unknown[] = [...pipeline];
  while (queue.length > 0) {
    const step = queue.shift();
    const action = extractActionName(step);
    if (action) yield action;
    if (!step || typeof step !== "object") continue;
    const rec = step as Record<string, unknown>;
    for (const key of ["if", "each"]) {
      const config = rec[key];
      if (!config || typeof config !== "object") continue;
      for (const branch of ["then", "else", "do"] as const) {
        const sub = (config as Record<string, unknown>)[branch];
        if (Array.isArray(sub)) queue.push(...sub);
      }
    }
    const parallel = rec["parallel"];
    if (parallel && typeof parallel === "object") {
      const branches = (parallel as Record<string, unknown>)["branches"];
      if (Array.isArray(branches)) {
        for (const b of branches) {
          if (b && typeof b === "object") {
            const sub = (b as Record<string, unknown>)["pipeline"];
            if (Array.isArray(sub)) queue.push(...sub);
          }
        }
      }
    }
  }
}

// ── Per-file linter ─────────────────────────────────────────────────────

export function lintAdapterFile(filePath: string): LintIssue[] {
  const issues: LintIssue[] = [];
  const add = (
    severity: LintIssue["severity"],
    rule: string,
    message: string,
  ) => issues.push({ file: filePath, severity, rule, message });

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    add(
      "error",
      "read",
      `failed to read: ${err instanceof Error ? err.message : String(err)}`,
    );
    return issues;
  }

  let parsed: YamlAdapter;
  try {
    parsed = yaml.load(raw) as YamlAdapter;
  } catch (err) {
    add(
      "error",
      "parse",
      `invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
    return issues;
  }

  if (!parsed || typeof parsed !== "object") {
    add("error", "parse", "top-level value must be an object");
    return issues;
  }

  // schema-v2: required fields
  if (typeof parsed.type === "string" && !VALID_TYPES.has(parsed.type)) {
    add(
      "error",
      "schema",
      `type must be one of ${[...VALID_TYPES].join(", ")}, got "${parsed.type}"`,
    );
  }
  if (
    typeof parsed.strategy === "string" &&
    !VALID_STRATEGIES.has(parsed.strategy)
  ) {
    add(
      "error",
      "schema",
      `strategy must be one of ${[...VALID_STRATEGIES].join(", ")}, got "${parsed.strategy}"`,
    );
  }

  // schema-v2: five required metadata fields
  if (
    parsed.capabilities !== undefined &&
    !Array.isArray(parsed.capabilities)
  ) {
    add("error", "schema-v2", "capabilities must be an array of strings");
  } else if (parsed.capabilities === undefined) {
    add("error", "schema-v2", "missing required field: capabilities");
  }
  if (parsed.minimum_capability === undefined) {
    add("error", "schema-v2", "missing required field: minimum_capability");
  } else if (typeof parsed.minimum_capability !== "string") {
    add("error", "schema-v2", "minimum_capability must be a string");
  }
  if (parsed.trust === undefined) {
    add("error", "schema-v2", "missing required field: trust");
  } else if (
    typeof parsed.trust !== "string" ||
    !AdapterTrustSchema.safeParse(parsed.trust).success
  ) {
    add(
      "error",
      "schema-v2",
      `trust must be one of public|user|system, got "${String(parsed.trust)}"`,
    );
  }
  if (parsed.confidentiality === undefined) {
    add("error", "schema-v2", "missing required field: confidentiality");
  } else if (
    typeof parsed.confidentiality !== "string" ||
    !AdapterConfidentialitySchema.safeParse(parsed.confidentiality).success
  ) {
    add(
      "error",
      "schema-v2",
      `confidentiality must be one of public|internal|private, got "${String(parsed.confidentiality)}"`,
    );
  }
  if (parsed.quarantine === undefined) {
    add("error", "schema-v2", "missing required field: quarantine");
  }

  // quarantine integrity
  if (parsed.quarantine === true) {
    if (
      typeof parsed.quarantineReason !== "string" ||
      parsed.quarantineReason.trim().length === 0
    ) {
      add(
        "error",
        "quarantine",
        "quarantine: true requires a non-empty quarantineReason",
      );
    }
  } else if (
    typeof parsed.quarantineReason === "string" &&
    parsed.quarantineReason.length > 0
  ) {
    add(
      "warning",
      "quarantine",
      "quarantineReason set without quarantine: true — ignored at load time",
    );
  }

  // pipeline checks
  if (parsed.pipeline !== undefined) {
    if (!Array.isArray(parsed.pipeline)) {
      add("error", "pipeline", "pipeline must be an array");
    } else {
      if (parsed.pipeline.length === 0) {
        add("warning", "pipeline", "pipeline is empty");
      }

      if (hasCycle(parsed.pipeline)) {
        add(
          "error",
          "cycle",
          "pipeline contains a structural cycle (YAML anchor/alias?)",
        );
      }

      for (const action of walkStepNames(parsed.pipeline)) {
        if (!KNOWN_STEPS.has(action)) {
          add("error", "unknown-step", `unknown pipeline step: "${action}"`);
        }
      }
    }
  }

  return issues;
}

// ── Directory walk ──────────────────────────────────────────────────────

function* walkYaml(path: string): Generator<string> {
  const st = statSync(path);
  if (st.isFile()) {
    if (extname(path) === ".yaml" || extname(path) === ".yml") {
      yield path;
    }
    return;
  }
  for (const entry of readdirSync(path)) {
    if (entry.startsWith(".") || entry.startsWith("_")) continue;
    yield* walkYaml(join(path, entry));
  }
}

function resolveTarget(arg: string | undefined): string {
  if (arg) return resolve(arg);
  // Default: src/adapters relative to cwd (falls back to package-root).
  const cwdTarget = resolve("src/adapters");
  if (existsSync(cwdTarget)) return cwdTarget;
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return resolve(__dirname, "..", "adapters");
}

export function lintPath(target: string): LintReport {
  const report: LintReport = {
    scanned: 0,
    passed: 0,
    failed: 0,
    warnings: 0,
    issues: [],
  };

  for (const file of walkYaml(target)) {
    report.scanned++;
    const issues = lintAdapterFile(file);
    const hasError = issues.some((i) => i.severity === "error");
    if (hasError) report.failed++;
    else report.passed++;
    report.warnings += issues.filter((i) => i.severity === "warning").length;
    report.issues.push(...issues);
  }

  return report;
}

// ── Command registration ────────────────────────────────────────────────

export function registerLintCommand(program: Command): void {
  program
    .command("lint [path]")
    .description("Static lint for YAML adapters (schema-v2, known steps)")
    .option("--json", "emit a structured JSON report (alias for -f json)")
    .action((path: string | undefined, opts: { json?: boolean }) => {
      const startedAt = Date.now();
      const ctx = makeCtx("lint.run", startedAt);
      const rootFmt = program.opts().format as OutputFormat | undefined;
      const fmt = detectFormat(opts.json ? "json" : rootFmt);

      const target = resolveTarget(path);

      if (!existsSync(target)) {
        ctx.error = {
          code: "invalid_input",
          message: `lint target not found: ${target}`,
          suggestion: "Pass a valid adapter directory or .yaml file path.",
          retryable: false,
        };
        ctx.duration_ms = Date.now() - startedAt;
        console.error(format(null, undefined, fmt, ctx));
        process.exit(ExitCode.CONFIG_ERROR);
      }

      const report = lintPath(target);

      const data = {
        target,
        scanned: report.scanned,
        passed: report.passed,
        failed: report.failed,
        warnings: report.warnings,
        issues: report.issues,
      };

      ctx.duration_ms = Date.now() - startedAt;
      console.log(format(data, undefined, fmt, ctx));

      // Human-readable summary → stderr (Scene-6 pattern)
      if (report.issues.length === 0) {
        console.error(
          chalk.dim(
            `\n  ${report.scanned} adapter(s) scanned, ${chalk.green(`${report.passed} passed`)}`,
          ),
        );
      } else {
        for (const issue of report.issues) {
          const badge =
            issue.severity === "error"
              ? chalk.red("error")
              : chalk.yellow("warn");
          console.error(
            `  ${badge} [${issue.rule}] ${issue.file}: ${issue.message}`,
          );
        }
        console.error(
          `\n  ${chalk.green(`${report.passed} passed`)}, ${chalk.red(`${report.failed} failed`)}, ${chalk.yellow(`${report.warnings} warnings`)}`,
        );
      }

      if (report.failed > 0) {
        process.exit(ExitCode.GENERIC_ERROR);
      }
    });
}
