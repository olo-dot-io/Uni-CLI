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
 *   write_temp → Write content to a temp file (cleaned up after pipeline)
 *   evaluate → Run JS expression (for browser adapters, future)
 *
 * Template syntax: ${{ expression }}
 *   Available variables: item, index, args, base, temp
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import TurndownService from "turndown";
import { USER_AGENT } from "../constants.js";
import type { PipelineStep } from "../types.js";
import { loadCookies, formatCookieHeader } from "./cookies.js";
import type { BrowserPage } from "../browser/page.js";
import {
  generateInterceptorJs,
  generateReadInterceptedJs,
} from "./interceptor.js";
import {
  type DownloadResult,
  httpDownload,
  ytdlpDownload,
  requiresYtdlp,
  sanitizeFilename,
  generateFilename,
  mapConcurrent,
} from "./download.js";
import { executeWebsocket, type WebsocketStepConfig } from "./websocket.js";

const execFileAsync = promisify(execFile);

export interface PipelineOptions {
  site?: string;
  strategy?: string;
}

type PipelineContext = {
  data: unknown;
  args: Record<string, unknown>;
  base?: string;
  cookieHeader?: string;
  temp?: Record<string, string>;
  tempDir?: string;
  page?: BrowserPage;
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
  options?: PipelineOptions,
): Promise<unknown[]> {
  // Load cookies for cookie strategy
  let cookieHeader: string | undefined;
  if (options?.strategy === "cookie" && options?.site) {
    const cookies = loadCookies(options.site);
    if (!cookies) {
      throw new PipelineError(
        `No cookies found for "${options.site}". Run: unicli auth setup ${options.site}`,
        {
          step: -1,
          action: "auth",
          config: { site: options.site, strategy: "cookie" },
          errorType: "http_error",
          suggestion: `Create cookie file at ~/.unicli/cookies/${options.site}.json with the required cookies. Run "unicli auth setup ${options.site}" for instructions.`,
        },
      );
    }
    cookieHeader = formatCookieHeader(cookies);
  }

  let ctx: PipelineContext = { data: null, args, base, cookieHeader };
  let tempDir: string | undefined;

  try {
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
          case "write_temp":
            ctx = stepWriteTemp(ctx, config as WriteTempConfig);
            break;
          case "navigate":
            ctx = await stepNavigate(ctx, config as NavigateConfig);
            break;
          case "evaluate":
            ctx = await stepEvaluate(ctx, config as EvaluateConfig | string);
            break;
          case "click":
            ctx = await stepClick(ctx, config as ClickConfig | string);
            break;
          case "type":
            ctx = await stepType(ctx, config as TypeConfig);
            break;
          case "wait":
            ctx = await stepWaitBrowser(
              ctx,
              config as WaitBrowserConfig | number,
            );
            break;
          case "intercept":
            ctx = await stepIntercept(ctx, config as InterceptConfig);
            break;
          case "press":
            ctx = await stepPress(ctx, config);
            break;
          case "scroll":
            ctx = await stepScroll(ctx, config);
            break;
          case "snapshot":
            ctx = await stepSnapshot(ctx, config);
            break;
          case "tap":
            ctx = await stepTap(ctx, config as TapConfig);
            break;
          case "download":
            ctx = await stepDownload(ctx, config as DownloadStepConfig);
            break;
          case "websocket":
            ctx = await stepWebsocket(ctx, config as WebsocketStepConfig);
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

      if (ctx.tempDir) tempDir = ctx.tempDir;
    }

    const result = ctx.data;
    if (Array.isArray(result)) return result;
    if (result !== null && result !== undefined) return [result];
    return [];
  } finally {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    }
    if (ctx.page) {
      try {
        await ctx.page.close();
      } catch {
        // Best-effort cleanup
      }
    }
  }
}

// --- Step implementations ---

interface FetchConfig {
  url: string;
  method?: string;
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
  retry?: number; // max attempts (default 1 = no retry)
  backoff?: number; // initial delay ms (doubles each retry)
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
        const resp = await fetchJson(itemUrl, resolvedConfig, ctx.cookieHeader);
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
  const data = await fetchJson(url, resolvedConfig, ctx.cookieHeader);
  return { ...ctx, data };
}

