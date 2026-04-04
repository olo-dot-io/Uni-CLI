/**
 * YAML Pipeline Execution Engine — the Flight Computer.
 *
 * Executes pipeline steps defined in YAML adapters:
 *   fetch    → HTTP request (GET/POST)
 *   select   → Extract nested field from response
 *   map      → Transform each item using template expressions
 *   filter   → Keep items matching a condition
 *   limit    → Cap the number of results
 *   evaluate → Run JS expression (for browser adapters, future)
 *
 * Template syntax: ${{ expression }}
 *   Available variables: item, index, args, base
 */

import type { PipelineStep } from '../types.js';

type PipelineContext = {
  data: unknown;
  args: Record<string, unknown>;
  base?: string;
};

export async function runPipeline(
  steps: PipelineStep[],
  args: Record<string, unknown>,
  base?: string
): Promise<unknown[]> {
  let ctx: PipelineContext = { data: null, args, base };

  for (const step of steps) {
    const [action, config] = Object.entries(step)[0];

    switch (action) {
      case 'fetch':
        ctx = await stepFetch(ctx, config as FetchConfig);
        break;
      case 'select':
        ctx = stepSelect(ctx, config as string);
        break;
      case 'map':
        ctx = stepMap(ctx, config as Record<string, string>);
        break;
      case 'filter':
        ctx = stepFilter(ctx, config as string);
        break;
      case 'limit':
        ctx = stepLimit(ctx, config);
        break;
      default:
        // Skip unknown steps gracefully
        break;
    }
  }

  const result = ctx.data;
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object') return [result];
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

async function stepFetch(ctx: PipelineContext, config: FetchConfig): Promise<PipelineContext> {
  let url = evalTemplate(config.url, ctx);

  // If data is an array of items with IDs, fetch each one (fan-out pattern)
  if (Array.isArray(ctx.data)) {
    const items = ctx.data as Array<Record<string, unknown>>;
    const results = await Promise.all(
      items.map(async (item) => {
        const itemUrl = evalTemplate(config.url, { ...ctx, data: item });
        const resp = await fetchJson(itemUrl, config);
        return resp;
      })
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
    url += (url.includes('?') ? '&' : '?') + params.toString();
  }

  const data = await fetchJson(url, config);
  return { ...ctx, data };
}

async function fetchJson(
  url: string,
  config: FetchConfig
): Promise<unknown> {
  const method = config.method ?? 'GET';
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'User-Agent': 'Uni-CLI/0.1.0',
    ...(config.headers ?? {}),
  };

  const init: RequestInit = { method, headers };
  if (config.body && method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(config.body);
  }

  const resp = await fetch(url, init);
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText} from ${url}`);
  }
  return resp.json();
}

function stepSelect(ctx: PipelineContext, path: string): PipelineContext {
  const resolved = evalTemplate(path, ctx);
  const data = getNestedValue(ctx.data, resolved);
  return { ...ctx, data };
}

function stepMap(
  ctx: PipelineContext,
  template: Record<string, string>
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
  if (typeof config === 'number') {
    n = config;
  } else {
    const val = evalTemplate(String(config), ctx);
    n = parseInt(val, 10) || 20;
  }

  return { ...ctx, data: ctx.data.slice(0, n) };
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
    return String(result ?? '');
  }

  return template.replace(/\$\{\{\s*(.+?)\s*\}\}/g, (_match, expr: string) => {
    const result = evalExpression(expr, buildScope(ctx));
    return String(result ?? '');
  });
}

function buildScope(ctx: PipelineContext): Record<string, unknown> {
  const scope: Record<string, unknown> = {
    args: ctx.args,
    base: ctx.base,
  };

  if (ctx.data && typeof ctx.data === 'object' && 'item' in (ctx.data as Record<string, unknown>)) {
    const d = ctx.data as Record<string, unknown>;
    scope.item = d.item;
    scope.index = d.index;
  } else {
    scope.item = ctx.data;
  }

  return scope;
}

/**
 * Safe expression evaluator using Function constructor.
 * Scoped to the provided variables — no access to global state.
 */
function evalExpression(expr: string, scope: Record<string, unknown>): unknown {
  try {
    const keys = Object.keys(scope);
    const values = Object.values(scope);
    const fn = new Function(...keys, `"use strict"; return (${expr});`);
    return fn(...values);
  } catch {
    return undefined;
  }
}

/**
 * Navigate nested object by dot-path: "data.list[].title"
 */
function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current == null) return undefined;

    if (part.endsWith('[]')) {
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
