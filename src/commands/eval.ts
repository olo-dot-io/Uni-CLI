/**
 * @owner       src::commands::eval
 * @does        Discovers and executes declarative adapter regression suites through the public CLI surface.
 * @needs       node fs/path/os/child_process, js-yaml, commander, output envelope/formatter
 * @feeds       `unicli eval list|run|ci` and post-repair regression assets
 * @breaks      Invalid eval YAML, command launch failures, judge failures, and incomplete runs remain explicit results.
 * @invariants  Cases invoke argv without a shell; judges evaluate the same JSON/exit surface users receive.
 * @side-effects Reads eval files, starts bounded CLI subprocesses, writes envelopes and summaries.
 * @perf        O(eval cases); every case has a configured timeout.
 * @concurrency Cases execute serially to avoid shared auth and upstream-rate interference.
 * @test        tests/unit/commands/eval.test.ts, tests/unit/eval.test.ts
 * @stability   public
 * @since       2026-04-08
 *
 * Declarative regression suite usage:
 *   unicli eval list                       # list available evals
 *   unicli eval run smoke/bilibili         # run one eval file
 *   unicli eval run --all smoke/           # run a directory
 *   unicli eval ci --since 7d              # run only adapters touched in N days
 *
 * Eval files are YAML, located at:
 *   - `evals/` (bundled with the npm package)
 *   - `~/.unicli/evals/` (user-local)
 *
 * Format:
 *   name: bilibili-smoke
 *   adapter: bilibili
 *   cases:
 *     - command: rank
 *       args: {}
 *       judges:
 *         - { type: arrayMinLength, path: data, min: 5 }
 *         - { type: contains, field: data[0].title, value: "" }
 *
 * Why this exists:
 *   Declarative eval files are the reusable regression asset produced after
 *   a repair. The repair command itself uses the original command as its
 *   online oracle; recurring failures graduate into this offline harness.
 */

import type { Command } from "commander";
import {
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  mkdirSync,
} from "node:fs";
import {
  join,
  resolve,
  dirname,
  basename,
  extname,
  relative,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";
import chalk from "chalk";
import { format, detectFormat } from "../output/formatter.js";
import { makeCtx } from "../output/envelope.js";
import type { OutputFormat } from "../types.js";
import { userDataRoot } from "../engine/user-home.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Bundled evals ship in the package — resolved relative to dist/src. */
const BUNDLED_EVALS_DIR = join(__dirname, "..", "..", "evals");
const USER_EVALS_DIR = join(userDataRoot(), "evals");

function userEvalsDir(): string {
  return join(userDataRoot(), "evals");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── YAML eval format ────────────────────────────────────────────────────────

export interface EvalCase {
  /** Stable case identity used by paired and held-out comparisons. */
  id?: string;
  command: string;
  args?: Record<string, string | number | boolean>;
  /** Optional pre-canned positional values */
  positional?: Array<string | number>;
  /** Optional role when one eval file is shared with an evolution workflow. */
  split?: "train" | "validation" | "held-out";
  judges: Judge[];
}

export type Judge =
  | {
      type: "arrayMinLength";
      path?: string;
      min: number;
    }
  | {
      type: "contains";
      field?: string;
      value: string;
    }
  | { type: "nonEmpty" }
  | { type: "matchesPattern"; pattern: string }
  | { type: "exitCode"; equals: number }
  | {
      type: "effectStatus";
      equals:
        | "not_applicable"
        | "confirmed"
        | "pending"
        | "unverifiable"
        | "suspected_noop";
    };

export interface EvalFile {
  name: string;
  adapter: string;
  description?: string;
  cases: EvalCase[];
}

export interface CaseResult {
  case: EvalCase;
  passed: boolean;
  output?: string;
  exitCode?: number;
  durationMs: number;
  error?: string;
  judgeResults: Array<{ judge: Judge; passed: boolean; reason?: string }>;
}

export interface EvalRunResult {
  file: EvalFile;
  passed: number;
  total: number;
  cases: CaseResult[];
}

// ── Discovery ───────────────────────────────────────────────────────────────

/** Walk a directory recursively and return all .yaml/.yml file paths. */
function walkEvalDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        stack.push(full);
      } else if (extname(entry) === ".yaml" || extname(entry) === ".yml") {
        out.push(full);
      }
    }
  }
  return out;
}

