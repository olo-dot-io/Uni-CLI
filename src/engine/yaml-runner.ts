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
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";
import { randomBytes, createHash } from "node:crypto";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import TurndownService from "turndown";
import { USER_AGENT } from "../constants.js";
import type { PipelineStep } from "../types.js";
import { formatCookieHeader, loadCookiesWithCDP } from "./cookies.js";
import {
  matchSensitivePathRealpath,
  buildSensitivePathDenial,
} from "../permissions/sensitive-paths.js";
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
import { getProxyAgent } from "./proxy.js";
import { createTransportBus } from "../transport/bus.js";
import { CuaTransport } from "../transport/adapters/cua.js";
import { DesktopAxTransport } from "../transport/adapters/desktop-ax.js";
import { DesktopUiaTransport } from "../transport/adapters/desktop-uia.js";
import { DesktopAtspiTransport } from "../transport/adapters/desktop-atspi.js";
import { HttpTransport } from "../transport/adapters/http.js";
import { SubprocessTransport } from "../transport/adapters/subprocess.js";
import { CdpBrowserTransport } from "../transport/adapters/cdp-browser.js";
import type { TransportBus, TransportContext } from "../transport/types.js";
import { CUA_STEP_HANDLERS, type CuaStepKind } from "./steps/cua.js";
import {
  DESKTOP_AX_STEP_HANDLERS,
  type DesktopAxStepKind,
} from "./steps/desktop-ax.js";

const execFileAsync = promisify(execFile);

export interface PipelineOptions {
  site?: string;
  strategy?: string;
}

export type PipelineContext = {
  data: unknown;
  args: Record<string, unknown>;
  vars: Record<string, unknown>;
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
        | "expression_error"
        | "assertion_failed";
      url?: string;
      statusCode?: number;
      responsePreview?: string;
      suggestion: string;
      /** true for transient failures (timeout, 429, 5xx), false for permanent (404, auth, config) */
      retryable?: boolean;
      /** Fallback commands the agent can try when this command fails */
      alternatives?: string[];
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
      retryable: this.detail.retryable ?? false,
      alternatives: this.detail.alternatives ?? [],
    };
  }
}

/** Reserved sibling keys that are not step action names */
const SIBLING_KEYS = new Set([
  "fallback",
  "then",
  "else",
  "merge",
  "retry",
  "backoff",
]);

/**
 * SSRF defence — reject request URLs that point at non-http(s) schemes or
 * reserved local address ranges before we issue the fetch.
 *
 * The attack shape this blocks: a YAML adapter takes `${{ args.query }}`
 * and interpolates it into the request URL. An attacker (or a careless
 * template author) feeds a payload like `http://169.254.169.254/latest/meta-data/`
 * (AWS IMDS) or `http://127.0.0.1:19825/internal` (Uni-CLI daemon). Without
 * this guard the runner happily fetches it and returns the response —
 * leaking credentials or driving the daemon.
 *
 * The check is intentionally conservative: only http/https, and no loopback
 * / link-local / private metadata addresses. Set `UNICLI_ALLOW_LOCAL=1` to
 * bypass — useful for local dev / testing where a developer intentionally
 * targets `127.0.0.1` or a docker compose stack on a private subnet.
 */
