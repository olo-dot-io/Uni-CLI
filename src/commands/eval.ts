/**
 * Eval harness — declarative regression suite for adapters.
 *
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
 *   v0.207 shipped the eval *primitive* (`src/engine/repair/eval.ts`).
 *   v0.208 ships the *content*: a starter catalog so the self-repair loop
 *   has measurable baselines. Without baselines, claimed improvements are
 *   noise. The CLI command is the on-ramp; the YAML files are the data.
 */

import type { Command } from "commander";
import {
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { join, resolve, dirname, basename, extname, relative } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";
import chalk from "chalk";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Bundled evals ship in the package — resolved relative to dist/src. */
const BUNDLED_EVALS_DIR = join(__dirname, "..", "..", "evals");
const USER_EVALS_DIR = join(homedir(), ".unicli", "evals");

// ── YAML eval format ────────────────────────────────────────────────────────

export interface EvalCase {
  command: string;
  args?: Record<string, string | number | boolean>;
  /** Optional pre-canned positional values */
  positional?: Array<string | number>;
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
  | { type: "exitCode"; equals: number };

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
  for (const root of [BUNDLED_EVALS_DIR, USER_EVALS_DIR]) {
    for (const file of walkEvalDir(root)) {
      result.push({
        path: file,
        relative: relative(root, file).replace(/\.(yaml|yml)$/, ""),
      });
    }
  }
  return result;
}

/** Load + parse one eval file. Throws on YAML errors so callers can report. */
export function loadEvalFile(file: string): EvalFile {
  const raw = readFileSync(file, "utf-8");
  const parsed = yaml.load(raw) as EvalFile;
  if (!parsed.name || !parsed.adapter || !Array.isArray(parsed.cases)) {
    throw new Error(
      `Invalid eval file ${file}: missing one of name/adapter/cases`,
    );
  }
  return parsed;
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

    case "nonEmpty":
      return {
        passed: rawOutput.trim().length > 0,
        reason: rawOutput.trim().length > 0 ? undefined : "output empty",
      };

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
        : rawOutput;
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
        : parsedOutput;
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
  options: { timeout?: number; cliCommand?: string } = {},
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
  const result = spawnSync(executable, [...prefixArgs, ...cliArgs], {
    encoding: "utf-8",
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
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
    error: runErr,
    judgeResults,
  };
}

export function runEvalFile(
  file: EvalFile,
  options: { timeout?: number; cliCommand?: string } = {},
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

export function registerEvalCommand(program: Command): void {
  const evalCmd = program
    .command("eval")
    .description("Run declarative eval suites against adapters");

  evalCmd
    .command("list")
    .description("List discovered eval files (bundled + ~/.unicli/evals/)")
    .option("--json", "Output as JSON")
    .action((opts: ListOptions) => {
      const files = discoverEvalFiles();
      if (opts.json) {
        console.log(
          JSON.stringify(
            files.map((f) => ({ name: f.relative, path: f.path })),
            null,
            2,
          ),
        );
        return;
      }
      console.log(chalk.bold(`${files.length} eval file(s):`));
      for (const f of files) {
        console.log(`  ${chalk.cyan(f.relative)}  ${chalk.dim(f.path)}`);
      }
    });

  evalCmd
    .command("run [target]")
    .description(
      "Run one eval file or a directory (use with --all). target may be relative or absolute.",
    )
    .option("--all", "Run all evals in the target directory recursively")
    .option("--timeout <ms>", "Per-case timeout", "30000")
    .option("--cli <command>", "CLI command to test (default: unicli)")
    .option("--json", "Output as JSON")
    .action(async (target: string | undefined, opts: RunOptions) => {
      const cliCommand = opts.cli ?? process.env.UNICLI_BIN ?? "unicli";
      const timeout = parseInt(opts.timeout ?? "30000", 10) || 30_000;

      const filesToRun: string[] = [];
      const all = discoverEvalFiles();

      if (!target) {
        if (!opts.all) {
          console.error(chalk.red("Specify a target or pass --all."));
          process.exit(2);
        }
        filesToRun.push(...all.map((f) => f.path));
      } else if (opts.all) {
        // Treat target as a directory. Two cases:
        //   1. Relative name like "smoke" or "smoke/" → match f.relative prefix
        //   2. Absolute or file:// path → resolve and match f.path prefix
        const resolvedTarget = resolve(target);
        const isExistingAbs = target.startsWith("/") || target.startsWith("~/");
        for (const f of all) {
          const relativeMatch =
            f.relative === target ||
            f.relative.startsWith(`${target.replace(/\/$/, "")}/`);
          const absoluteMatch =
            isExistingAbs &&
            (f.path === resolvedTarget ||
              f.path.startsWith(`${resolvedTarget.replace(/\/$/, "")}/`));
          if (relativeMatch || absoluteMatch) {
            filesToRun.push(f.path);
          }
        }
      } else {
        // Treat target as a file (with or without extension)
        const candidate = all.find(
          (f) =>
            f.relative === target ||
            f.relative === target.replace(/\.(yaml|yml)$/, ""),
        );
        if (candidate) {
          filesToRun.push(candidate.path);
        } else if (existsSync(resolve(target))) {
          filesToRun.push(resolve(target));
        }
      }

      if (filesToRun.length === 0) {
        console.error(
          chalk.red(`No eval files matched: ${target ?? "(none)"}`),
        );
        process.exit(2);
      }

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
        if (!opts.json) {
          const ratio = `${result.passed}/${result.total}`;
          const tag =
            result.passed === result.total
              ? chalk.green(ratio)
              : chalk.red(ratio);
          console.log(`  ${tag}  ${basename(path)}  (${evalFile.adapter})`);
          for (const c of result.cases) {
            const dot = c.passed ? chalk.green("✓") : chalk.red("✗");
            console.log(`    ${dot} ${c.case.command}`);
            if (!c.passed) {
              for (const j of c.judgeResults.filter((j) => !j.passed)) {
                console.log(
                  `        ${chalk.red("·")} ${j.judge.type} — ${j.reason ?? "fail"}`,
                );
              }
            }
          }
        }
      }

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
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
            },
            null,
            2,
          ),
        );
      } else {
        console.log();
        console.log(chalk.bold(`SCORE=${passedTotal}/${totalTotal}`));
      }

      // Exit non-zero on any failure for CI integration
      process.exit(passedTotal === totalTotal ? 0 : 1);
    });

  evalCmd
    .command("ci")
    .description("Run evals for adapters touched within a recent git window")
    .option("--since <window>", "Window (e.g. 7d, 24h)", "7d")
    .option("--json", "Output as JSON")
    .action((opts: CiOptions) => {
      // Best-effort: list adapters changed in the window via `git log`. We
      // intentionally tolerate non-git workspaces by skipping the filter.
      // `since` is passed as an argv element, not interpolated into a shell
      // string, so hostile values cannot escape into git or sh.
      const since = opts.since ?? "7d";
      const touchedAdapters = new Set<string>();
      // Validate `since` matches a safe shape before passing to git — git
      // accepts a wide range of time specs, but we restrict to digits + unit
      // letters to avoid surprising behavior from pathological input.
      if (/^[0-9]+(d|h|m|s|w)?$|^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(since)) {
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
        if (!git.error && git.status === 0) {
          const out = typeof git.stdout === "string" ? git.stdout : "";
          for (const line of out.split("\n")) {
            const m = line.match(/^src\/adapters\/([^/]+)\//);
            if (m) touchedAdapters.add(m[1]);
          }
        }
      }

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
        if (opts.json) {
          console.log(JSON.stringify({ matched: 0, score: 0, total: 0 }));
        } else {
          console.log(
            chalk.dim(
              `No evals match adapters touched in the last ${since}. Skipping.`,
            ),
          );
        }
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
      if (opts.json) {
        console.log(
          JSON.stringify({ matched: filtered.length, score: passed, total }),
        );
      } else {
        console.log(chalk.bold(`SCORE=${passed}/${total}`));
      }
      process.exit(passed === total ? 0 : 1);
    });
}

// Re-export for tests / programmatic use
export { BUNDLED_EVALS_DIR, USER_EVALS_DIR };

/**
 * Helper used only by tests: ensure user evals directory exists. Not used
 * by production code paths.
 */
export function ensureUserEvalsDir(): string {
  mkdirSync(USER_EVALS_DIR, { recursive: true });
  return USER_EVALS_DIR;
}
