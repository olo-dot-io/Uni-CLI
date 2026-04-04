/**
 * YAML Pipeline Execution Engine — the Flight Computer.
 *
 * Executes pipeline steps defined in YAML adapters:
 *   fetch    → HTTP request (GET/POST)
 *   select   → Extract nested field from response
 *   map      → Transform each item using template expressions
 *   filter   → Keep items matching a condition
 *   limit    → Cap the number of results
 *   html_to_md → Convert HTML to Markdown via turndown
 *   evaluate → Run JS expression (for browser adapters, future)
 *
 * Template syntax: ${{ expression }}
 *   Available variables: item, index, args, base
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import TurndownService from "turndown";
import type { PipelineStep } from "../types.js";

const execFileAsync = promisify(execFile);

type PipelineContext = {
  data: unknown;
  args: Record<string, unknown>;
  base?: string;
};

/**
 * Structured pipeline error — designed for AI agent consumption.
 * An agent receiving this error can read the adapter YAML, understand
 * exactly what failed, and edit the file to fix it.
 */
export class PipelineError extends Error {
  constructor(
    message: string,
    public readonly detail: {
      step: number;
      action: string;
      config: unknown;
      errorType:
        | "http_error"
        | "selector_miss"
        | "empty_result"
        | "parse_error"
        | "timeout"
        | "expression_error";
      url?: string;
      statusCode?: number;
      responsePreview?: string;
      suggestion: string;
    },
  ) {
    super(message);
    this.name = "PipelineError";
  }

  /** JSON output for AI agents — includes everything needed to self-repair */
  toAgentJSON(adapterPath?: string) {
    return {
      error: this.message,
      adapter: adapterPath,
      ...this.detail,
    };
  }
}

export async function runPipeline(
  steps: PipelineStep[],
  args: Record<string, unknown>,
  base?: string,
): Promise<unknown[]> {
  let ctx: PipelineContext = { data: null, args, base };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const [action, config] = Object.entries(step)[0];

    try {
      switch (action) {
        case "fetch":
          ctx = await stepFetch(ctx, config as FetchConfig);
          break;
        case "fetch_text":
          ctx = await stepFetchText(ctx, config as FetchConfig);
          break;
        case "parse_rss":
          ctx = stepParseRss(ctx, config as RssConfig | undefined);
          break;
        case "select":
          ctx = stepSelect(ctx, config as string, i);
          break;
        case "map":
          ctx = stepMap(ctx, config as Record<string, string>);
          break;
        case "filter":
          ctx = stepFilter(ctx, config as string);
          break;
        case "sort":
          ctx = stepSort(ctx, config as SortConfig);
          break;
        case "limit":
          ctx = stepLimit(ctx, config);
          break;
        case "exec":
          ctx = await stepExec(ctx, config as ExecConfig);
          break;
        case "html_to_md":
          ctx = stepHtmlToMd(ctx);
          break;
        default:
          break;
      }
    } catch (err) {
      if (err instanceof PipelineError) throw err;
      throw new PipelineError(
        `Step ${i} (${action}) failed: ${err instanceof Error ? err.message : String(err)}`,
        {
          step: i,
          action,
          config,
          errorType: "parse_error",
          suggestion: `Check the ${action} step at index ${i} in the adapter YAML. The expression or configuration may be invalid.`,
        },
      );
    }
  }

  const result = ctx.data;
  if (Array.isArray(result)) return result;
  if (result !== null && result !== undefined) return [result];
  return [];
}

// --- Step implementations ---

interface FetchConfig {
  url: string;
  method?: string;
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
}

async function stepFetch(
  ctx: PipelineContext,
  config: FetchConfig,
): Promise<PipelineContext> {
  let url = evalTemplate(config.url, ctx);

  // If data is an array of items with IDs, fetch each one (fan-out pattern)
  if (Array.isArray(ctx.data)) {
    const items = ctx.data as Array<Record<string, unknown>>;
    const results = await Promise.all(
      items.map(async (item) => {
        const itemCtx = { ...ctx, data: item };
        const itemUrl = evalTemplate(config.url, itemCtx);
        const resolvedConfig = config.body
          ? { ...config, body: resolveTemplateDeep(config.body, itemCtx) }
          : config;
        const resp = await fetchJson(itemUrl, resolvedConfig);
        return resp;
      }),
    );
    return { ...ctx, data: results };
  }

  // Append query params
  if (config.params) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(config.params)) {
      const val = evalTemplate(String(v), ctx);
      params.set(k, val);
    }
    url += (url.includes("?") ? "&" : "?") + params.toString();
  }

  const resolvedConfig = config.body
    ? { ...config, body: resolveTemplateDeep(config.body, ctx) }
    : config;
  const data = await fetchJson(url, resolvedConfig);
  return { ...ctx, data };
}