/** Return every eval file path discovered across bundled + user directories. */
export function discoverEvalFiles(): Array<{ path: string; relative: string }> {
  const result: Array<{ path: string; relative: string }> = [];
  for (const root of [BUNDLED_EVALS_DIR, userEvalsDir()]) {
    for (const file of walkEvalDir(root)) {
      result.push({
        path: file,
        relative: relative(root, file)
          .split(sep)
          .join("/")
          .replace(/\.(yaml|yml)$/, ""),
      });
    }
  }
  return result;
}

/** Resolve bundled names, files, or directories into unique eval files. */
export function findEvalFiles(targets: string[]): string[] {
  const discovered = discoverEvalFiles();
  const files = new Set<string>();
  for (const target of targets) {
    const normalized = target.replace(/\.(yaml|yml)$/, "").replace(/\/$/, "");
    const absolute = resolve(target);
    for (const entry of discovered) {
      if (
        entry.relative === normalized ||
        entry.relative.startsWith(`${normalized}/`) ||
        entry.path === absolute ||
        entry.path.startsWith(`${absolute}${sep}`)
      ) {
        files.add(entry.path);
      }
    }
    if (!existsSync(absolute)) continue;
    const stat = statSync(absolute);
    if (stat.isDirectory()) {
      walkEvalDir(absolute).forEach((file) => files.add(file));
    } else if (
      stat.isFile() &&
      [".yaml", ".yml"].includes(extname(absolute).toLowerCase())
    ) {
      files.add(absolute);
    }
  }
  return [...files].sort();
}

/** Load + parse one eval file. Throws on YAML errors so callers can report. */
export function loadEvalFile(file: string): EvalFile {
  const raw = readFileSync(file, "utf-8");
  const parsed = yaml.load(raw);
  if (
    !isRecord(parsed) ||
    typeof parsed.name !== "string" ||
    parsed.name.length === 0 ||
    typeof parsed.adapter !== "string" ||
    parsed.adapter.length === 0 ||
    !Array.isArray(parsed.cases)
  ) {
    throw new Error(
      `Invalid eval file ${file}: missing one of name/adapter/cases`,
    );
  }
  const unknownRootFields = Object.keys(parsed).filter(
    (field) => !["name", "adapter", "description", "cases"].includes(field),
  );
  if (unknownRootFields.length > 0) {
    throw new Error(
      `Invalid eval file ${file}: unknown fields ${unknownRootFields.join(", ")}`,
    );
  }
  if (
    parsed.description !== undefined &&
    typeof parsed.description !== "string"
  ) {
    throw new Error(`Invalid eval file ${file}: description must be a string`);
  }
  if (parsed.cases.length === 0) {
    throw new Error(`Invalid eval file ${file}: cases must not be empty`);
  }
  parsed.cases.forEach((value, index) => validateEvalCase(value, file, index));
  const caseIds = parsed.cases
    .map((value) => (isRecord(value) ? value.id : undefined))
    .filter((value): value is string => typeof value === "string");
  if (new Set(caseIds).size !== caseIds.length) {
    throw new Error(`Invalid eval file ${file}: case ids must be unique`);
  }
  return parsed as unknown as EvalFile;
}