async function fetchJson(
  url: string,
  config: FetchConfig,
  cookieHeader?: string,
): Promise<unknown> {
  const method = config.method ?? "GET";
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
    ...config.headers,
  };

  if (cookieHeader) {
    headers["Cookie"] = cookieHeader;
  }

  const init: RequestInit = { method, headers };
  if (config.body && method !== "GET") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(config.body);
  }

  const maxAttempts = config.retry ?? 1;
  const baseDelay = config.backoff ?? 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const resp = await fetch(url, init);

    if (resp.ok) {
      return resp.json();
    }

    const isRetryable = resp.status === 429 || resp.status >= 500;
    const isLastAttempt = attempt === maxAttempts;

    if (isRetryable && !isLastAttempt) {
      await new Promise((r) => setTimeout(r, baseDelay * 2 ** (attempt - 1)));
      continue;
    }

    // Non-retryable error or last attempt — throw
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

  // Unreachable — loop always returns or throws — but satisfies TypeScript
  throw new Error("fetchJson: unreachable");
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
    "User-Agent": USER_AGENT,
    ...config.headers,
  };

  if (ctx.cookieHeader) {
    headers["Cookie"] = ctx.cookieHeader;
  }

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

  // Support both RSS 2.0 (<item>) and Atom (<entry>) formats
  const isAtom = xml.includes("<entry>");
  const itemRegex = isAtom
    ? /<entry>([\s\S]*?)<\/entry>/g
    : /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    if (config?.fields) {
      const row: Record<string, string> = {};
      for (const [key, tag] of Object.entries(config.fields)) {
        row[key] = extractXmlTag(block, tag);
      }
      items.push(row);
    } else if (isAtom) {
      // Atom format: <title>, <link href="...">, <published>, <summary>/<content>
      const linkMatch = block.match(
        /<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/,
      );
      const linkHref =
        linkMatch?.[1] ??
        block.match(/<link[^>]*href=["']([^"']+)["']/)?.[1] ??
        "";
      items.push({
        title: extractXmlCdata(block, "title"),
        description:
          extractXmlCdata(block, "content") ||
          extractXmlCdata(block, "summary"),
        link: linkHref,
        pubDate:
          extractXmlTag(block, "published") || extractXmlTag(block, "updated"),
        guid: extractXmlTag(block, "id"),
      });
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
function evalExpression(expr: string, scope: Record<string, unknown>): unknown {
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
      result = runInNewContext(`(${baseExpr})`, sandbox, {
        timeout: 50,
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

// --- write_temp: create ephemeral script files for desktop adapters ---

interface WriteTempConfig {
  filename: string;
  content: string;
}

function stepWriteTemp(
  ctx: PipelineContext,
  config: WriteTempConfig,
): PipelineContext {
  const td =
    ctx.tempDir ?? join(tmpdir(), `unicli-${randomBytes(6).toString("hex")}`);
  mkdirSync(td, { recursive: true });

  const filename = evalTemplate(config.filename, ctx);
  const content = evalTemplate(config.content, ctx);
  const filePath = join(td, filename);

  writeFileSync(filePath, content, "utf-8");

  const key = filename.replace(/[^a-zA-Z0-9]/g, "_");
  const temp = { ...(ctx.temp ?? {}), [key]: filePath };

  return { ...ctx, temp, tempDir: td };
}

// --- Browser step implementations ---

/**
 * Lazily acquire a BrowserPage. Connects on first use and caches on ctx.
 */
async function acquirePage(ctx: PipelineContext): Promise<BrowserPage> {
  if (ctx.page) return ctx.page;

  // Try daemon first (reuses Chrome login sessions)
  try {
    const { checkDaemonStatus } = await import("../browser/discover.js");
    const status = await checkDaemonStatus({ timeout: 300 });
    if (status.running && status.extensionConnected) {
      const { BrowserBridge } = await import("../browser/bridge.js");
      const bridge = new BrowserBridge();
      const page = await bridge.connect({ timeout: 5000 });
      return page as unknown as BrowserPage;
    }
  } catch {
    // Daemon not available — fall through to direct CDP
  }

  // Fallback: direct CDP connection
  const { BrowserPage: BP } = await import("../browser/page.js");
  const { injectStealth } = await import("../browser/stealth.js");

  const port = process.env.UNICLI_CDP_PORT
    ? parseInt(process.env.UNICLI_CDP_PORT, 10)
    : 9222;
  const page = await BP.connect(port);

  // Inject anti-detection scripts before any navigation
  await injectStealth(page.sendCDP.bind(page));

  return page;
}

interface NavigateConfig {
  url: string;
  settleMs?: number;
}

async function stepNavigate(
  ctx: PipelineContext,
  config: NavigateConfig,
): Promise<PipelineContext> {
  const page = await acquirePage(ctx);
  const url = evalTemplate(config.url, ctx);
  const settleMs = config.settleMs ?? 0;
  await page.goto(url, { settleMs });
  return { ...ctx, page };
}

interface EvaluateConfig {
  expression: string;
}

async function stepEvaluate(
  ctx: PipelineContext,
  config: EvaluateConfig | string,
): Promise<PipelineContext> {
  const page = await acquirePage(ctx);
  const expr =
    typeof config === "string"
      ? evalTemplate(config, ctx)
      : evalTemplate(config.expression, ctx);
  const result = await page.evaluate(expr);
  return { ...ctx, data: result, page };
}

interface ClickConfig {
  selector: string;
}

async function stepClick(
  ctx: PipelineContext,
  config: ClickConfig | string,
): Promise<PipelineContext> {
  const page = await acquirePage(ctx);
  const selector =
    typeof config === "string"
      ? evalTemplate(config, ctx)
      : evalTemplate(config.selector, ctx);
  await page.click(selector);
  return { ...ctx, page };
}

interface TypeConfig {
  text: string;
  selector?: string;
  submit?: boolean;
}

async function stepType(
  ctx: PipelineContext,
  config: TypeConfig,
): Promise<PipelineContext> {
  const page = await acquirePage(ctx);
  const text = evalTemplate(config.text, ctx);
  if (config.selector) {
    const selector = evalTemplate(config.selector, ctx);
    await page.type(selector, text);
  } else {
    // No selector — type into currently focused element via CDP
    await page.sendCDP("Input.insertText", { text });
  }
  if (config.submit) await page.press("Enter");
  return { ...ctx, page };
}

interface WaitBrowserConfig {
  ms?: number;
  selector?: string;
  timeout?: number;
}

async function stepWaitBrowser(
  ctx: PipelineContext,
  config: WaitBrowserConfig | number,
): Promise<PipelineContext> {
  const page = await acquirePage(ctx);
  if (typeof config === "number") {
    await page.waitFor(config);
  } else if (config.selector) {
    await page.waitFor(config.selector, config.timeout ?? 10000);
  } else if (config.ms) {
    await page.waitFor(config.ms);
  }
  return { ...ctx, page };
}

interface InterceptConfig {
  trigger: string;
  capture: string;
  select?: string;
  timeout?: number;
}

async function stepIntercept(
  ctx: PipelineContext,
  config: InterceptConfig,
): Promise<PipelineContext> {
  const page = await acquirePage(ctx);
  const capturePattern = evalTemplate(config.capture, ctx);
  const timeout = config.timeout ?? 10000;

  // Install interceptor: patch fetch + XHR to capture matching responses
  await page.evaluate(generateInterceptorJs(capturePattern));

  // Execute trigger action
  const trigger = evalTemplate(config.trigger, ctx);
  if (trigger.startsWith("navigate:")) {
    await page.goto(trigger.slice(9), { settleMs: 2000 });
  } else if (trigger.startsWith("click:")) {
    await page.click(trigger.slice(6));
  } else if (trigger === "scroll") {
    await page.scroll("down");
  } else if (trigger.startsWith("evaluate:")) {
    await page.evaluate(trigger.slice(9));
  }

  // Poll for captured response
  const startTime = Date.now();
  let captured: unknown = null;
  while (Date.now() - startTime < timeout) {
    const result = await page.evaluate(generateReadInterceptedJs());
    const arr = JSON.parse(result as string) as Array<{
      url: string;
      data: unknown;
    }>;
    if (arr.length > 0) {
      captured = arr[arr.length - 1].data;
      break;
    }
    await page.waitFor(200);
  }

  if (!captured) {
    throw new PipelineError(
      `Intercept timeout: no request matching "${capturePattern}" captured within ${String(timeout)}ms`,
      {
        step: -1,
        action: "intercept",
        config: { capture: capturePattern, trigger },
        errorType: "timeout",
        suggestion: `No network request matching "${capturePattern}" was observed. Verify the capture pattern matches the target API URL and that the trigger action causes the request.`,
      },
    );
  }

  // Apply optional dot-path selector to captured data
  let data: unknown = captured;
  if (config.select) {
    const segments = config.select.split(".");
    for (const key of segments) {
      if (data !== null && data !== undefined && typeof data === "object") {
        data = (data as Record<string, unknown>)[key];
      }
    }
  }

  return { ...ctx, data, page };
}

// --- press: keyboard event dispatch ---

async function stepPress(
  ctx: PipelineContext,
  config: unknown,
): Promise<PipelineContext> {
  const page = await acquirePage(ctx);
  if (typeof config === "string") {
    await page.press(evalTemplate(config, ctx));
  } else {
    const cfg = config as { key: string; modifiers?: string[] };
    const key = evalTemplate(cfg.key, ctx);
    if (cfg.modifiers && cfg.modifiers.length > 0) {
      await page.nativeKeyPress(key, cfg.modifiers);
    } else {
      await page.press(key);
    }
  }
  return { ...ctx, page };
}

// --- scroll: page scrolling ---

async function stepScroll(
  ctx: PipelineContext,
  config: unknown,
): Promise<PipelineContext> {
  const page = await acquirePage(ctx);
  if (typeof config === "string") {
    await page.scroll(config as "down" | "up" | "bottom" | "top");
  } else {
    const cfg = config as {
      to?: string;
      selector?: string;
      auto?: boolean;
      max?: number;
      delay?: number;
    };
    if (cfg.auto) {
      await page.autoScroll({ maxScrolls: cfg.max, delay: cfg.delay });
    } else if (cfg.selector) {
      const sel = evalTemplate(cfg.selector, ctx);
      const escaped = sel.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      await page.evaluate(
        `document.querySelector('${escaped}')?.scrollIntoView({ behavior: 'smooth', block: 'center' })`,
      );
    } else if (cfg.to) {
      await page.scroll(cfg.to as "down" | "up" | "bottom" | "top");
    }
  }
  return { ...ctx, page };
}

// --- snapshot: DOM accessibility tree ---

async function stepSnapshot(
  ctx: PipelineContext,
  config: unknown,
): Promise<PipelineContext> {
  const page = await acquirePage(ctx);
  const opts =
    typeof config === "object" && config !== null
      ? (config as {
          interactive?: boolean;
          compact?: boolean;
          max_depth?: number;
          raw?: boolean;
        })
      : {};
  // Normalize max_depth to maxDepth for BrowserPage.snapshot
  const normalizedOpts = {
    interactive: opts.interactive,
    compact: opts.compact,
    maxDepth: opts.max_depth,
    raw: opts.raw,
  };
  const result = await page.snapshot(normalizedOpts);
  return { ...ctx, data: result, page };
}

// --- tap: Vue store action bridge ---

interface TapConfig {
  store: string;
  action: string;
  capture: string;
  timeout?: number;
  select?: string;
  framework?: "pinia" | "vuex" | "auto";
  args?: unknown[];
}

async function stepTap(
  ctx: PipelineContext,
  config: TapConfig,
): Promise<PipelineContext> {
  const page = await acquirePage(ctx);
  const { generateTapInterceptorJs } = await import("./interceptor.js");
  const capturePattern = evalTemplate(config.capture, ctx);
  const timeout = (config.timeout ?? 5) * 1000;
  const storeName = evalTemplate(config.store, ctx);
  const actionName = evalTemplate(config.action, ctx);
  // Sanitize store/action names to prevent JS injection in page context
  if (!/^[a-zA-Z_$][\w$]*$/.test(storeName)) {
    throw new PipelineError(`Invalid store name: "${storeName}"`, {
      step: -1,
      action: "tap",
      config,
      errorType: "expression_error",
      suggestion: "Store name must be a valid JavaScript identifier.",
    });
  }
  if (!/^[a-zA-Z_$][\w$]*$/.test(actionName)) {
    throw new PipelineError(`Invalid action name: "${actionName}"`, {
      step: -1,
      action: "tap",
      config,
      errorType: "expression_error",
      suggestion: "Action name must be a valid JavaScript identifier.",
    });
  }
  const framework = config.framework ?? "auto";
  const actionArgs = config.args
    ? config.args.map((a) => JSON.stringify(a)).join(", ")
    : "";

  const tap = generateTapInterceptorJs(capturePattern);

  // Build optional select chain
  const selectChain = config.select
    ? config.select
        .split(".")
        .map((k) => `?.["${k}"]`)
        .join("")
    : "";

  // Store discovery based on framework
  const piniaDiscovery = `
    const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia;
    if (!pinia) throw new Error('Pinia not found');
    const store = pinia._s.get('${storeName}');
    if (!store) throw new Error('Store "${storeName}" not found');
    await store['${actionName}'](${actionArgs});
  `;

  const vuexDiscovery = `
    const vStore = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$store;
    if (!vStore) throw new Error('Vuex store not found');
    await vStore.dispatch('${storeName}/${actionName}'${actionArgs ? ", " + actionArgs : ""});
  `;

  const autoDiscovery = `
    const app = document.querySelector('#app')?.__vue_app__;
    if (!app) throw new Error('No Vue app found');
    const pinia = app.config?.globalProperties?.$pinia;
    if (pinia && pinia._s.has('${storeName}')) {
      const store = pinia._s.get('${storeName}');
      await store['${actionName}'](${actionArgs});
    } else {
      const vStore = app.config?.globalProperties?.$store;
      if (vStore) {
        await vStore.dispatch('${storeName}/${actionName}'${actionArgs ? ", " + actionArgs : ""});
      } else {
        throw new Error('No Pinia or Vuex store found');
      }
    }
  `;

  const storeCode =
    framework === "pinia"
      ? piniaDiscovery
      : framework === "vuex"
        ? vuexDiscovery
        : autoDiscovery;

  const script = `(async () => {
    ${tap.setupVar}
    ${tap.fetchPatch}
    ${tap.xhrPatch}
    try {
      ${storeCode}
      const result = await Promise.race([
        ${tap.promiseVar},
        new Promise((_, reject) => setTimeout(() => reject(new Error('tap timeout')), ${timeout})),
      ]);
      return JSON.stringify(result${selectChain});
    } finally {
      ${tap.restorePatch}
    }
  })()`;

  const raw = await page.evaluate(script);
  let data: unknown;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
  } else {
    data = raw;
  }

  return { ...ctx, data, page };
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

// ---------------------------------------------------------------------------
// Download step
// ---------------------------------------------------------------------------

interface DownloadStepConfig {
  url: string;
  dir?: string;
  filename?: string;
  concurrency?: number;
  skip_existing?: boolean;
  use_ytdlp?: boolean;
  type?: "auto" | "image" | "video" | "document";
  content?: string;
}

async function stepDownload(
  ctx: PipelineContext,
  config: DownloadStepConfig,
): Promise<PipelineContext> {
  const dir = resolve(config.dir ?? "./downloads");
  mkdirSync(dir, { recursive: true });
  const concurrency = config.concurrency ?? 3;
  const skipExisting = config.skip_existing !== false; // default true
  const cookieHeader = ctx.cookieHeader;

  async function downloadOne(
    item: Record<string, unknown>,
    index: number,
  ): Promise<Record<string, unknown>> {
    const itemCtx: PipelineContext = { ...ctx, data: { item, index } };
    const url = evalTemplate(config.url, itemCtx);
    const filename = config.filename
      ? evalTemplate(config.filename, itemCtx)
      : generateFilename(url, index);
    const destPath = join(dir, sanitizeFilename(filename));

    if (skipExisting && existsSync(destPath)) {
      return { ...item, _download: { status: "skipped", path: destPath } };
    }

    const useYtdlp =
      config.use_ytdlp ?? (config.type === "video" && requiresYtdlp(url));

    let result: DownloadResult;
    if (config.type === "document" && config.content) {
      const content = evalTemplate(config.content, itemCtx);
      writeFileSync(destPath, content, "utf-8");
      const info = await stat(destPath);
      result = {
        status: "success",
        path: destPath,
        size: info.size,
        duration: 0,
      };
    } else if (useYtdlp) {
      result = await ytdlpDownload(url, dir);
    } else {
      const headers: Record<string, string> = {};
      if (cookieHeader) headers["Cookie"] = cookieHeader;
      result = await httpDownload(url, destPath, headers);
    }

    return { ...item, _download: result };
  }

  if (Array.isArray(ctx.data)) {
    const items = ctx.data as Record<string, unknown>[];
    const results = await mapConcurrent(items, concurrency, downloadOne);
    return { ...ctx, data: results };
  } else {
    const item = (ctx.data ?? {}) as Record<string, unknown>;
    const result = await downloadOne(item, 0);
    return { ...ctx, data: [result] };
  }
}

async function stepWebsocket(
  ctx: PipelineContext,
  config: WebsocketStepConfig,
): Promise<PipelineContext> {
  const resolvedConfig: WebsocketStepConfig = {
    ...config,
    url: evalTemplate(config.url, ctx),
    send: evalTemplate(config.send, ctx),
  };
  const data = await executeWebsocket(resolvedConfig);
  return { ...ctx, data };
}

// Exported for unit testing — not part of public API
export { PIPE_FILTERS, evalExpression, buildScope };