async function fetchJson(url: string, config: FetchConfig): Promise<unknown> {
  const method = config.method ?? "GET";
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "Uni-CLI/0.200",
    ...(config.headers ?? {}),
  };

  const init: RequestInit = { method, headers };
  if (config.body && method !== "GET") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(config.body);
  }

  const resp = await fetch(url, init);
  if (!resp.ok) {
    let preview = "";
    try {
      preview = (await resp.text()).slice(0, 200);
    } catch {
      /* ignore */
    }
    throw new PipelineError(
      `HTTP ${resp.status} ${resp.statusText} from ${url}`,
      {
        step: -1, // will be overwritten by caller
        action: "fetch",
        config: { url, method },
        errorType: "http_error",
        url,
        statusCode: resp.status,
        responsePreview: preview,
        suggestion:
          resp.status === 403
            ? "The API is blocking requests. The endpoint may require authentication (cookie strategy) or the User-Agent may need updating."
            : resp.status === 404
              ? "The API endpoint was not found. The URL path may have changed — check the target site for the current API."
              : resp.status === 429
                ? "Rate limited. Add a delay between requests or reduce the limit parameter."
                : `HTTP ${resp.status} error. Check if the API endpoint is still valid.`,
      },
    );
  }
  return resp.json();
}

function stepSelect(
  ctx: PipelineContext,
  path: string,
  stepIndex: number,
): PipelineContext {
  const resolved = evalTemplate(path, ctx);
  const data = getNestedValue(ctx.data, resolved);
  if (data === undefined || data === null) {
    throw new PipelineError(
      `Select "${resolved}" returned nothing — the response structure may have changed`,
      {
        step: stepIndex,
        action: "select",
        config: path,
        errorType: "selector_miss",
        suggestion: `The path "${resolved}" does not exist in the API response. Inspect the actual response JSON to find the correct path, then update the "select" step in the adapter YAML.`,
      },
    );
  }
  return { ...ctx, data };
}

function stepMap(
  ctx: PipelineContext,
  template: Record<string, string>,
): PipelineContext {
  if (!Array.isArray(ctx.data)) return ctx;

  const items = ctx.data as unknown[];
  const mapped = items.map((item, index) => {
    const row: Record<string, unknown> = {};
    for (const [key, expr] of Object.entries(template)) {
      row[key] = evalTemplate(String(expr), {
        ...ctx,
        data: { item, index },
      });
    }
    return row;
  });

  return { ...ctx, data: mapped };
}

function stepFilter(ctx: PipelineContext, expr: string): PipelineContext {
  if (!Array.isArray(ctx.data)) return ctx;

  const items = ctx.data as unknown[];
  const filtered = items.filter((item, index) => {
    const result = evalExpression(expr, { item, index, args: ctx.args });
    return Boolean(result);
  });

  return { ...ctx, data: filtered };
}

function stepLimit(ctx: PipelineContext, config: unknown): PipelineContext {
  if (!Array.isArray(ctx.data)) return ctx;

  let n: number;
  if (typeof config === "number") {
    n = config;
  } else {
    const val = evalTemplate(String(config), ctx);
    n = parseInt(val, 10) || 20;
  }

  return { ...ctx, data: ctx.data.slice(0, n) };
}

// --- fetch_text: like fetch but returns raw text (for XML/RSS/HTML) ---

async function stepFetchText(
  ctx: PipelineContext,
  config: FetchConfig,
): Promise<PipelineContext> {
  let url = evalTemplate(config.url, ctx);

  if (config.params) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(config.params)) {
      params.set(k, evalTemplate(String(v), ctx));
    }
    url += (url.includes("?") ? "&" : "?") + params.toString();
  }

  const method = config.method ?? "GET";
  const headers: Record<string, string> = {
    "User-Agent": "Uni-CLI/0.200",
    ...(config.headers ?? {}),
  };

  const resp = await fetch(url, { method, headers });
  if (!resp.ok) {
    throw new PipelineError(
      `HTTP ${resp.status} ${resp.statusText} from ${url}`,
      {
        step: -1,
        action: "fetch_text",
        config: { url, method },
        errorType: "http_error",
        url,
        statusCode: resp.status,
        suggestion: `Check if the URL is still valid: ${url}`,
      },
    );
  }

  const text = await resp.text();
  return { ...ctx, data: text };
}