function validateEvalCase(value: unknown, file: string, index: number): void {
  const label = `${file} case ${index + 1}`;
  if (
    !isRecord(value) ||
    typeof value.command !== "string" ||
    value.command.length === 0 ||
    !Array.isArray(value.judges) ||
    value.judges.length === 0
  ) {
    throw new Error(
      `Invalid eval ${label}: command and at least one judge are required`,
    );
  }
  const unknownFields = Object.keys(value).filter(
    (field) =>
      !["id", "command", "args", "positional", "split", "judges"].includes(
        field,
      ),
  );
  if (unknownFields.length > 0) {
    throw new Error(
      `Invalid eval ${label}: unknown fields ${unknownFields.join(", ")}`,
    );
  }
  if (
    value.id !== undefined &&
    (typeof value.id !== "string" || value.id.length === 0)
  ) {
    throw new Error(`Invalid eval ${label}: id must be a non-empty string`);
  }
  if (
    value.split !== undefined &&
    !["train", "validation", "held-out"].includes(String(value.split))
  ) {
    throw new Error(
      `Invalid eval ${label}: split must be train, validation, or held-out`,
    );
  }
  if (
    value.args !== undefined &&
    (!isRecord(value.args) ||
      Object.values(value.args).some((entry) => !isEvalScalar(entry)))
  ) {
    throw new Error(`Invalid eval ${label}: args must contain scalar values`);
  }
  if (
    value.positional !== undefined &&
    (!Array.isArray(value.positional) ||
      value.positional.some(
        (entry) => typeof entry !== "string" && typeof entry !== "number",
      ))
  ) {
    throw new Error(
      `Invalid eval ${label}: positional must be an array of strings or numbers`,
    );
  }
  value.judges.forEach((judge, judgeIndex) =>
    validateJudge(judge, `${label} judge ${judgeIndex + 1}`),
  );
}

function validateJudge(value: unknown, label: string): void {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error(`Invalid ${label}: judge type is required`);
  }
  switch (value.type) {
    case "exitCode":
      assertJudgeFields(value, ["type", "equals"], label);
      if (!Number.isInteger(value.equals)) {
        throw new Error(`Invalid ${label}: exitCode.equals must be an integer`);
      }
      return;
    case "effectStatus":
      assertJudgeFields(value, ["type", "equals"], label);
      if (
        ![
          "not_applicable",
          "confirmed",
          "pending",
          "unverifiable",
          "suspected_noop",
        ].includes(String(value.equals))
      ) {
        throw new Error(`Invalid ${label}: unsupported effect status`);
      }
      return;
    case "nonEmpty":
      assertJudgeFields(value, ["type"], label);
      return;
    case "matchesPattern":
      assertJudgeFields(value, ["type", "pattern"], label);
      if (typeof value.pattern !== "string") {
        throw new Error(`Invalid ${label}: pattern must be a string`);
      }
      try {
        new RegExp(value.pattern);
      } catch {
        throw new Error(`Invalid ${label}: pattern must be a valid expression`);
      }
      return;
    case "contains":
      assertJudgeFields(value, ["type", "field", "value"], label);
      if (
        typeof value.value !== "string" ||
        (value.field !== undefined && typeof value.field !== "string")
      ) {
        throw new Error(`Invalid ${label}: contains fields must be strings`);
      }
      return;
    case "arrayMinLength":
      assertJudgeFields(value, ["type", "path", "min"], label);
      if (
        typeof value.min !== "number" ||
        !Number.isInteger(value.min) ||
        value.min < 0 ||
        (value.path !== undefined && typeof value.path !== "string")
      ) {
        throw new Error(`Invalid ${label}: arrayMinLength fields are invalid`);
      }
      return;
    default:
      throw new Error(`Invalid ${label}: unsupported judge ${value.type}`);
  }
}

function assertJudgeFields(
  value: Record<string, unknown>,
  allowed: string[],
  label: string,
): void {
  const unknown = Object.keys(value).filter(
    (field) => !allowed.includes(field),
  );
  if (unknown.length > 0) {
    throw new Error(`Invalid ${label}: unknown fields ${unknown.join(", ")}`);
  }
}

function isEvalScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

// ── Judge engine ────────────────────────────────────────────────────────────

