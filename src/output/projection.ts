/**
 * Output-side projection helpers — `--select` / `--fields` / `--pluck` / `--pluck0`.
 *
 * These flags externalize the `| jq` / `| awk` step agents used to apply to
 * `unicli` output. The kernel produces a raw `results[]` array; the CLI
 * surface projects it *before* `format()` so every envelope format (json /
 * yaml / md / csv / compact) benefits. MCP and ACP do NOT honor these —
 * they speak JSON, agents project client-side.
 *
 * Precedence (highest wins when multiple flags are set):
 *   --pluck0  >  --pluck  >  --select  >  --fields
 *
 * When multiple are set, a single stderr warning is emitted and only the
 * highest-priority flag applies.
 */

import { JSONPath } from "jsonpath-plus";

export interface ProjectionOptions {
  /** JSONPath expression applied to the results array. */
  select?: string;
  /** Comma-separated column list (used when rendering tabular output). */
  fields?: string;
  /** Single field name → newline-delimited stream (wins over select/fields). */
  pluck?: string;
  /** Single field name → NUL-delimited stream (wins over pluck). */
  pluck0?: string;
}

/** Thrown when `--select` fails to parse. Distinguishes user typo from empty match. */
export class ProjectionError extends Error {
  constructor(
    message: string,
    public readonly detail: {
      flag: "select";
      expression: string;
      cause: string;
    },
  ) {
    super(message);
    this.name = "ProjectionError";
  }
}

export interface ProjectionResult {
  /** The results array after `--select` / `--pluck` / `--pluck0` have been applied. */
  results: unknown[];
  /** The columns override from `--fields` (undefined when unset). */
  columns: string[] | undefined;
  /** When true, caller must emit a plain-text newline-delimited stream. */
  pluckMode: boolean;
  /** When true, caller must emit a NUL-delimited stream (for `xargs -0`). */
  pluck0Mode: boolean;
}

/**
 * Parse the comma-separated column list from `--fields`. Whitespace around
 * column names is trimmed; empty entries are dropped so `--fields ,a,b,`
 * → `["a", "b"]`.
 */