export function assertSafeRequestUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`invalid URL for pipeline fetch: ${raw.slice(0, 120)}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(
      `disallowed URL scheme for pipeline fetch: ${u.protocol} (only http/https)`,
    );
  }
  if (process.env.UNICLI_ALLOW_LOCAL === "1") return;
  const host = u.hostname.toLowerCase();
  // Literal loopback / unspecified / link-local / cloud metadata
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::" ||
    host === "::1" ||
    host === "metadata.google.internal" ||
    host === "metadata" ||
    // IPv4 CIDR check — crude but covers the most common SSRF vectors.
    // Full RFC-6890 enumeration is overkill for adapter fetches; if you
    // need to target those ranges, set UNICLI_ALLOW_LOCAL=1.
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("169.254.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    throw new Error(
      `blocked fetch to reserved/local address ${host} — set UNICLI_ALLOW_LOCAL=1 to override`,
    );
  }
}

/**
 * Lazily-created transport bus — the capability registry for the runner.
 *
 * All seven v0.212 transports are registered so `bus.require(step)` gives
 * an honest answer for every pipeline step name in the capability matrix.
 * The legacy step executors (stepFetch / stepExec / browser ops) still run
 * their own code paths for v0.212 compatibility — registering the HTTP,
 * subprocess, and CDP transports here does NOT eagerly open Chrome or
 * spawn a process; `open()` is only called when a handler dispatches
 * through the bus (currently only the `cua_*` and `ax_*` step families).
 *
 * This is deliberately lightweight: the bus is the single source of truth
 * for capability declarations; full execution routing through the bus is
 * the v0.213 destination.
 */
let sharedBus: TransportBus | undefined;

function getBus(): TransportBus {
  if (sharedBus) return sharedBus;
  const bus = createTransportBus();
  // Order matters only for fallback lookup — register in the canonical
  // order from src/transport/capability.ts:TRANSPORT_KINDS.
  bus.register(new HttpTransport());
  bus.register(new CdpBrowserTransport());
  bus.register(new SubprocessTransport());
  bus.register(new DesktopAxTransport());
  bus.register(new DesktopUiaTransport());
  bus.register(new DesktopAtspiTransport());
  bus.register(new CuaTransport());
  sharedBus = bus;
  return bus;
}

/** Exposed for tests — reset the shared bus between runs. */
export function __resetTransportBusForTests(): void {
  sharedBus = undefined;
}

function buildTransportCtx(ctx: PipelineContext): TransportContext {
  return {
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
    cookieHeader: ctx.cookieHeader,
    vars: ctx.vars,
    bus: getBus(),
  };
}

function isCuaStep(action: string): action is CuaStepKind {
  return action in CUA_STEP_HANDLERS;
}

function isDesktopAxStep(action: string): action is DesktopAxStepKind {
  return action in DESKTOP_AX_STEP_HANDLERS;
}

function getActionEntry(step: PipelineStep): [string, unknown] {
  const entries = Object.entries(step);
  return (entries.find(([k]) => !SIBLING_KEYS.has(k)) ?? entries[0]) as [
    string,
    unknown,
  ];
}

/** Dispatch a single pipeline step by action name. */
async function executeStep(
  ctx: PipelineContext,
  action: string,
  config: unknown,
  stepIndex: number,
  fullStep?: PipelineStep,
  depth?: number,
): Promise<PipelineContext> {
  switch (action) {
    case "fetch":
      return stepFetch(ctx, config as FetchConfig);
    case "fetch_text":
      return stepFetchText(ctx, config as FetchConfig);
    case "parse_rss":
      return stepParseRss(ctx, config as RssConfig | undefined);
    case "select":
      return stepSelect(ctx, config as string, stepIndex);
    case "map":
      return stepMap(ctx, config as Record<string, string>);
    case "filter":
      return stepFilter(ctx, config as string);
    case "sort":
      return stepSort(ctx, config as SortConfig);
    case "limit":
      return stepLimit(ctx, config);
    case "exec":
      return stepExec(ctx, config as ExecConfig);
    case "html_to_md":
      return stepHtmlToMd(ctx);
    case "write_temp":
      return stepWriteTemp(ctx, config as WriteTempConfig);
    case "navigate":
      return stepNavigate(ctx, config as NavigateConfig);
    case "evaluate":
      return stepEvaluate(ctx, config as EvaluateConfig | string);
    case "click":
      return stepClick(ctx, config as ClickConfig | string);
    case "type":
      return stepType(ctx, config as TypeConfig);
    case "wait":
      return stepWaitBrowser(ctx, config as WaitBrowserConfig | number);
    case "intercept":
      return stepIntercept(ctx, config as InterceptConfig);
    case "press":
      return stepPress(ctx, config);
    case "scroll":
      return stepScroll(ctx, config);
    case "snapshot":
      return stepSnapshot(ctx, config);
    case "tap":
      return stepTap(ctx, config as TapConfig);
    case "download":
      return stepDownload(ctx, config as DownloadStepConfig);
    case "websocket":
      return stepWebsocket(ctx, config as WebsocketStepConfig);
    case "rate_limit": {
      const rlConfig = config as { domain: string; rpm?: number };
      const { waitForToken } = await import("./rate-limiter.js");
      await waitForToken(rlConfig.domain, rlConfig.rpm ?? 60);
      return ctx;
    }
    case "assert":
      return stepAssert(ctx, config as AssertConfig, stepIndex);
    case "set":
      return stepSet(ctx, config as Record<string, unknown>);
    case "append":
      return stepAppend(ctx, config as string);
    case "if": {
      const ifStep = (fullStep ?? { if: config }) as {
        if: string;
        then?: PipelineStep[];
        else?: PipelineStep[];
      };
      return stepIf(ctx, ifStep, stepIndex, (depth ?? 0) + 1);
    }
    case "each":
      return stepEach(ctx, config as EachConfig, stepIndex, depth ?? 0);
    case "parallel": {
      const mergeStrategy =
        ((fullStep as Record<string, unknown>)?.merge as string) ?? "concat";
      return stepParallel(
        ctx,
        config as PipelineStep[],
        mergeStrategy,
        stepIndex,
        depth ?? 0,
      );
    }
    case "extract":
      return stepExtract(ctx, config as ExtractConfig);
    default: {
      // CUA family + macOS AX family dispatch through the transport bus.
      // `action()` never throws — envelopes surface via ctx.vars.lastEnvelope.
      if (isCuaStep(action)) {
        const handler = CUA_STEP_HANDLERS[action];
        const params =
          config && typeof config === "object" && !Array.isArray(config)
            ? (config as Record<string, unknown>)
            : {};
        const envelope = await handler(
          { bus: getBus(), transportCtx: buildTransportCtx(ctx) },
          params,
        );
        ctx.vars["lastEnvelope"] = envelope;
        return { ...ctx, data: envelope.ok ? envelope.data : envelope };
      }
      if (isDesktopAxStep(action)) {
        const handler = DESKTOP_AX_STEP_HANDLERS[action];
        const params =
          config && typeof config === "object" && !Array.isArray(config)
            ? (config as Record<string, unknown>)
            : {};
        const envelope = await handler(
          { bus: getBus(), transportCtx: buildTransportCtx(ctx) },
          params,
        );
        ctx.vars["lastEnvelope"] = envelope;
        return { ...ctx, data: envelope.ok ? envelope.data : envelope };
      }

      // Check plugin custom step registry before giving up
      const { getCustomStep } = await import("../plugin/step-registry.js");
      const customHandler = getCustomStep(action);
      if (customHandler) {
        const pluginCtx = {
          data: ctx.data,
          args: ctx.args,
          vars: ctx.vars,
          base: ctx.base,
          cookieHeader: ctx.cookieHeader,
        };
        const result = await customHandler(pluginCtx, config);
        return { ...ctx, data: result.data, vars: result.vars };
      }
      return ctx;
    }
  }
}

export async function runPipeline(
  steps: PipelineStep[],
  args: Record<string, unknown>,
  base?: string,
  options?: PipelineOptions,
): Promise<unknown[]> {
  // Load cookies for cookie/header strategy (disk first, CDP fallback)
  let cookieHeader: string | undefined;
  if (
    (options?.strategy === "cookie" || options?.strategy === "header") &&
    options?.site
  ) {
    const cookies = await loadCookiesWithCDP(options.site);
    if (!cookies) {
      throw new PipelineError(
        `No cookies found for "${options.site}". Run: unicli auth setup ${options.site}`,
        {
          step: -1,
          action: "auth",
          config: { site: options.site, strategy: options.strategy },
          errorType: "http_error",
          suggestion: `Either start Chrome with "unicli browser start" and login to ${options.site}, or create cookie file at ~/.unicli/cookies/${options.site}.json`,
          retryable: false,
          alternatives: [`unicli auth setup ${options.site}`],
        },
      );
    }
    cookieHeader = formatCookieHeader(cookies);
  }

  let ctx: PipelineContext = { data: null, args, vars: {}, base, cookieHeader };
  let tempDir: string | undefined;

  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const [action, config] = getActionEntry(step);

      // --- Fallback extraction ---
      // Fallback can live inside the step config (object configs like fetch)
      // or as a sibling key in the step object (string configs like select).
      let stepConfig = config;
      let fallbacks: unknown[] | undefined;

      if (
        stepConfig &&
        typeof stepConfig === "object" &&
        !Array.isArray(stepConfig)
      ) {
        const configObj = stepConfig as Record<string, unknown>;
        if ("fallback" in configObj) {
          fallbacks = Array.isArray(configObj.fallback)
            ? configObj.fallback
            : [configObj.fallback];
          const { fallback: _, ...rest } = configObj;
          stepConfig = rest;
        }
      }

      if (!fallbacks) {
        const stepObj = step as Record<string, unknown>;
        if ("fallback" in stepObj) {
          const fb = stepObj.fallback;
          fallbacks = Array.isArray(fb) ? fb : [fb];
        }
      }

      // Filter out null/undefined fallback entries (e.g. `fallback:` with no value in YAML)
      if (fallbacks) {
        fallbacks = fallbacks.filter((fb) => fb != null);
        if (fallbacks.length === 0) fallbacks = undefined;
      }

      // --- Retry configuration ---
      const retryCount = getRetryCount(step, stepConfig);
      const backoffMs = getBackoffMs(step, stepConfig);

      // Strip retry/backoff from stepConfig to avoid passing them to step implementations
      if (
        stepConfig &&
        typeof stepConfig === "object" &&
        !Array.isArray(stepConfig)
      ) {
        const cfgObj = stepConfig as Record<string, unknown>;
        if ("retry" in cfgObj || "backoff" in cfgObj) {
          const { retry: _r, backoff: _b, ...rest } = cfgObj;
          stepConfig = rest;
        }
      }

      try {
        if (retryCount > 0) {
          // Retry-aware execution: wraps primary + fallback
          let lastRetryErr: unknown;
          let retrySucceeded = false;
          for (let attempt = 0; attempt <= retryCount; attempt++) {
            try {
              // Inner: primary step + fallback
              try {
                ctx = await executeStep(ctx, action, stepConfig, i, step);
              } catch (primaryErr) {
                if (!fallbacks || fallbacks.length === 0) throw primaryErr;
                let lastErr = primaryErr;
                let fbOk = false;
                for (const fb of fallbacks) {
                  try {
                    ctx = await executeStep(ctx, action, fb, i, step);
                    fbOk = true;
                    break;
                  } catch (fbErr) {
                    lastErr = fbErr;
                  }
                }
                if (!fbOk) throw lastErr;
              }
              retrySucceeded = true;
              break;
            } catch (retryErr) {
              lastRetryErr = retryErr;
              if (attempt < retryCount) {
                const delay = backoffMs * Math.pow(2, attempt);
                await new Promise((r) => setTimeout(r, delay));
              }
            }
          }
          if (!retrySucceeded && lastRetryErr) throw lastRetryErr;
        } else {
          // Original execution path (no retry): primary + fallback
          try {
            ctx = await executeStep(ctx, action, stepConfig, i, step);
          } catch (primaryErr) {
            if (!fallbacks || fallbacks.length === 0) throw primaryErr;

            let lastErr = primaryErr;
            let succeeded = false;
            for (const fb of fallbacks) {
              try {
                ctx = await executeStep(ctx, action, fb, i, step);
                succeeded = true;
                break;
              } catch (fbErr) {
                lastErr = fbErr;
              }
            }
            if (!succeeded) throw lastErr;
          }
        }
      } catch (err) {
        // Auto-fix: try alternative select paths when selector_miss
        if (
          action === "select" &&
          err instanceof PipelineError &&
          err.detail.errorType === "selector_miss" &&
          options?.site
        ) {
          try {
            const { suggestSelectFix } = await import("./auto-fix.js");
            const suggestions = suggestSelectFix(
              ctx.data,
              stepConfig as string,
            );
            let fixed = false;
            for (const suggestion of suggestions) {
              try {
                ctx = stepSelect(ctx, suggestion, i);
                process.stderr.write(
                  `[auto-fix] ${options.site}: select path changed "${String(stepConfig)}" → "${suggestion}"\n`,
                );
                fixed = true;
                break;
              } catch {
                // Try next suggestion
              }
            }
            if (fixed) continue;
          } catch {
            // Auto-fix module not available
          }
        }
        // Emit diagnostic context for agent self-repair
        if (process.env.UNICLI_DIAGNOSTIC === "1") {
          try {
            const { buildRepairContext, emitRepairContext } =
              await import("./diagnostic.js");
            const repairCtx = await buildRepairContext({
              error: err instanceof Error ? err : new Error(String(err)),
              site: options?.site ?? "unknown",
              command: "unknown",
              page: ctx.page,
            });
            emitRepairContext(repairCtx);
          } catch {
            // Diagnostic collection failure should never mask the original error
          }
        }

        // Smart cookie refresh on auth failure
        if (
          err instanceof PipelineError &&
          (err.detail.statusCode === 401 || err.detail.statusCode === 403) &&
          (options?.strategy === "cookie" || options?.strategy === "header") &&
          options?.site
        ) {
          try {
            const { refreshCookies } = await import("./cookie-refresh.js");
            const refreshed = await refreshCookies(options.site);
            if (refreshed) {
              process.stderr.write(
                `[cookie-refresh] Cookies refreshed for ${options.site}, retry the command.\n`,
              );
            }
          } catch {
            // Cookie refresh failure is non-fatal
          }
        }

        if (err instanceof PipelineError) throw err;
        const errMsg = err instanceof Error ? err.message : String(err);
        const isTransient =
          /timeout|ETIMEDOUT|ECONNREFUSED|ECONNRESET|socket hang up/i.test(
            errMsg,
          );
        throw new PipelineError(`Step ${i} (${action}) failed: ${errMsg}`, {
          step: i,
          action,
          config,
          errorType: isTransient ? "timeout" : "parse_error",
          suggestion: `Check the ${action} step at index ${i} in the adapter YAML. The expression or configuration may be invalid.`,
          retryable: isTransient,
          alternatives: [],
        });
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

// --- Retry helpers ---

function getRetryCount(step: PipelineStep, config: unknown): number {
  const stepObj = step as Record<string, unknown>;
  if (typeof stepObj.retry === "number") return stepObj.retry;
  if (
    config &&
    typeof config === "object" &&
    !Array.isArray(config) &&
    "retry" in (config as Record<string, unknown>)
  ) {
    return Number((config as Record<string, unknown>).retry) || 0;
  }
  return 0;
}

function getBackoffMs(step: PipelineStep, config: unknown): number {
  const stepObj = step as Record<string, unknown>;
  if (typeof stepObj.backoff === "number") return stepObj.backoff;
  if (
    config &&
    typeof config === "object" &&
    !Array.isArray(config) &&
    "backoff" in (config as Record<string, unknown>)
  ) {
    return Number((config as Record<string, unknown>).backoff) || 1000;
  }
  return 1000;
}

// --- Assert step ---

export interface AssertConfig {
  url?: string;
  selector?: string;
  text?: string;
  condition?: string;
  message?: string;
}

export async function stepAssert(
  ctx: PipelineContext,
  config: AssertConfig,
  stepIndex: number,
): Promise<PipelineContext> {
  const page = ctx.page ? ctx.page : undefined;

  // URL assertion
  if (config.url) {
    if (!page)
      throw assertionError(
        "url assertion requires a browser page",
        config,
        stepIndex,
      );
    const currentUrl = await page.url();
    const expected = evalTemplate(config.url, ctx);
    if (!currentUrl.includes(expected)) {
      throw assertionError(
        `URL mismatch: expected "${expected}" in "${currentUrl}"`,
        config,
        stepIndex,
      );
    }
  }

  // Selector assertion
  if (config.selector) {
    if (!page)
      throw assertionError(
        "selector assertion requires a browser page",
        config,
        stepIndex,
      );
    const selector = evalTemplate(config.selector, ctx);
    const exists = await page.evaluate(
      `!!document.querySelector(${JSON.stringify(selector)})`,
    );
    if (!exists) {
      throw assertionError(`Element not found: ${selector}`, config, stepIndex);
    }
  }

  // Text assertion
  if (config.text) {
    if (!page)
      throw assertionError(
        "text assertion requires a browser page",
        config,
        stepIndex,
      );
    const expected = evalTemplate(config.text, ctx);
    const bodyText = (await page.evaluate(
      "document.body?.innerText || ''",
    )) as string;
    if (!bodyText.includes(expected)) {
      throw assertionError(`Text not found: "${expected}"`, config, stepIndex);
    }
  }

  // Condition assertion (works without browser)
  if (config.condition) {
    const expr = evalTemplate(config.condition, ctx);
    const result = evalExpression(expr, {
      data: ctx.data,
      args: ctx.args,
      vars: ctx.vars,
    });
    if (!result) {
      throw assertionError(`Condition failed: ${expr}`, config, stepIndex);
    }
  }

  return ctx;
}

function assertionError(
  message: string,
  config: AssertConfig,
  stepIndex: number,
): PipelineError {
  return new PipelineError(config.message ?? message, {
    step: stepIndex,
    action: "assert",
    config,
    errorType: "assertion_failed",
    suggestion:
      "Check the assertion conditions in the adapter YAML. The page state may not match expectations.",
    retryable: false,
    alternatives: [],
  });
}

// --- Step implementations ---

export interface FetchConfig {
  url: string;
  method?: string;
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
  retry?: number; // max attempts (default 1 = no retry)
  backoff?: number; // initial delay ms (doubles each retry)
  cache?: number; // cache TTL in seconds (0 = no cache, default: no cache)
}

export async function stepFetch(
  ctx: PipelineContext,
  config: FetchConfig,
): Promise<PipelineContext> {
  let url = evalTemplate(config.url, ctx);
  assertSafeRequestUrl(url);

  // If data is an array of items with IDs, fetch each one (fan-out with concurrency limit)
  if (Array.isArray(ctx.data)) {
    const items = ctx.data as Array<Record<string, unknown>>;
    const concurrency = (config as unknown as Record<string, unknown>)
      .concurrency
      ? Number((config as unknown as Record<string, unknown>).concurrency)
      : 5;
    const results = await mapConcurrent(items, concurrency, async (item) => {
      const itemCtx = { ...ctx, data: item };
      const itemUrl = evalTemplate(config.url, itemCtx);
      assertSafeRequestUrl(itemUrl);
      const resolvedConfig = config.body
        ? { ...config, body: resolveTemplateDeep(config.body, itemCtx) }
        : config;
      return fetchJson(itemUrl, resolvedConfig, ctx.cookieHeader);
    });
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

  // Strategy fallback: if no cookie and fetch returns 401/403, try with cookies
  try {
    const data = await fetchJson(url, resolvedConfig, ctx.cookieHeader);
    return { ...ctx, data };
  } catch (err) {
    if (
      err instanceof PipelineError &&
      (err.detail.statusCode === 401 || err.detail.statusCode === 403) &&
      !ctx.cookieHeader
    ) {
      // Attempt cookie fallback — try loading cookies for the domain
      try {
        const hostname = new URL(url).hostname;
        const siteName = hostname
          .replace(/^www\./, "")
          .split(".")
          .slice(0, -1)
          .join("-");
        const cookies = await loadCookiesWithCDP(siteName);
        if (cookies) {
          const fallbackCookie = formatCookieHeader(cookies);
          const data = await fetchJson(url, resolvedConfig, fallbackCookie);
          return { ...ctx, data, cookieHeader: fallbackCookie };
        }
      } catch {
        // Cookie fallback also failed — throw original
      }
    }
    throw err;
  }
}

// --- Fetch response cache ---

const CACHE_DIR = join(homedir(), ".unicli", "cache");

function fetchCacheKey(url: string, method: string): string {
  return createHash("sha256")
    .update(`${method}:${url}`)
    .digest("hex")
    .slice(0, 16);
}

function readFetchCache(
  url: string,
  method: string,
  ttlSeconds: number,
): unknown | null {
  const key = fetchCacheKey(url, method);
  const filePath = join(CACHE_DIR, `${key}.json`);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf-8");
    const entry = JSON.parse(raw) as { ts: number; data: unknown };
    if (Date.now() - entry.ts > ttlSeconds * 1000) return null;
    return entry.data;
  } catch {
    return null;
  }
}

const MAX_CACHE_ENTRY_BYTES = 10 * 1024 * 1024; // 10MB per entry

function writeFetchCache(url: string, method: string, data: unknown): void {
  try {
    const payload = JSON.stringify({ ts: Date.now(), url, data });
    if (payload.length > MAX_CACHE_ENTRY_BYTES) return; // reject oversized responses
    mkdirSync(CACHE_DIR, { recursive: true });
    const key = fetchCacheKey(url, method);
    writeFileSync(join(CACHE_DIR, `${key}.json`), payload);
  } catch {
    /* cache write failure is non-fatal */
  }
}

async function fetchJson(
  url: string,
  config: FetchConfig,
  cookieHeader?: string,
): Promise<unknown> {
  const method = config.method ?? "GET";

  // Check cache before making network request
  if (config.cache && config.cache > 0) {
    const cached = readFetchCache(url, method, config.cache);
    if (cached !== null) return cached;
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
    ...config.headers,
  };

  if (cookieHeader) {
    headers["Cookie"] = cookieHeader;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dispatcher from undici not in standard RequestInit
  const init: Record<string, any> = { method, headers };
  if (config.body && method !== "GET") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(config.body);
  }
  const proxyAgent = getProxyAgent();
  if (proxyAgent) init.dispatcher = proxyAgent;

  const maxAttempts = config.retry ?? 1;
  const baseDelay = config.backoff ?? 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const resp = await fetch(url, init as RequestInit);

    if (resp.ok) {
      const data = await resp.json();
      if (config.cache && config.cache > 0) writeFetchCache(url, method, data);
      return data;
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
    const isRetryableStatus =
      resp.status === 429 ||
      resp.status === 500 ||
      resp.status === 502 ||
      resp.status === 503;
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
        retryable: isRetryableStatus,
        alternatives:
          resp.status === 401 || resp.status === 403
            ? ["unicli auth setup <site>"]
            : [],
      },
    );
  }

  // Unreachable — loop always returns or throws — but satisfies TypeScript
  throw new Error("fetchJson: unreachable");
}

export function stepSelect(
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
        retryable: false,
        alternatives: [],
      },
    );
  }
  return { ...ctx, data };
}

export function stepMap(
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

export function stepFilter(
  ctx: PipelineContext,
  expr: string,
): PipelineContext {
  if (!Array.isArray(ctx.data)) return ctx;

  const items = ctx.data as unknown[];
  const filtered = items.filter((item, index) => {
    const result = evalExpression(expr, { item, index, args: ctx.args });
    return Boolean(result);
  });

  return { ...ctx, data: filtered };
}

export function stepLimit(
  ctx: PipelineContext,
  config: unknown,
): PipelineContext {
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

export async function stepFetchText(
  ctx: PipelineContext,
  config: FetchConfig,
): Promise<PipelineContext> {
  let url = evalTemplate(config.url, ctx);
  assertSafeRequestUrl(url);

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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dispatcher from undici not in standard RequestInit
  const fetchInit: Record<string, any> = { method, headers };
  const ftAgent = getProxyAgent();
  if (ftAgent) fetchInit.dispatcher = ftAgent;

  const resp = await fetch(url, fetchInit as RequestInit);
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
        retryable:
          resp.status === 429 ||
          resp.status === 500 ||
          resp.status === 502 ||
          resp.status === 503,
        alternatives:
          resp.status === 401 || resp.status === 403
            ? ["unicli auth setup <site>"]
            : [],
      },
    );
  }

  const text = await resp.text();
  return { ...ctx, data: text };
}

// --- RSS/XML parser ---

export interface RssConfig {
  fields?: Record<string, string>;
}

export function stepParseRss(
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

export interface SortConfig {
  by: string;
  order?: "asc" | "desc";
}

export function stepSort(
  ctx: PipelineContext,
  config: SortConfig,
): PipelineContext {
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

export interface ExecConfig {
  command: string;
  args?: string[];
  parse?: "lines" | "json" | "csv" | "text";
  timeout?: number;
  stdin?: string;
  env?: Record<string, string>;
  output_file?: string;
}

export async function stepExec(
  ctx: PipelineContext,
  config: ExecConfig,
): Promise<PipelineContext> {
  const cmd = evalTemplate(config.command, ctx);
  const execArgs = (config.args ?? []).map((a) => evalTemplate(String(a), ctx));
  const timeout = config.timeout ?? 30000;

  // Sensitive-path deny list — scan every arg that looks like a path before
  // touching subprocess. Cannot be overridden by permission mode. Defends
  // against prompt-injection that smuggles a credential path into args.
  // Uses the realpath-aware variant so `ln -s ~/.ssh/id_rsa /tmp/x.txt` is
  // still blocked.
  for (const arg of execArgs) {
    if (typeof arg !== "string" || arg.length === 0) continue;
    if (!arg.startsWith("/") && !arg.startsWith("~/")) continue;
    const expanded = arg.startsWith("~/") ? join(homedir(), arg.slice(2)) : arg;
    const matched = matchSensitivePathRealpath(expanded);
    if (matched) {
      const denial = buildSensitivePathDenial(expanded);
      // The error message is the canonical `sensitive_path_denied` string so
      // agents can pattern-match the same identifier regardless of whether
      // the block fires in operate upload or the exec pipeline step. The
      // full denial payload (path, pattern, hint) is inlined into `config`
      // for `toAgentJSON()` to surface.
      throw new PipelineError("sensitive_path_denied", {
        step: -1,
        action: "exec",
        config: {
          command: cmd,
          args: execArgs,
          denial_path: denial.path,
          denial_pattern: denial.pattern,
        },
        errorType: "assertion_failed",
        suggestion: denial.hint,
        retryable: false,
        alternatives: [],
      });
    }
  }

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
            retryable: false,
            alternatives: [],
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
    const isExecTransient = /timeout|ETIMEDOUT|ECONNREFUSED|ECONNRESET/i.test(
      msg,
    );
    throw new PipelineError(`exec "${cmd}" failed: ${msg}`, {
      step: -1,
      action: "exec",
      config: { command: cmd, args: execArgs },
      errorType: isExecTransient ? "timeout" : "parse_error",
      suggestion: `Check that "${cmd}" is installed and accessible. Run: which ${cmd}`,
      retryable: isExecTransient,
      alternatives: [],
    });
  }
}

// --- HTML to Markdown ---

export function stepHtmlToMd(ctx: PipelineContext): PipelineContext {
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

// --- Set step (store pipeline variables) ---

export function stepSet(
  ctx: PipelineContext,
  config: Record<string, unknown>,
): PipelineContext {
  if (!config || typeof config !== "object" || Array.isArray(config))
    return ctx;
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    resolved[key] = resolveTemplateDeep(value, ctx);
  }
  return { ...ctx, vars: { ...ctx.vars, ...resolved } };
}

// --- Append step (accumulate data into vars array) ---

export function stepAppend(ctx: PipelineContext, key: string): PipelineContext {
  if (typeof key !== "string" || !key) return ctx;
  const existing = ctx.vars[key];
  const arr = Array.isArray(existing)
    ? [...existing]
    : existing !== undefined
      ? [existing]
      : [];
  if (Array.isArray(ctx.data)) {
    arr.push(...(ctx.data as unknown[]));
  } else if (ctx.data !== null && ctx.data !== undefined) {
    arr.push(ctx.data);
  }
  return { ...ctx, vars: { ...ctx.vars, [key]: arr } };
}

// --- If/else step (conditional branching) ---

export async function stepIf(
  ctx: PipelineContext,
  config: { if: string; then?: PipelineStep[]; else?: PipelineStep[] },
  stepIndex: number,
  depth: number = 0,
): Promise<PipelineContext> {
  if (depth > 10) {
    throw new PipelineError("if step recursion depth exceeded (max 10)", {
      step: stepIndex,
      action: "if",
      config,
      errorType: "parse_error",
      suggestion:
        "Reduce nesting depth of if/else steps. Maximum is 10 levels.",
      retryable: false,
      alternatives: [],
    });
  }

  const conditionStr =
    typeof config.if === "string" ? config.if : String(config.if);

  // Strip ${{ }} wrapper if present
  const exprMatch = conditionStr.match(/^\$\{\{\s*(.+?)\s*\}\}$/);
  const expr = exprMatch ? exprMatch[1] : conditionStr;
  const result = evalExpression(expr, buildScope(ctx));

  const branch = result ? config.then : config.else;
  if (!branch || !Array.isArray(branch) || branch.length === 0) return ctx;

  // Execute sub-pipeline steps sequentially
  for (let j = 0; j < branch.length; j++) {
    const subStep = branch[j];
    const [subAction, subConfig] = getActionEntry(subStep);
    ctx = await executeStep(
      ctx,
      subAction,
      subConfig,
      stepIndex,
      subStep,
      depth,
    );
  }
  return ctx;
}

// --- Each loop step (do-while with max iteration guard) ---

export interface EachConfig {
  max?: number;
  do: PipelineStep[];
  until?: string;
}

export async function stepEach(
  ctx: PipelineContext,
  config: EachConfig,
  stepIndex: number,
  depth: number,
): Promise<PipelineContext> {
  if (depth > 10) {
    throw new PipelineError("each step recursion depth exceeded (max 10)", {
      step: stepIndex,
      action: "each",
      config,
      errorType: "parse_error",
      suggestion: "Reduce nesting depth of loop steps. Maximum is 10 levels.",
      retryable: false,
      alternatives: [],
    });
  }

  const maxIterations = Math.max(config.max ?? 100, 1);
  const body = config.do;
  if (!body || !Array.isArray(body) || body.length === 0) return ctx;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Reset data at start of each iteration to prevent fetch fan-out
    // from previous iteration's array data. State is carried via ctx.vars.
    ctx = { ...ctx, data: null };

    // Execute body sub-pipeline
    for (const subStep of body) {
      const [subAction, subConfig] = getActionEntry(subStep);
      ctx = await executeStep(
        ctx,
        subAction,
        subConfig,
        stepIndex,
        subStep,
        depth + 1,
      );
    }

    // Check until condition (after body execution — do-while semantics)
    if (config.until) {
      const condStr =
        typeof config.until === "string" ? config.until : String(config.until);
      // Strip ${{ }} wrapper if present
      const exprMatch = condStr.match(/^\$\{\{\s*(.+?)\s*\}\}$/);
      const expr = exprMatch ? exprMatch[1] : condStr;
      // Build scope with data alias for until condition evaluation
      const scope = buildScope(ctx);
      scope.data = ctx.data;
      const result = evalExpression(expr, scope);
      if (result) break;
    }
  }

  return ctx;
}

// --- Parallel step (concurrent branch execution with merge strategies) ---

export async function stepParallel(
  ctx: PipelineContext,
  branches: PipelineStep[],
  merge: string,
  stepIndex: number,
  depth: number,
): Promise<PipelineContext> {
  if (!Array.isArray(branches) || branches.length === 0) return ctx;

  if (depth > 10) {
    throw new PipelineError("parallel step recursion depth exceeded (max 10)", {
      step: stepIndex,
      action: "parallel",
      config: branches,
      errorType: "parse_error",
      suggestion:
        "Reduce nesting depth of parallel steps. Maximum is 10 levels.",
      retryable: false,
      alternatives: [],
    });
  }

  // Parallel concurrency cap — bound simultaneous branch execution so a
  // pipeline with 100 parallel `fetch` steps doesn't exhaust the socket
  // pool or trip per-host rate limiters. Default 5 mirrors `stepFetch`
  // fan-out; overridable via `concurrency:` on the parallel step config
  // (read when the runner dispatches; plumbing goes through executeStep).
  const results = await mapConcurrent(branches, 5, async (branch) => {
    const branchCtx: PipelineContext = {
      ...ctx,
      vars: { ...ctx.vars },
    };
    const [action, config] = getActionEntry(branch);
    const result = await executeStep(
      branchCtx,
      action,
      config,
      stepIndex,
      branch,
      depth + 1,
    );
    return result.data;
  });

  let merged: unknown;
  switch (merge) {
    case "zip": {
      const first = results[0];
      if (Array.isArray(first)) {
        merged = first.map((_, i) =>
          results.map((r) => (Array.isArray(r) ? r[i] : r)),
        );
      } else {
        merged = results;
      }
      break;
    }
    case "object":
      merged = Object.fromEntries(results.map((r, i) => [String(i), r]));
      break;
    case "concat":
    default:
      merged = results.flatMap((r) => (Array.isArray(r) ? r : [r]));
      break;
  }

  return { ...ctx, data: merged };
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

export interface WriteTempConfig {
  filename: string;
  content: string;
}

export function stepWriteTemp(
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

  let port = 9222;
  const rawPort = process.env.UNICLI_CDP_PORT;
  if (rawPort) {
    const p = parseInt(rawPort, 10);
    if (Number.isInteger(p) && p >= 1 && p <= 65535) {
      port = p;
    }
  }

  // 1. Try direct CDP first (fastest, no daemon overhead)
  try {
    const { BrowserPage: BP } = await import("../browser/page.js");
    const { injectStealth } = await import("../browser/stealth.js");
    const page = await BP.connect(port);
    await injectStealth(page.sendCDP.bind(page));
    return page;
  } catch {
    // CDP not available — try daemon
  }

  // 2. Fallback: daemon (reuses Chrome login sessions via extension)
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
    // Daemon not available either
  }

  // 3. Last resort: auto-launch Chrome with debug port
  try {
    const { launchChrome } = await import("../browser/launcher.js");
    const { BrowserPage: BP } = await import("../browser/page.js");
    const { injectStealth } = await import("../browser/stealth.js");
    await launchChrome(port);
    // Poll for connection (5 attempts, 500ms intervals)
    let page: BrowserPage | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        page = await BP.connect(port);
        break;
      } catch {
        if (attempt < 4) await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (!page) throw new Error("Chrome launched but no page target available");
    await injectStealth(page.sendCDP.bind(page));
    return page;
  } catch (err) {
    throw new Error(
      `Cannot connect to Chrome. Run "unicli browser start" first. (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

export interface NavigateConfig {
  url: string;
  settleMs?: number;
  waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
}

/**
 * Wait until no new network requests occur for quietMs.
 * Uses polling — checks page.networkRequests() count stability.
 */
async function waitForNetworkIdle(
  page: BrowserPage,
  maxMs = 5000,
  quietMs = 500,
): Promise<void> {
  const start = Date.now();
  let lastCount = -1;
  let stableSince = Date.now();

  while (Date.now() - start < maxMs) {
    const requests = await page.networkRequests();
    const currentCount = requests.length;

    if (currentCount !== lastCount) {
      lastCount = currentCount;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMs) {
      return;
    }

    await page.waitFor(100);
  }
}

export async function stepNavigate(
  ctx: PipelineContext,
  config: NavigateConfig,
): Promise<PipelineContext> {
  const page = await acquirePage(ctx);
  const url = evalTemplate(config.url, ctx);
  const settleMs = config.settleMs ?? 0;

  await page.goto(url, { settleMs, waitUntil: config.waitUntil });

  if (config.waitUntil === "networkidle") {
    await waitForNetworkIdle(page, 5000, 500);
  }

  return { ...ctx, page };
}

export interface EvaluateConfig {
  expression: string;
}

export async function stepEvaluate(
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

export interface ClickConfig {
  selector?: string;
  x?: number;
  y?: number;
  quads?: boolean;
}

export async function stepClick(
  ctx: PipelineContext,
  config: ClickConfig | string,
): Promise<PipelineContext> {
  const page = await acquirePage(ctx);

  // String shorthand: just a CSS selector
  if (typeof config === "string") {
    const selector = evalTemplate(config, ctx);
    await page.click(selector);
    return { ...ctx, page };
  }

  // Coordinate-based click
  if (config.x !== undefined && config.y !== undefined) {
    await page.nativeClick(config.x, config.y);
    return { ...ctx, page };
  }

  // Selector-based click
  if (config.selector) {
    const selector = evalTemplate(config.selector, ctx);
    await page.click(selector);
    return { ...ctx, page };
  }

  throw new PipelineError(
    "click step requires either selector or x/y coordinates",
    {
      step: -1,
      action: "click",
      config,
      errorType: "expression_error",
      suggestion:
        'Provide either a CSS selector string, {selector: "..."}, or {x: N, y: N} for coordinate click.',
      retryable: false,
      alternatives: [],
    },
  );
}

export interface TypeConfig {
  text: string;
  selector?: string;
  submit?: boolean;
}

export async function stepType(
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

export interface WaitBrowserConfig {
  ms?: number;
  selector?: string;
  timeout?: number;
}

export async function stepWaitBrowser(
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

export interface InterceptConfig {
  trigger: string;
  capture: string;
  select?: string;
  timeout?: number;
  regex?: boolean;
  all?: boolean;
  captureText?: boolean;
}

export async function stepIntercept(
  ctx: PipelineContext,
  config: InterceptConfig,
): Promise<PipelineContext> {
  const page = await acquirePage(ctx);
  const capturePattern = evalTemplate(config.capture, ctx);
  const timeout = config.timeout ?? 10000;

  // Install interceptor: patch fetch + XHR to capture matching responses
  await page.evaluate(
    generateInterceptorJs(capturePattern, {
      regex: config.regex,
      captureAll: config.all,
      captureText: config.captureText,
    }),
  );

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
      type?: string;
    }>;
    if (arr.length > 0) {
      if (config.all) {
        captured = arr.map((item) => item.data);
      } else {
        captured = arr[arr.length - 1].data;
      }
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
        retryable: true,
        alternatives: [],
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

export async function stepPress(
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

export async function stepScroll(
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

export async function stepSnapshot(
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

export interface TapConfig {
  store: string;
  action: string;
  capture: string;
  timeout?: number;
  select?: string;
  framework?: "pinia" | "vuex" | "auto";
  args?: unknown[];
}

export async function stepTap(
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
      retryable: false,
      alternatives: [],
    });
  }
  if (!/^[a-zA-Z_$][\w$]*$/.test(actionName)) {
    throw new PipelineError(`Invalid action name: "${actionName}"`, {
      step: -1,
      action: "tap",
      config,
      errorType: "expression_error",
      suggestion: "Action name must be a valid JavaScript identifier.",
      retryable: false,
      alternatives: [],
    });
  }
  const framework = config.framework ?? "auto";
  const actionArgs = config.args
    ? config.args.map((a) => JSON.stringify(a)).join(", ")
    : "";

  const tap = generateTapInterceptorJs(capturePattern);

  // Build optional select chain (escape keys to prevent JS injection)
  const selectChain = config.select
    ? config.select
        .split(".")
        .map((k) => `?.[${JSON.stringify(k)}]`)
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

export interface DownloadStepConfig {
  url: string;
  dir?: string;
  filename?: string;
  concurrency?: number;
  skip_existing?: boolean;
  use_ytdlp?: boolean;
  type?: "auto" | "image" | "video" | "document";
  content?: string;
}

export async function stepDownload(
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

export async function stepWebsocket(
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

// --- Extract step ---

interface FieldDef {
  selector: string;
  type?: "text" | "number" | "html" | "attribute";
  attribute?: string;
  pattern?: string;
}

export interface ExtractConfig {
  from: string;
  fields: Record<string, FieldDef>;
}

export async function stepExtract(
  ctx: PipelineContext,
  config: ExtractConfig,
): Promise<PipelineContext> {
  const page = await acquirePage(ctx);
  const containerSelector = evalTemplate(config.from, ctx);

  // Build a JS expression that extracts structured data
  const fieldEntries = Object.entries(config.fields);
  const fieldJs = fieldEntries
    .map(([key, def]) => {
      const sel = JSON.stringify(def.selector);
      const attr = def.attribute ? JSON.stringify(def.attribute) : null;
      const pattern = def.pattern ? JSON.stringify(def.pattern) : null;
      const type = def.type ?? "text";

      if (type === "attribute" || attr) {
        return `${JSON.stringify(key)}: (() => { const el = item.querySelector(${sel}); return el ? el.getAttribute(${attr ?? JSON.stringify("href")}) : null; })()`;
      } else if (type === "number") {
        return `${JSON.stringify(key)}: (() => { const el = item.querySelector(${sel}); if (!el) return null; const txt = el.textContent || ''; ${pattern ? `const m = txt.match(new RegExp(${pattern})); return m ? parseFloat(m[0]) : null;` : `return parseFloat(txt.replace(/[^\\d.-]/g, '')) || null;`} })()`;
      } else if (type === "html") {
        return `${JSON.stringify(key)}: (() => { const el = item.querySelector(${sel}); return el ? el.innerHTML : null; })()`;
      } else {
        // text (default)
        if (pattern) {
          return `${JSON.stringify(key)}: (() => { const el = item.querySelector(${sel}); if (!el) return null; const txt = el.textContent || ''; const m = txt.match(new RegExp(${pattern})); return m ? (m[1] || m[0]) : txt.trim(); })()`;
        }
        return `${JSON.stringify(key)}: (() => { const el = item.querySelector(${sel}); return el ? el.textContent.trim() : null; })()`;
      }
    })
    .join(",\n      ");

  const extractJs = `
    JSON.stringify(
      Array.from(document.querySelectorAll(${JSON.stringify(containerSelector)})).map(item => ({
        ${fieldJs}
      }))
    )
  `;

  const resultStr = (await page.evaluate(extractJs)) as string;
  let data: unknown[];
  try {
    data = JSON.parse(resultStr) as unknown[];
  } catch {
    data = [];
  }

  return { ...ctx, data, page };
}

// Exported for unit testing — not part of public API
export { PIPE_FILTERS, evalExpression, buildScope };
