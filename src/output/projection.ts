/**
 * Output-side projection helpers — `--select` / `--fields` / `--pluck`.
 *
 * These flags externalize the `| jq` / `| awk` step agents used to apply to
 * `unicli` output. The kernel produces a raw `results[]` array; the CLI
 * surface projects it *before* `format()` so every envelope format (json /
 * yaml / md / csv / compact) benefits. MCP and ACP do NOT honor these —
 * they speak JSON, agents project client-side.
 *
 * Precedence (highest wins when multiple flags are set):
 *   --pluck  >  --select  >  --fields
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
  /** Single field name → newline-delimited stream (wins over other flags). */
  pluck?: string;
}

export interface ProjectionResult {
  /** The results array after `--select` / `--pluck` have been applied. */
  results: unknown[];
  /** The columns override from `--fields` (undefined when unset). */
  columns: string[] | undefined;
  /** When true, caller must emit a plain-text newline-delimited stream. */
  pluckMode: boolean;
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
 */
function applySelect(results: unknown[], path: string): unknown[] {
  // jsonpath-plus wraps results in an array unless `wrap: false`; with
  // `wrap: false` a scalar result comes back as the scalar itself, an
  // empty match comes back as `false`, and a multi-match stays as an
  // array. We normalize every branch so the caller always gets `unknown[]`.
  const hit = JSONPath({ path, json: results, wrap: false });
  if (Array.isArray(hit)) return hit;
  if (hit === undefined || hit === null || hit === false) return [];
  return [hit];
}

/**
 * Render a single row as the stringified value of the plucked field. Nested
 * objects serialize as JSON (one line, no indent) so agents can still pipe
 * the stream into `xargs -I{} jq ...` if a column happens to be structured.
 */
export function pluckRow(row: unknown, field: string): string {
  if (row === null || row === undefined) return "";
  if (typeof row !== "object") return String(row);
  const value = (row as Record<string, unknown>)[field];
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
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

  // Pluck wins — caller emits newline-delimited single-column stream.
  if (options.pluck !== undefined) {
    return { results, columns: undefined, pluckMode: true };
  }

  if (options.select !== undefined) {
    const projected = applySelect(results, options.select);
    return { results: projected, columns: undefined, pluckMode: false };
  }

  if (options.fields !== undefined) {
    return {
      results,
      columns: parseFields(options.fields),
      pluckMode: false,
    };
  }

  return { results, columns: undefined, pluckMode: false };
}

/**
 * Render `results` as the `--pluck` plain-text stream. One row per line,
 * field value stringified via `pluckRow`. No header, no trailing newline
 * (the caller adds it through `console.log`).
 */
export function renderPluck(results: unknown[], field: string): string {
  return results.map((row) => pluckRow(row, field)).join("\n");
}