function parseFields(spec: string): string[] {
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Apply a JSONPath expression to the results array. `$` refers to the
 * array itself, so `$[0]` is the first row and `$[*].title` is every
 * title. Returns the raw matches from jsonpath-plus — when the path
 * resolves to a single value we still return it as a one-row array so
 * downstream formatters stay array-shaped.
 *
 * Malformed expressions (unclosed brackets, syntax errors) throw
 * `ProjectionError` — distinguishing a user typo from a legitimate
 * zero-match is critical for agent self-repair.
 */
function applySelect(results: unknown[], path: string): unknown[] {
  // Pre-validation — jsonpath-plus swallows many malformed paths (unclosed
  // bracket, trailing `.`) and returns undefined silently, which makes
  // "typo" indistinguishable from "legit zero match" for the agent's
  // self-repair loop. We catch the obvious shapes here so the Error
  // clearly blames the expression.
  const typed = path.trim();
  if (typed.length === 0) {
    throw new ProjectionError(`--select parse error: empty expression`, {
      flag: "select",
      expression: path,
      cause: "empty",
    });
  }
  if (!typed.startsWith("$")) {
    throw new ProjectionError(
      `--select parse error: expression must start with '$' (expression: ${path})`,
      { flag: "select", expression: path, cause: "missing root $" },
    );
  }
  // Bracket balance — `$.items[` / `$[0` / `$[?(` produce undefined
  // silently inside jsonpath-plus; we prefer a loud error so the agent
  // can re-render the path.
  let square = 0;
  let paren = 0;
  let inStr: string | null = null;
  for (let i = 0; i < typed.length; i++) {
    const ch = typed[i];
    if (inStr) {
      if (ch === inStr && typed[i - 1] !== "\\") inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      continue;
    }
    if (ch === "[") square++;
    else if (ch === "]") square--;
    else if (ch === "(") paren++;
    else if (ch === ")") paren--;
  }
  if (square !== 0 || paren !== 0 || inStr !== null) {
    throw new ProjectionError(
      `--select parse error: unbalanced ${square !== 0 ? "brackets" : paren !== 0 ? "parentheses" : "quotes"} (expression: ${path})`,
      {
        flag: "select",
        expression: path,
        cause: `unbalanced ${square !== 0 ? "[]" : paren !== 0 ? "()" : "quotes"}`,
      },
    );
  }

  // jsonpath-plus wraps results in an array unless `wrap: false`; with
  // `wrap: false` a scalar result comes back as the scalar itself, an
  // empty match comes back as `false`, and a multi-match stays as an
  // array. We normalize every branch so the caller always gets `unknown[]`.
  let hit: unknown;
  try {
    hit = JSONPath({ path, json: results, wrap: false });
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new ProjectionError(
      `--select parse error: ${cause} (expression: ${path})`,
      { flag: "select", expression: path, cause },
    );
  }
  if (Array.isArray(hit)) return hit;
  if (hit === undefined || hit === null || hit === false) return [];
  return [hit];
}

/**
 * Render a single row as the stringified value of the plucked field. Nested
 * objects serialize as JSON (one line, no indent) so agents can still pipe
 * the stream into `xargs -I{} jq ...` if a column happens to be structured.
 *
 * Newlines in string values are collapsed to a single space — a raw `\n`
 * would break every `while read` / `xargs -n1` loop downstream. Callers
 * that need newline-preserving output should use `--format json` instead.
 * Returns both the sanitized string and a flag indicating whether any
 * `\r` or `\n` was stripped, so the caller can emit one debounced warning
 * per invocation.
 */
export function pluckRow(
  row: unknown,
  field: string,
): { value: string; sanitized: boolean } {
  if (row === null || row === undefined) return { value: "", sanitized: false };
  if (typeof row !== "object") {
    return sanitizeNewlines(String(row));
  }
  const value = (row as Record<string, unknown>)[field];
  if (value === null || value === undefined)
    return { value: "", sanitized: false };
  if (typeof value === "object") return sanitizeNewlines(JSON.stringify(value));
  return sanitizeNewlines(String(value));
}

function sanitizeNewlines(s: string): { value: string; sanitized: boolean } {
  if (!/[\r\n]/.test(s)) return { value: s, sanitized: false };
  return { value: s.replace(/[\r\n]+/g, " "), sanitized: true };
}

/**
 * Apply the three projection flags in priority order. Returns the
 * post-projection `results`, the column override (for `--fields`), and
 * a `pluckMode` flag that directs the caller to print a newline-delimited
 * stream instead of a formatted envelope.
 *
 * A single stderr warning is emitted when more than one flag is set so
 * the agent can see that a lower-priority flag was suppressed.
 */
export function applyProjection(
  results: unknown[],
  options: ProjectionOptions,
  warn: (msg: string) => void = (msg) => process.stderr.write(msg + "\n"),
): ProjectionResult {
  const setFlags: Array<keyof ProjectionOptions> = [];
  if (options.pluck0 !== undefined) setFlags.push("pluck0");
  if (options.pluck !== undefined) setFlags.push("pluck");
  if (options.select !== undefined) setFlags.push("select");
  if (options.fields !== undefined) setFlags.push("fields");

  if (setFlags.length > 1) {
    const winner = setFlags[0];
    const losers = setFlags.slice(1).join(", ");
    warn(
      `[projection] multiple flags set (${setFlags.join(", ")}); "--${winner}" wins, ignoring: ${losers}`,
    );
  }

  // --pluck0 wins — NUL-delimited stream (for `xargs -0`).
  if (options.pluck0 !== undefined) {
    return {
      results,
      columns: undefined,
      pluckMode: false,
      pluck0Mode: true,
    };
  }

  // --pluck — newline-delimited single-column stream.
  if (options.pluck !== undefined) {
    return {
      results,
      columns: undefined,
      pluckMode: true,
      pluck0Mode: false,
    };
  }

  if (options.select !== undefined) {
    const projected = applySelect(results, options.select);
    return {
      results: projected,
      columns: undefined,
      pluckMode: false,
      pluck0Mode: false,
    };
  }

  if (options.fields !== undefined) {
    return {
      results,
      columns: parseFields(options.fields),
      pluckMode: false,
      pluck0Mode: false,
    };
  }

  return {
    results,
    columns: undefined,
    pluckMode: false,
    pluck0Mode: false,
  };
}

/**
 * Render `results` as the `--pluck` plain-text stream. One row per line,
 * field value stringified via `pluckRow`. No header, no trailing newline
 * (the caller adds it through `console.log`).
 *
 * A single stderr warning is emitted if any value had embedded newlines
 * stripped — agents that need newline-preserving output should use
 * `--format json` instead. Warning is debounced: one line per invocation,
 * not one line per row.
 */
export function renderPluck(
  results: unknown[],
  field: string,
  warn: (msg: string) => void = (msg) => process.stderr.write(msg + "\n"),
): string {
  let sanitizedCount = 0;
  const lines = results.map((row) => {
    const r = pluckRow(row, field);
    if (r.sanitized) sanitizedCount++;
    return r.value;
  });
  if (sanitizedCount > 0) {
    warn(`[pluck] sanitized ${sanitizedCount} value(s) containing newlines`);
  }
  return lines.join("\n");
}

/**
 * Render `results` as the `--pluck0` NUL-delimited stream (xargs -0).
 * Each value is followed by `\0`, including the last one — matches the
 * convention of `find -print0` so downstream `xargs -0` counts rows
 * correctly. Same newline-sanitization as `--pluck`.
 */
export function renderPluck0(
  results: unknown[],
  field: string,
  warn: (msg: string) => void = (msg) => process.stderr.write(msg + "\n"),
): string {
  let sanitizedCount = 0;
  const parts: string[] = [];
  for (const row of results) {
    const r = pluckRow(row, field);
    if (r.sanitized) sanitizedCount++;
    parts.push(r.value + "\0");
  }
  if (sanitizedCount > 0) {
    warn(`[pluck] sanitized ${sanitizedCount} value(s) containing newlines`);
  }
  return parts.join("");
}