/**
 * Read a dotted path out of a JSON-like value, supporting `[N]` array
 * subscripts. Returns undefined if any segment misses.
 *
 *   pickPath({a:{b:[{c:1},{c:2}]}}, "a.b[1].c")  →  2
 */
function pickPath(value: unknown, path: string): unknown {
  if (!path) return value;
  const tokens = path.split(/[.[\]]+/).filter(Boolean);
  let current: unknown = value;
  for (const tok of tokens) {
    if (current === null || current === undefined) return undefined;
    if (/^\d+$/.test(tok)) {
      const idx = parseInt(tok, 10);
      if (!Array.isArray(current)) return undefined;
      current = current[idx];
    } else {
      if (typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[tok];
    }
  }
  return current;
}

/**
 * Apply one judge to a (parsed JSON) output. The output may be an array
 * (Uni-CLI's normal shape) or an object (less common). The judge logic
 * intentionally treats both shapes uniformly via path resolution.
 */
export function applyJudge(
  parsedOutput: unknown,
  rawOutput: string,
  exitCode: number,
  judge: Judge,
): { passed: boolean; reason?: string } {
  switch (judge.type) {
    case "exitCode":
      return {
        passed: exitCode === judge.equals,
        reason: `exit ${exitCode} vs expected ${judge.equals}`,
      };

    case "nonEmpty": {
      const target = defaultResult(parsedOutput, rawOutput);
      return {
        passed: hasContent(target),
        reason: hasContent(target) ? undefined : "output empty",
      };
    }

    case "effectStatus": {
      const status = pickPath(parsedOutput, "meta.effect_verdict.status");
      return {
        passed: status === judge.equals,
        reason:
          status === judge.equals
            ? undefined
            : `effect status ${String(status ?? "missing")} vs expected ${judge.equals}`,
      };
    }

    case "matchesPattern":
      try {
        return {
          passed: new RegExp(judge.pattern).test(rawOutput),
          reason: undefined,
        };
      } catch {
        return { passed: false, reason: `bad regex ${judge.pattern}` };
      }

    case "contains": {
      const target = judge.field
        ? pickPath(parsedOutput, judge.field)
        : defaultResult(parsedOutput, rawOutput);
      const haystack =
        typeof target === "string" ? target : JSON.stringify(target);
      return {
        passed: haystack !== undefined && haystack.includes(judge.value),
        reason: undefined,
      };
    }

    case "arrayMinLength": {
      const target = judge.path
        ? pickPath(parsedOutput, judge.path)
        : defaultResult(parsedOutput, parsedOutput);
      if (!Array.isArray(target)) {
        return {
          passed: false,
          reason: `path ${judge.path ?? "(root)"} not array`,
        };
      }
      return {
        passed: target.length >= judge.min,
        reason:
          target.length >= judge.min
            ? undefined
            : `${target.length} < ${judge.min}`,
      };
    }
  }
}

function defaultResult(parsedOutput: unknown, fallback: unknown): unknown {
  return isRecord(parsedOutput) && Object.hasOwn(parsedOutput, "data")
    ? parsedOutput.data
    : fallback;
}

function hasContent(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return value !== null && value !== undefined;
}

// ── Runner ──────────────────────────────────────────────────────────────────

/**
 * Run one case by shelling out to `unicli <adapter> <command> --format json`.
 * The shell-out path is intentional — we test the same surface area users
 * (and agents) hit, including the formatter and the exit code.
 *
 * Why exec rather than calling runPipeline directly?
 *   - Eval is a regression harness. If runPipeline drifts behind the CLI's
 *     argument parsing, an in-process call would mask the bug.
 *   - The bundled `unicli` script may not exist in dev; in that case the
 *     runner falls back to `npx tsx src/main.ts`.
 */
function buildCliInvocation(adapter: string, c: EvalCase): string[] {
  const args = [adapter, c.command];
  if (c.positional) {
    for (const p of c.positional) args.push(String(p));
  }
  for (const [k, v] of Object.entries(c.args ?? {})) {
    args.push(`--${k}`, String(v));
  }
  args.push("--format", "json");
  return args;
}

/**
 * Parse a CLI command string into [executable, ...prefixArgs]. Supports the
 * common case where `UNICLI_BIN` is a single word ("unicli") and the less
 * common case where it's a dev invocation ("npx tsx src/main.ts"). Tokens
 * are split on whitespace — we do NOT attempt to honor shell quoting rules,
 * because that would reintroduce the class of bugs this function exists to
 * prevent. If you need spaces in the executable path, move the quoted parts
 * into a wrapper script instead.
 */
function parseCliCommand(cliCommand: string): {
  executable: string;
  prefixArgs: string[];
} {
  const tokens = cliCommand.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { executable: "unicli", prefixArgs: [] };
  }
  return { executable: tokens[0], prefixArgs: tokens.slice(1) };
}

