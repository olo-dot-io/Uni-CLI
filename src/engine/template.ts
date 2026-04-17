/**
 * Pipeline template engine — ${{ expression | filter | ... }} evaluation.
 *
 * Extracted from the legacy yaml-runner so per-step handlers can share a
 * single implementation. The expression evaluator uses a null-prototype VM
 * sandbox with a 50ms timeout and a deny-list for prototype-chain escape
 * vectors; simple dotted access bypasses the VM for performance.
 */

import { runInNewContext } from "node:vm";
import type { PipelineContext } from "./executor.js";

/**
 * Built-in pipe filters — used in template expressions like:
 *   ${{ item.tags | join(', ') }}
 *   ${{ args.word | urlencode }}
 *   ${{ item.text | slice(0, 200) }}
 */
export const PIPE_FILTERS: Record<string, (...args: unknown[]) => unknown> = {
  join: (val: unknown, sep: unknown) =>
    Array.isArray(val) ? val.join(String(sep ?? ", ")) : String(val ?? ""),
  urlencode: (val: unknown) => encodeURIComponent(String(val ?? "")),
  slice: (val: unknown, start: unknown, end: unknown) => {
    const s = String(val ?? "");
    return s.slice(
      Number(start) || 0,
      end !== undefined ? Number(end) : undefined,
    );
  },
  replace: (val: unknown, search: unknown, replacement: unknown) =>
    String(val ?? "").replace(
      new RegExp(String(search), "g"),
      String(replacement ?? ""),
    ),
  lowercase: (val: unknown) => String(val ?? "").toLowerCase(),
  uppercase: (val: unknown) => String(val ?? "").toUpperCase(),
  trim: (val: unknown) => String(val ?? "").trim(),
  default: (val: unknown, fallback: unknown) =>
    val == null || val === "" ? fallback : val,
  split: (val: unknown, sep: unknown) =>
    String(val ?? "").split(String(sep ?? ",")),
  first: (val: unknown) => (Array.isArray(val) ? val[0] : val),
  last: (val: unknown) => (Array.isArray(val) ? val[val.length - 1] : val),
  length: (val: unknown) =>
    Array.isArray(val) ? val.length : String(val ?? "").length,
  strip_html: (val: unknown) => String(val ?? "").replace(/<[^>]+>/g, ""),
  truncate: (val: unknown, max: unknown) => {
    const s = String(val ?? "");
    const n = Number(max) || 100;
    return s.length > n ? s.slice(0, n) + "..." : s;
  },
  slugify: (val: unknown) => {
    return String(val ?? "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  },
  sanitize: (val: unknown) =>
    String(val ?? "")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .replace(/^\.+/, "")
      .trim() || "download",
  ext: (val: unknown) => {
    try {
      const pathname = new URL(String(val)).pathname;
      const dot = pathname.lastIndexOf(".");
      return dot > 0 ? pathname.slice(dot + 1) : "";
    } catch {
      const s = String(val ?? "");
      const dot = s.lastIndexOf(".");
      return dot > 0 ? s.slice(dot + 1).split(/[?#]/)[0] : "";
    }
  },
  basename: (val: unknown) => {
    try {
      const pathname = new URL(String(val)).pathname;
      return pathname.split("/").pop() ?? "";
    } catch {
      return (
        String(val ?? "")
          .split("/")
          .pop() ?? ""
      );
    }
  },
  keys: (val: unknown) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.keys(val)
      : [],
  json: (val: unknown) => JSON.stringify(val),
  abs: (val: unknown) => Math.abs(Number(val) || 0),
  round: (val: unknown) => Math.round(Number(val) || 0),
  ceil: (val: unknown) => Math.ceil(Number(val) || 0),
  floor: (val: unknown) => Math.floor(Number(val) || 0),
  int: (val: unknown) => parseInt(String(val), 10) || 0,
  float: (val: unknown) => parseFloat(String(val)) || 0,
  str: (val: unknown) => String(val ?? ""),
  reverse: (val: unknown) =>
    Array.isArray(val)
      ? [...val].reverse()
      : String(val ?? "")
          .split("")
          .reverse()
          .join(""),
  unique: (val: unknown) => (Array.isArray(val) ? [...new Set(val)] : val),
};

/**
 * Parse pipe filters from expression: "expr | filter1(arg) | filter2"
 * Returns { baseExpr, filters: [{ name, args }] }
 */
function parsePipes(expr: string): {
  baseExpr: string;
  filters: Array<{ name: string; args: string[] }>;
} {
  // Only split on | that is NOT inside parentheses, quotes, or array syntax
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let inStr: string | null = null;

  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (inStr) {
      current += ch;
      if (ch === inStr && expr[i - 1] !== "\\") inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "[") {
      depth++;
      current += ch;
      continue;
    }
    if (ch === ")" || ch === "]") {
      depth--;
      current += ch;
      continue;
    }
    if (ch === "|" && depth === 0 && expr[i + 1] !== "|") {
      // Check it's not || (logical OR)
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current.trim());

  if (parts.length <= 1) return { baseExpr: expr, filters: [] };

  const baseExpr = parts[0];
  const filters = parts.slice(1).map((f) => {
    const m = f.match(/^(\w+)\((.*)\)$/s);
    if (m) {
      // Parse args — simple comma split respecting strings
      const rawArgs = m[2].trim();
      const args = rawArgs ? splitFilterArgs(rawArgs) : [];
      return { name: m[1], args };
    }
    return { name: f.trim(), args: [] };
  });

  return { baseExpr, filters };
}

function splitFilterArgs(raw: string): string[] {
  const args: string[] = [];
  let current = "";
  let inStr: string | null = null;
  let depth = 0;
  for (const ch of raw) {
    if (inStr) {
      current += ch;
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      current += ch;
      continue;
    }
    if (ch === "(") {
      depth++;
      current += ch;
      continue;
    }
    if (ch === ")") {
      depth--;
      current += ch;
      continue;
    }
    if (ch === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  args.push(current.trim());
  return args;
}

/** Patterns that must never appear in evaluated expressions. */
const FORBIDDEN_EXPR =
  /constructor|__proto__|prototype|globalThis|process|require|import\s*\(|eval\s*\(/;

/**
 * Safe expression evaluator using Node.js VM sandbox.
 * Provides stronger isolation than `new Function()` with a 50ms timeout
 * to prevent DoS. Simple dotted access (the most common case) uses a
 * fast path that avoids the VM overhead entirely.
 *
 * Supports pipe filters: ${{ expr | join(', ') | slice(0, 100) }}
 */
export function evalExpression(
  expr: string,
  scope: Record<string, unknown>,
): unknown {
  try {
    // Security: reject dangerous patterns
    if (FORBIDDEN_EXPR.test(expr)) return undefined;

    const { baseExpr, filters } = parsePipes(expr);

    // Fast path: simple dotted access like "item.title" or "args.query"
    if (/^[a-zA-Z_][\w.]*(\[\d+\])?$/.test(baseExpr)) {
      let result: unknown = resolveDottedPath(baseExpr, scope);
      for (const filter of filters) {
        const filterFn = PIPE_FILTERS[filter.name];
        if (!filterFn) continue;
        const evaledArgs = filter.args.map((a) => resolveFilterArg(a, scope));
        result = filterFn(result, ...evaledArgs);
      }
      return result;
    }

    // VM sandbox evaluation with 50ms timeout.
    // SECURITY: Create a null-prototype sandbox to prevent prototype chain escape.
    // Node.js vm is NOT a security boundary — host objects leak constructors.
    // We mitigate by: (1) null-prototype sandbox, (2) frozen copies of built-ins,
    // (3) contextCodeGeneration restriction, (4) FORBIDDEN_EXPR pre-check.
    const sandbox = Object.create(null) as Record<string, unknown>;
    // Copy scope values (args, item, index, etc.) — shallow copy with null prototype
    for (const [k, v] of Object.entries(scope)) {
      sandbox[k] = v;
    }
    // Add safe built-ins as frozen copies (prevents constructor chain traversal)
    sandbox.encodeURIComponent = encodeURIComponent;
    sandbox.decodeURIComponent = decodeURIComponent;
    sandbox.JSON = { parse: JSON.parse, stringify: JSON.stringify };
    sandbox.Math = Object.freeze({ ...Math });
    sandbox.parseInt = parseInt;
    sandbox.parseFloat = parseFloat;
    sandbox.isNaN = isNaN;
    sandbox.isFinite = isFinite;

    let result: unknown;
    try {
      // 250 ms is comfortably above Windows-CI cold-start cost for the first
      // VM context (observed up to ~80 ms on Node 20 + windows-latest) and
      // still well below any reasonable expression-eval budget. The hardened
      // sandbox (null prototype + frozen built-ins + FORBIDDEN_EXPR pre-check)
      // is the actual security boundary, not the timeout.
      result = runInNewContext(`(${baseExpr})`, sandbox, {
        timeout: 250,
        contextCodeGeneration: { strings: false, wasm: false },
      });
    } catch {
      return undefined;
    }

    // Apply pipe filters
    for (const filter of filters) {
      const filterFn = PIPE_FILTERS[filter.name];
      if (!filterFn) continue;
      const evaledArgs = filter.args.map((a) => resolveFilterArg(a, scope));
      result = filterFn(result, ...evaledArgs);
    }

    return result;
  } catch {
    return undefined;
  }
}

/** Resolve a dotted path like "item.tags[0]" against the scope object. */
function resolveDottedPath(
  path: string,
  scope: Record<string, unknown>,
): unknown {
  // Handle array index: "item.tags[0]"
  const cleanPath = path.replace(/\[(\d+)\]/g, ".$1");
  const parts = cleanPath.split(".");
  let current: unknown = scope[parts[0]];
  for (let i = 1; i < parts.length; i++) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[parts[i]];
  }
  return current;
}

/** Resolve a single filter argument — string literal, number, or expression. */
function resolveFilterArg(a: string, scope: Record<string, unknown>): unknown {
  // String literal
  if (
    (a.startsWith("'") && a.endsWith("'")) ||
    (a.startsWith('"') && a.endsWith('"'))
  ) {
    return a.slice(1, -1);
  }
  // Number
  if (/^-?\d+(\.\d+)?$/.test(a)) return Number(a);
  // Security check
  if (FORBIDDEN_EXPR.test(a)) return a;
  // Expression via VM (same hardened sandbox as evalExpression)
  try {
    const sandbox = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of Object.entries(scope)) sandbox[k] = v;
    sandbox.JSON = { parse: JSON.parse, stringify: JSON.stringify };
    sandbox.Math = Object.freeze({ ...Math });
    sandbox.parseInt = parseInt;
    sandbox.parseFloat = parseFloat;
    return runInNewContext(`(${a})`, sandbox, {
      timeout: 50,
      contextCodeGeneration: { strings: false, wasm: false },
    });
  } catch {
    return a;
  }
}

/**
 * Evaluate ${{ expression }} templates in a string.
 * Returns the raw value if the entire string is a single expression,
 * otherwise returns a string with interpolated values.
 */
export function evalTemplate(template: string, ctx: PipelineContext): string {
  const fullMatch = template.match(/^\$\{\{\s*(.+?)\s*\}\}$/);
  if (fullMatch) {
    const result = evalExpression(fullMatch[1], buildScope(ctx));
    return String(result ?? "");
  }

  return template.replace(/\$\{\{\s*(.+?)\s*\}\}/g, (_match, expr: string) => {
    const result = evalExpression(expr, buildScope(ctx));
    return String(result ?? "");
  });
}

export function buildScope(ctx: PipelineContext): Record<string, unknown> {
  const scope: Record<string, unknown> = {
    args: ctx.args,
    vars: ctx.vars ?? {},
    base: ctx.base,
    temp: ctx.temp ?? {},
  };

  if (
    ctx.data &&
    typeof ctx.data === "object" &&
    "item" in (ctx.data as Record<string, unknown>)
  ) {
    const d = ctx.data as Record<string, unknown>;
    scope.item = d.item;
    scope.index = d.index;
  } else {
    scope.item = ctx.data;
  }

  return scope;
}

/**
 * Recursively resolve ${{ }} templates in nested objects, arrays, and strings.
 * Non-string primitives (numbers, booleans, null) pass through unchanged.
 */
export function resolveTemplateDeep(
  value: unknown,
  ctx: PipelineContext,
): unknown {
  if (typeof value === "string") {
    return evalTemplate(value, ctx);
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveTemplateDeep(v, ctx));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = resolveTemplateDeep(v, ctx);
    }
    return result;
  }
  return value;
}

/**
 * Navigate nested object by dot-path: "data.list[].title"
 */
export function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (current == null) return undefined;

    if (part.endsWith("[]")) {
      const key = part.slice(0, -2);
      if (key) {
        current = (current as Record<string, unknown>)[key];
      }
      // current should now be an array — continue traversing
    } else {
      current = (current as Record<string, unknown>)[part];
    }
  }

  return current;
}