// --- RSS/XML parser ---

interface RssConfig {
  fields?: Record<string, string>;
}

function stepParseRss(
  ctx: PipelineContext,
  config: RssConfig | undefined,
): PipelineContext {
  const xml = String(ctx.data ?? "");
  const items: Record<string, string>[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    if (config?.fields) {
      const row: Record<string, string> = {};
      for (const [key, tag] of Object.entries(config.fields)) {
        row[key] = extractXmlTag(block, tag);
      }
      items.push(row);
    } else {
      items.push({
        title: extractXmlCdata(block, "title"),
        description: extractXmlCdata(block, "description"),
        link: extractXmlTag(block, "link"),
        pubDate: extractXmlTag(block, "pubDate"),
        guid: extractXmlTag(block, "guid"),
      });
    }
  }

  return { ...ctx, data: items };
}

function extractXmlCdata(xml: string, tag: string): string {
  const cdataMatch = xml.match(
    new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`),
  );
  if (cdataMatch) return cdataMatch[1].trim();
  return extractXmlTag(xml, tag);
}

function extractXmlTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : "";
}

// --- Sort step ---

interface SortConfig {
  by: string;
  order?: "asc" | "desc";
}

function stepSort(ctx: PipelineContext, config: SortConfig): PipelineContext {
  if (!Array.isArray(ctx.data)) return ctx;
  const items = [...ctx.data] as Record<string, unknown>[];
  const desc = config.order === "desc";
  items.sort((a, b) => {
    const va = a[config.by];
    const vb = b[config.by];
    const na = Number(va);
    const nb = Number(vb);
    if (!isNaN(na) && !isNaN(nb)) return desc ? nb - na : na - nb;
    return desc
      ? String(vb ?? "").localeCompare(String(va ?? ""))
      : String(va ?? "").localeCompare(String(vb ?? ""));
  });
  return { ...ctx, data: items };
}

// --- Exec step for desktop adapters ---

interface ExecConfig {
  command: string;
  args?: string[];
  parse?: "lines" | "json" | "csv" | "text";
  timeout?: number;
  stdin?: string;
  env?: Record<string, string>;
  output_file?: string;
}

async function stepExec(
  ctx: PipelineContext,
  config: ExecConfig,
): Promise<PipelineContext> {
  const cmd = evalTemplate(config.command, ctx);
  const execArgs = (config.args ?? []).map((a) => evalTemplate(String(a), ctx));
  const timeout = config.timeout ?? 30000;

  // Resolve env vars (merge with process.env)
  let envOption: NodeJS.ProcessEnv | undefined;
  if (config.env) {
    const resolved: Record<string, string> = {};
    for (const [k, v] of Object.entries(config.env)) {
      resolved[k] = evalTemplate(String(v), ctx);
    }
    envOption = { ...process.env, ...resolved };
  }

  // Resolve stdin content
  const stdinContent = config.stdin
    ? evalTemplate(config.stdin, ctx)
    : undefined;

  // Resolve output_file path
  const outputFile = config.output_file
    ? evalTemplate(config.output_file, ctx)
    : undefined;

  try {
    let stdout: string;

    if (stdinContent !== undefined) {
      // Use spawn to pipe stdin
      const { spawn } = await import("node:child_process");
      stdout = await new Promise<string>((resolve, reject) => {
        const child = spawn(cmd, execArgs, {
          timeout,
          env: envOption,
          stdio: ["pipe", "pipe", "pipe"],
        });

        const chunks: Buffer[] = [];
        const errChunks: Buffer[] = [];

        child.stdout.on("data", (c: Buffer) => chunks.push(c));
        child.stderr.on("data", (c: Buffer) => errChunks.push(c));

        child.on("error", (err) => reject(err));
        child.on("close", (code) => {
          if (code !== 0) {
            const stderr = Buffer.concat(errChunks).toString("utf8");
            reject(
              new Error(
                `Process exited with code ${code}${stderr ? `: ${stderr}` : ""}`,
              ),
            );
          } else {
            resolve(Buffer.concat(chunks).toString("utf8"));
          }
        });

        child.stdin.write(stdinContent);
        child.stdin.end();
      });
    } else {
      // Use execFileAsync (original path) with optional env
      const opts: {
        timeout: number;
        maxBuffer: number;
        env?: NodeJS.ProcessEnv;
      } = {
        timeout,
        maxBuffer: 10 * 1024 * 1024,
      };
      if (envOption) opts.env = envOption;
      ({ stdout } = await execFileAsync(cmd, execArgs, opts));
    }

    // If output_file is specified, return file info instead of stdout
    if (outputFile) {
      const { stat } = await import("node:fs/promises");
      try {
        const info = await stat(outputFile);
        return { ...ctx, data: { file: outputFile, size: info.size } };
      } catch {
        throw new PipelineError(
          `exec "${cmd}" did not produce expected output file: ${outputFile}`,
          {
            step: -1,
            action: "exec",
            config: { command: cmd, args: execArgs },
            errorType: "parse_error",
            suggestion: `Check that the command writes to "${outputFile}". Verify the path is correct.`,
          },
        );
      }
    }

    let data: unknown;
    switch (config.parse ?? "lines") {
      case "json":
        data = JSON.parse(stdout);
        break;
      case "lines":
        data = stdout
          .split("\n")
          .filter(Boolean)
          .map((line) => ({ line }));
        break;
      case "csv": {
        const lines = stdout.split("\n").filter(Boolean);
        if (lines.length < 2) {
          data = [];
          break;
        }
        const headers = lines[0].split(",").map((h) => h.trim());
        data = lines.slice(1).map((line) => {
          const vals = line.split(",");
          const row: Record<string, string> = {};
          headers.forEach((h, i) => {
            row[h] = (vals[i] ?? "").trim();
          });
          return row;
        });
        break;
      }
      case "text":
      default:
        data = stdout;
    }

    return { ...ctx, data };
  } catch (err) {
    if (err instanceof PipelineError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new PipelineError(`exec "${cmd}" failed: ${msg}`, {
      step: -1,
      action: "exec",
      config: { command: cmd, args: execArgs },
      errorType: "parse_error",
      suggestion: `Check that "${cmd}" is installed and accessible. Run: which ${cmd}`,
    });
  }
}

// --- HTML to Markdown ---

function stepHtmlToMd(ctx: PipelineContext): PipelineContext {
  const html = String(ctx.data ?? "");
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
  const md = turndown.turndown(html);
  return { ...ctx, data: md };
}

// --- Template engine ---

/**
 * Evaluate ${{ expression }} templates in a string.
 * Returns the raw value if the entire string is a single expression,
 * otherwise returns a string with interpolated values.
 */
function evalTemplate(template: string, ctx: PipelineContext): string {
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

function buildScope(ctx: PipelineContext): Record<string, unknown> {
  const scope: Record<string, unknown> = {
    args: ctx.args,
    base: ctx.base,
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
function resolveTemplateDeep(value: unknown, ctx: PipelineContext): unknown {
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
 * Built-in pipe filters — used in template expressions like:
 *   ${{ item.tags | join(', ') }}
 *   ${{ args.word | urlencode }}
 *   ${{ item.text | slice(0, 200) }}
 */
const PIPE_FILTERS: Record<string, (...args: unknown[]) => unknown> = {
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

/**
 * Safe expression evaluator using Function constructor.
 * Scoped to the provided variables — no access to global state.
 * Supports pipe filters: ${{ expr | join(', ') | slice(0, 100) }}
 */
function evalExpression(expr: string, scope: Record<string, unknown>): unknown {
  try {
    const { baseExpr, filters } = parsePipes(expr);

    const keys = Object.keys(scope);
    const values = Object.values(scope);
    const fn = new Function(...keys, `"use strict"; return (${baseExpr});`);
    let result: unknown = fn(...values);

    // Apply pipe filters
    for (const filter of filters) {
      const filterFn = PIPE_FILTERS[filter.name];
      if (!filterFn) continue;
      // Evaluate filter args
      const evaledArgs = filter.args.map((a) => {
        // String literal
        if (
          (a.startsWith("'") && a.endsWith("'")) ||
          (a.startsWith('"') && a.endsWith('"'))
        ) {
          return a.slice(1, -1);
        }
        // Number
        if (/^-?\d+(\.\d+)?$/.test(a)) return Number(a);
        // Expression
        try {
          const argFn = new Function(...keys, `"use strict"; return (${a});`);
          return argFn(...values);
        } catch {
          return a;
        }
      });
      result = filterFn(result, ...evaledArgs);
    }

    return result;
  } catch {
    return undefined;
  }
}

/**
 * Navigate nested object by dot-path: "data.list[].title"
 */
function getNestedValue(obj: unknown, path: string): unknown {
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