export function runCase(
  adapter: string,
  c: EvalCase,
  options: {
    timeout?: number;
    cliCommand?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): CaseResult {
  const timeout = options.timeout ?? 30_000;
  const cliCommand = options.cliCommand ?? process.env.UNICLI_BIN ?? "unicli";
  const { executable, prefixArgs } = parseCliCommand(cliCommand);
  const cliArgs = buildCliInvocation(adapter, c);

  let rawOutput = "";
  let exitCode = 0;
  let runErr: string | undefined;
  // spawnSync takes an argv array, so nothing in the args passes through a
  // shell. Positional values with spaces, quotes, or shell metachars
  // (`;`, `$(...)`, backticks) are literal argv elements, not shell syntax.
  const caseStartedAt = Date.now();
  const result = spawnSync(executable, [...prefixArgs, ...cliArgs], {
    encoding: "utf-8",
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
    env: options.env ? { ...process.env, ...options.env } : process.env,
    // Prevent child from inheriting stdin, and capture both stdout + stderr.
  });
  if (result.error) {
    runErr = result.error.message;
    exitCode = 1;
  } else {
    rawOutput = typeof result.stdout === "string" ? result.stdout : "";
    exitCode = result.status ?? 1;
    if (exitCode !== 0 && result.stderr) {
      runErr = String(result.stderr);
    }
  }

  let parsedOutput: unknown;
  try {
    parsedOutput = JSON.parse(rawOutput);
  } catch {
    parsedOutput = undefined;
  }

  const judgeResults = c.judges.map((j) => {
    const r = applyJudge(parsedOutput, rawOutput, exitCode, j);
    return { judge: j, passed: r.passed, reason: r.reason };
  });

  const passed = judgeResults.every((r) => r.passed);

  return {
    case: c,
    passed,
    output: rawOutput.slice(0, 2000),
    exitCode,
    durationMs: Date.now() - caseStartedAt,
    error: runErr,
    judgeResults,
  };
}

export function runEvalFile(
  file: EvalFile,
  options: {
    timeout?: number;
    cliCommand?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): EvalRunResult {
  const cases: CaseResult[] = [];
  let passed = 0;
  for (const c of file.cases) {
    const r = runCase(file.adapter, c, options);
    cases.push(r);
    if (r.passed) passed++;
  }
  return {
    file,
    passed,
    total: file.cases.length,
    cases,
  };
}

// ── CLI registration ────────────────────────────────────────────────────────

interface ListOptions {
  json?: boolean;
}
interface RunOptions {
  all?: boolean;
  json?: boolean;
  timeout?: string;
  cli?: string;
}
interface CiOptions {
  since?: string;
  json?: boolean;
}

/**
 * Resolve the target string + --all flag into a concrete list of eval-file
 * paths. Returns `null` when no target was given and `--all` was not passed
 * (usage error); otherwise returns the (possibly empty) list.
 */
function resolveTargets(
  target: string | undefined,
  all: Array<{ path: string; relative: string }>,
  allFlag: boolean,
): string[] | null {
  if (!target) {
    if (!allFlag) return null;
    return all.map((file) => file.path);
  }
  const files = findEvalFiles([target]);
  return allFlag ? files : files.slice(0, 1);
}

function executeEvalRuns(
  filesToRun: string[],
  timeout: number,
  cliCommand: string,
): { passedTotal: number; totalTotal: number; fileResults: EvalRunResult[] } {
  let passedTotal = 0;
  let totalTotal = 0;
  const fileResults: EvalRunResult[] = [];
  for (const path of filesToRun) {
    let evalFile: EvalFile;
    try {
      evalFile = loadEvalFile(path);
    } catch (err) {
      console.error(
        chalk.red(`Failed to load ${path}: ${(err as Error).message}`),
      );
      continue;
    }
    const result = runEvalFile(evalFile, { timeout, cliCommand });
    fileResults.push(result);
    passedTotal += result.passed;
    totalTotal += result.total;
    const ratio = `${result.passed}/${result.total}`;
    const tag =
      result.passed === result.total ? chalk.green(ratio) : chalk.red(ratio);
    console.error(`  ${tag}  ${basename(path)}  (${evalFile.adapter})`);
  }
  return { passedTotal, totalTotal, fileResults };
}

export function registerEvalCommand(program: Command): void {
  const evalCmd = program
    .command("eval")
    .description("Run declarative eval suites against adapters");

  evalCmd
    .command("list")
    .description("List discovered eval files (bundled + ~/.unicli/evals/)")
    .option("--json", "Output as JSON (alias for -f json)")
    .action((opts: ListOptions) => {
      const startedAt = Date.now();
      const ctx = makeCtx("eval.list", startedAt);
      const rootFmt = program.opts().format as OutputFormat | undefined;
      const fmt = detectFormat(opts.json ? "json" : rootFmt);

      const files = discoverEvalFiles();
      const rows = files.map((f) => ({ name: f.relative, path: f.path }));

      ctx.duration_ms = Date.now() - startedAt;
      console.log(format(rows, ["name", "path"], fmt, ctx));

      console.error(chalk.dim(`\n  ${files.length} eval file(s) discovered.`));
    });

  evalCmd
    .command("run [target]")
    .description(
      "Run one eval file or a directory (use with --all). target may be relative or absolute.",
    )
    .option("--all", "Run all evals in the target directory recursively")
    .option("--timeout <ms>", "Per-case timeout", "30000")
    .option("--cli <command>", "CLI command to test (default: unicli)")
    .option("--json", "Output as JSON (alias for -f json)")
    .action(async (target: string | undefined, opts: RunOptions) => {
      const startedAt = Date.now();
      const ctx = makeCtx("eval.run", startedAt);
      const rootFmt = program.opts().format as OutputFormat | undefined;
      const fmt = detectFormat(opts.json ? "json" : rootFmt);
      const cliCommand = opts.cli ?? process.env.UNICLI_BIN ?? "unicli";
      const timeout = parseInt(opts.timeout ?? "30000", 10) || 30_000;

      const all = discoverEvalFiles();
      const filesToRun = resolveTargets(target, all, opts.all ?? false);

      if (filesToRun === null) {
        ctx.error = {
          code: "invalid_input",
          message: "Specify a target or pass --all.",
          suggestion: "unicli eval list",
          retryable: false,
        };
        console.error(format(null, undefined, fmt, ctx));
        process.exit(2);
      }

      if (filesToRun.length === 0) {
        ctx.error = {
          code: "not_found",
          message: `No eval files matched: ${target ?? "(none)"}`,
          suggestion: "unicli eval list",
          retryable: false,
        };
        console.error(format(null, undefined, fmt, ctx));
        process.exit(2);
      }

      const { passedTotal, totalTotal, fileResults } = executeEvalRuns(
        filesToRun,
        timeout,
        cliCommand,
      );

      const data = {
        score: passedTotal,
        total: totalTotal,
        files: fileResults.map((r) => ({
          name: r.file.name,
          adapter: r.file.adapter,
          passed: r.passed,
          total: r.total,
          cases: r.cases.map((c) => ({
            command: c.case.command,
            passed: c.passed,
            exit: c.exitCode,
            failures: c.judgeResults
              .filter((j) => !j.passed)
              .map((j) => ({ judge: j.judge.type, reason: j.reason })),
          })),
        })),
      };

      ctx.duration_ms = Date.now() - startedAt;
      console.log(format(data, undefined, fmt, ctx));

      console.error(chalk.bold(`\n  SCORE=${passedTotal}/${totalTotal}`));
      process.exit(passedTotal === totalTotal ? 0 : 1);
    });

  evalCmd
    .command("ci")
    .description("Run evals for adapters touched within a recent git window")
    .option("--since <window>", "Window (e.g. 7d, 24h)", "7d")
    .option("--json", "Output as JSON (alias for -f json)")
    .action((opts: CiOptions) => {
      const startedAt = Date.now();
      const ctx = makeCtx("eval.ci", startedAt);
      const rootFmt = program.opts().format as OutputFormat | undefined;
      const fmt = detectFormat(opts.json ? "json" : rootFmt);

      const since = opts.since ?? "7d";
      const touchedAdapters = collectTouchedAdapters(since);

      const all = discoverEvalFiles();
      const filtered =
        touchedAdapters.size > 0
          ? all.filter((f) => {
              try {
                const file = loadEvalFile(f.path);
                return touchedAdapters.has(file.adapter);
              } catch {
                return false;
              }
            })
          : [];

      if (filtered.length === 0) {
        const data = { matched: 0, score: 0, total: 0, since };
        ctx.duration_ms = Date.now() - startedAt;
        console.log(format(data, undefined, fmt, ctx));
        console.error(
          chalk.dim(
            `\n  No evals match adapters touched in the last ${since}.`,
          ),
        );
        process.exit(0);
      }

      let passed = 0;
      let total = 0;
      for (const f of filtered) {
        const file = loadEvalFile(f.path);
        const r = runEvalFile(file);
        passed += r.passed;
        total += r.total;
      }

      const data = { matched: filtered.length, score: passed, total, since };
      ctx.duration_ms = Date.now() - startedAt;
      console.log(format(data, undefined, fmt, ctx));

      console.error(chalk.bold(`\n  SCORE=${passed}/${total}`));
      process.exit(passed === total ? 0 : 1);
    });
}

/** Derive the set of adapter directories touched within the given git window. */
function collectTouchedAdapters(since: string): Set<string> {
  const touchedAdapters = new Set<string>();
  // Validate `since` matches a safe shape before passing to git — git accepts
  // a wide range of time specs, but we restrict to digits + unit letters to
  // avoid surprising behavior from pathological input.
  if (!/^[0-9]+(d|h|m|s|w)?$|^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(since)) {
    return touchedAdapters;
  }
  const git = spawnSync(
    "git",
    [
      "log",
      `--since=${since}`,
      "--name-only",
      "--pretty=format:",
      "--",
      "src/adapters",
    ],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
  );
  if (git.error || git.status !== 0) return touchedAdapters;
  const out = typeof git.stdout === "string" ? git.stdout : "";
  for (const line of out.split("\n")) {
    const m = line.match(/^src\/adapters\/([^/]+)\//);
    if (m) touchedAdapters.add(m[1]);
  }
  return touchedAdapters;
}

// Re-export for tests / programmatic use
export { BUNDLED_EVALS_DIR, USER_EVALS_DIR };

/**
 * Helper used only by tests: ensure user evals directory exists. Not used
 * by production code paths.
 */
export function ensureUserEvalsDir(): string {
  const path = userEvalsDir();
  mkdirSync(path, { recursive: true });
  return path;
}
